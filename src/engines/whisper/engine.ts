/**
 * Whisper in the browser: a thin proxy in the offscreen document over a dedicated worker (one
 * per loaded model, so `unload()` frees its memory by terminating it).
 *
 * A session buffers each speech segment, re-decodes the growing segment for partial results and
 * decodes it once more when it ends for the final (scheduler.ts decides when, so finals never wait
 * behind partials), and passes every decode through the hallucination guards (filters.ts). Every
 * result carries the language Whisper detected for that segment.
 */
import { primaryLanguage } from '@/pipeline/language';
import type {
  AsrEngine,
  AsrEngineInfo,
  AsrHealth,
  AsrResult,
  AsrSession,
  AsrSessionOptions,
  EngineState,
  LoadOptions,
} from '../types';
import { filterDecode, peakDb } from './filters';
import type { WhisperModel } from './info';
import type { DecodeOutput, FromWorker, ToWorker, WhisperDevice } from './messages';
import { DecodeScheduler, type SchedulerOptions } from './scheduler';

export class WhisperAsrEngine implements AsrEngine {
  private status: EngineState = 'unloaded';
  private worker: Worker | null = null;
  private loading: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve(o: DecodeOutput): void; reject(e: Error): void }
  >();
  /** What the model ended up running on. */
  device: WhisperDevice | null = null;

  constructor(
    readonly info: AsrEngineInfo,
    private readonly model: WhisperModel,
    private readonly schedulerOptions: SchedulerOptions = {},
  ) {}

  get state(): EngineState {
    return this.status;
  }

  load(options: LoadOptions = {}): Promise<void> {
    if (this.status === 'ready') return Promise.resolve();
    this.loading ??= this.start(options).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async start(options: LoadOptions): Promise<void> {
    this.status = 'loading';
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    const devices: Extract<ToWorker, { type: 'load' }>['devices'] = [];
    const gpu = options.hardware?.webgpu.available ?? true;
    if (this.model.webgpu && gpu)
      devices.push({ device: 'webgpu', dtype: this.model.webgpu.dtype });
    if (this.model.wasm) devices.push({ device: 'wasm', dtype: this.model.wasm.dtype });
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(options.signal?.reason ?? new Error('Loading was cancelled.'));
        options.signal?.addEventListener('abort', onAbort, { once: true });
        worker.onerror = (e) => reject(new Error(e.message || 'The speech model worker failed.'));
        worker.onmessage = (event: MessageEvent<FromWorker>) => {
          const m = event.data;
          if (m.type === 'progress') {
            options.onProgress?.({
              stage: m.stage,
              fraction: m.fraction,
              ...(m.file ? { file: m.file } : {}),
            });
          } else if (m.type === 'ready') {
            this.device = m.device;
            console.debug('[earshot]', this.info.id, 'ready on', m.device, m);
            resolve();
          } else if (m.type === 'error' && m.id === null) {
            reject(new Error(`Couldn't load ${this.info.label}: ${m.message}`));
          }
        };
        worker.postMessage({
          type: 'load',
          repo: this.model.repo,
          revision: this.model.revision,
          devices,
        } satisfies ToWorker);
      });
      worker.onmessage = (event: MessageEvent<FromWorker>) => this.onMessage(event.data);
      worker.onerror = (e) =>
        this.failAll(new Error(e.message || 'The speech model worker failed.'));
      this.status = 'ready';
    } catch (err) {
      worker.terminate();
      this.worker = null;
      this.status = 'error';
      throw err;
    }
  }

  async unload(): Promise<void> {
    this.worker?.terminate();
    this.worker = null;
    this.failAll(new Error('The speech model was unloaded.'));
    this.status = 'unloaded';
  }

  createSession(options: AsrSessionOptions): AsrSession {
    return new WhisperSession(this, options, this.schedulerOptions);
  }

  /** Decodes one stretch of audio (16 kHz mono). */
  decode(samples: Float32Array, languages: string[] | null): Promise<DecodeOutput> {
    const worker = this.worker;
    if (!worker || this.status !== 'ready') {
      return Promise.reject(new Error('The speech model is not loaded.'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ type: 'decode', id, samples, languages } satisfies ToWorker, [
        samples.buffer,
      ]);
    });
  }

  private onMessage(m: FromWorker): void {
    if (m.type === 'result') {
      this.pending.get(m.output.id)?.resolve(m.output);
      this.pending.delete(m.output.id);
    } else if (m.type === 'error' && m.id !== null) {
      this.pending.get(m.id)?.reject(new Error(m.message));
      this.pending.delete(m.id);
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

interface Buffered {
  startSample: number;
  chunks: { start: number; samples: Float32Array }[];
  endSample: number | null;
  /** The final result was sent: later partials are stale. */
  finished: boolean;
}

/** Whisper's language codes for the session's spoken languages, or null for any. */
export function whisperLanguages(spoken: readonly string[] | undefined): string[] | null {
  const codes = [...new Set((spoken ?? []).map(primaryLanguage).filter((l) => l && l !== 'und'))];
  return codes.length > 0 ? codes : null;
}

class WhisperSession implements AsrSession {
  private readonly scheduler: DecodeScheduler;
  private readonly segments = new Map<string, Buffered>();
  private readonly languages: string[] | null;
  private closed = false;
  private idle: (() => void) | null = null;
  private reported: AsrHealth | null = null;

  constructor(
    private readonly engine: WhisperAsrEngine,
    private readonly options: AsrSessionOptions,
    schedulerOptions: SchedulerOptions,
  ) {
    this.scheduler = new DecodeScheduler({ sampleRate: options.sampleRate, ...schedulerOptions });
    this.languages = whisperLanguages(options.spokenLanguages);
  }

  startSegment(segmentId: string, startSample: number): void {
    if (this.closed) return;
    this.segments.set(segmentId, { startSample, chunks: [], endSample: null, finished: false });
    this.scheduler.startSegment(segmentId, startSample);
    this.pump();
  }

  pushAudio(segmentId: string, samples: Float32Array, startSample: number): void {
    const seg = this.segments.get(segmentId);
    if (!seg || this.closed) return;
    seg.chunks.push({ start: startSample, samples });
    this.scheduler.audio(segmentId, startSample + samples.length);
    this.pump();
  }

  endSegment(segmentId: string, endSample: number): void {
    const seg = this.segments.get(segmentId);
    if (!seg) return;
    seg.endSample = endSample;
    for (const id of this.scheduler.endSegment(segmentId, endSample)) this.giveUp(id);
    this.pump();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (!this.scheduler.busy && this.scheduler.backlogSamples() === 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      this.idle = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private pump(): void {
    const job = this.scheduler.next();
    this.report();
    if (!job) {
      if (!this.scheduler.busy && this.scheduler.backlogSamples() === 0) this.idle?.();
      return;
    }
    const seg = this.segments.get(job.segmentId);
    if (!seg) {
      this.scheduler.done();
      this.pump();
      return;
    }
    const samples = slice(seg, job.startSample, job.endSample);
    const peak = peakDb(samples, this.options.sampleRate);
    this.engine
      .decode(samples, this.languages)
      .then((out) => {
        if (seg.finished) return;
        const filtered = filterDecode({
          text: out.text,
          language: out.language,
          noSpeechProb: out.noSpeechProb,
          avgLogprob: out.avgLogprob,
          peakDb: peak,
        });
        const final = job.kind === 'final';
        if (!final && filtered.dropped) return;
        const result: AsrResult = {
          segmentId: job.segmentId,
          final,
          text: filtered.text,
          language: filtered.text ? { tag: out.language, confidence: out.languageProb } : null,
          startSample: job.startSample,
          endSample: job.endSample,
        };
        if (final) this.finish(job.segmentId);
        this.options.onResult(result);
      })
      .catch((err: unknown) => {
        if (job.kind === 'final' && !seg.finished) {
          this.finish(job.segmentId);
          this.options.onResult(emptyFinal(job.segmentId, job.startSample, job.endSample));
        }
        this.options.onError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        this.scheduler.done();
        this.pump();
      });
  }

  /** A segment dropped to keep up: its one final, empty. */
  private giveUp(id: string): void {
    const seg = this.segments.get(id);
    if (!seg || seg.finished) return;
    this.finish(id);
    this.options.onResult(emptyFinal(id, seg.startSample, seg.endSample ?? seg.startSample));
  }

  private finish(id: string): void {
    const seg = this.segments.get(id);
    if (seg) seg.finished = true;
    this.segments.delete(id);
  }

  private report(): void {
    const health = this.scheduler.health();
    const last = this.reported;
    if (
      last &&
      last.behind === health.behind &&
      last.droppedSegments === health.droppedSegments &&
      Math.abs(last.backlogMs - health.backlogMs) < 1000
    ) {
      return;
    }
    this.reported = health;
    this.options.onHealth?.(health);
  }
}

function emptyFinal(segmentId: string, startSample: number, endSample: number): AsrResult {
  return { segmentId, final: true, text: '', language: null, startSample, endSample };
}

/** The segment's audio in [from, to), as one array. */
function slice(seg: Buffered, from: number, to: number): Float32Array {
  const out = new Float32Array(Math.max(0, to - from));
  for (const c of seg.chunks) {
    const s = Math.max(from, c.start);
    const e = Math.min(to, c.start + c.samples.length);
    if (e > s) out.set(c.samples.subarray(s - c.start, e - c.start), s - from);
  }
  return out;
}
