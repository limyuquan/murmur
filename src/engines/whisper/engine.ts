/**
 * Whisper in the browser: a thin proxy in the offscreen document over a dedicated worker (one
 * per loaded model, so `unload()` frees its memory by terminating it).
 *
 * A session buffers each speech segment, re-decodes the growing segment for partial results and
 * decodes it once more when it ends for the final (scheduler.ts decides when, so finals never wait
 * behind partials), and passes every decode through the hallucination guards (filters.ts). Every
 * result carries the language Whisper detected for that segment.
 */
import { isComplete } from '@/models/hub';
import { primaryLanguage } from '@/pipeline/language';
import { ModelError } from '../errors';
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
    let devices: Extract<ToWorker, { type: 'load' }>['devices'];
    try {
      devices = await this.downloadedDevices(options);
    } catch (err) {
      this.status = 'error';
      throw err;
    }
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(options.signal?.reason ?? new Error('Loading was cancelled.'));
        options.signal?.addEventListener('abort', onAbort, { once: true });
        worker.onerror = (e) =>
          reject(new ModelError(e.message || `${this.info.label} stopped while loading.`));
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
            console.debug('[murmur]', this.info.id, 'ready on', m.device, m);
            resolve();
          } else if (m.type === 'error' && m.id === null) {
            reject(
              new ModelError(
                `Couldn't load ${this.info.label}: ${m.message}`,
                devices.map((d) => `${this.model.id}-${d.device}`),
              ),
            );
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

  /**
   * The backends to try, in order, among those whose model is downloaded: WebGPU first when the
   * device has it, then WebAssembly. Never downloads; nothing downloaded is a `ModelError`.
   */
  private async downloadedDevices(
    options: LoadOptions,
  ): Promise<Extract<ToWorker, { type: 'load' }>['devices']> {
    const gpu = options.hardware?.webgpu.available ?? true;
    const candidates = [
      ...(this.model.webgpu && gpu ? [{ device: 'webgpu' as const, ...this.model.webgpu }] : []),
      ...(this.model.wasm ? [{ device: 'wasm' as const, ...this.model.wasm }] : []),
    ];
    const devices: Extract<ToWorker, { type: 'load' }>['devices'] = [];
    for (const c of candidates) {
      if (await isComplete(c.source)) {
        devices.push({ device: c.device, dtype: c.dtype, source: c.source });
      }
    }
    if (devices.length === 0) {
      throw new ModelError(
        `${this.info.label} isn’t downloaded yet. Download it in Settings, under Models.`,
        candidates.map((c) => `${this.model.id}-${c.device}`),
        true,
      );
    }
    return devices;
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
  /** Decode ms per audio ms of the last few finals. */
  private readonly factors: number[] = [];

  constructor(
    private readonly engine: WhisperAsrEngine,
    private readonly options: AsrSessionOptions,
    schedulerOptions: SchedulerOptions,
  ) {
    this.scheduler = new DecodeScheduler({ sampleRate: options.sampleRate, ...schedulerOptions });
    // Any language unless the person said only theirs are spoken.
    this.languages = options.onlySpoken ? whisperLanguages(options.spokenLanguages) : null;
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
        if (final) this.measure(out.ms, job.endSample - job.startSample);
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

  /** Records one final decode's real-time factor (short lines are dominated by fixed costs). */
  private measure(decodeMs: number, samples: number): void {
    const audioMs = (samples / this.options.sampleRate) * 1000;
    if (audioMs < 1000) return;
    this.factors.push(decodeMs / audioMs);
    if (this.factors.length > RTF_WINDOW) this.factors.shift();
  }

  private rtf(): number | null {
    if (this.factors.length === 0) return null;
    const sorted = [...this.factors].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? null;
  }

  private report(): void {
    const health = { ...this.scheduler.health(), rtf: this.rtf() };
    const last = this.reported;
    if (
      last &&
      last.behind === health.behind &&
      last.droppedSegments === health.droppedSegments &&
      Math.abs(last.backlogMs - health.backlogMs) < 1000 &&
      Math.abs((last.rtf ?? 0) - (health.rtf ?? 0)) < 0.1
    ) {
      return;
    }
    this.reported = health;
    this.options.onHealth?.(health);
  }
}

/** Finals the real-time factor is the median of. */
const RTF_WINDOW = 5;

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
