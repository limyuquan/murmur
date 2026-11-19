/**
 * Whisper in the browser: a thin proxy in the offscreen document over a dedicated worker (one
 * per loaded model, so `unload()` frees its memory by terminating it).
 *
 * A session (segments.ts) buffers each speech segment, re-decodes the growing segment for partial
 * results and decodes it once more when it ends for the final (scheduler.ts decides when, so
 * finals never wait behind partials), and passes every decode through the hallucination guards
 * (filters.ts). Every result carries the language Whisper detected for that segment.
 */
import { isComplete } from '@/models/hub';
import { primaryLanguage } from '@/pipeline/language';
import { ModelError } from '../errors';
import { SegmentSession } from '../segments';
import type {
  AsrEngine,
  AsrEngineInfo,
  AsrSession,
  AsrSessionOptions,
  EngineState,
  LoadOptions,
} from '../types';
import type { WhisperModel } from './info';
import type { DecodeOutput, FromWorker, ToWorker, WhisperDevice } from './messages';
import type { SchedulerOptions } from './scheduler';

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
    // Any language unless the person said only theirs are spoken.
    const languages = options.onlySpoken ? whisperLanguages(options.spokenLanguages) : null;
    return new SegmentSession(
      { decode: (_job, samples) => this.decode(samples, languages) },
      options,
      this.schedulerOptions,
    );
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

/** Whisper's language codes for the session's spoken languages, or null for any. */
export function whisperLanguages(spoken: readonly string[] | undefined): string[] | null {
  const codes = [...new Set((spoken ?? []).map(primaryLanguage).filter((l) => l && l !== 'und'))];
  return codes.length > 0 ? codes : null;
}
