/**
 * Qwen3-ASR in the browser: a thin proxy in the offscreen document over a dedicated worker (one
 * per loaded model, so `unload()` frees its GPU memory by terminating it). Sessions are the
 * segment sessions Whisper uses (segments.ts: scheduler, partials, hallucination guards).
 *
 * - Language: detected per segment (never one for the stream), among the spoken languages when
 *   the person said only those are spoken. The session's language hint is not forced.
 * - A final (or probe) heard as the target language, shown untranslated, is decoded again in the
 *   speaker's own language, and that answer kept when the model is surer of it (`keepSecond`,
 *   prompt.ts): a speaker mixing a few target-language words into their own language is often
 *   heard as the target language, the rest written as sound-alikes.
 * - No speech: the model answers `language None`; its probability is the no-speech signal the
 *   guards use, with the text's mean log-probability.
 * - Partials: a re-decode of the growing segment about every 1.5 s. Each one forces the last
 *   partial's answer minus its last few tokens (`rollbackPrefix`), so only the tail is decoded
 *   again. Finals, and probes (the segmenter asking about a pause), decode from scratch.
 */

import { isComplete } from '@/models/hub';
import { DecodeQueue } from '../decodequeue';
import {
  EngineUnavailableError,
  looksLikeOutOfMemory,
  ModelError,
  OutOfMemoryError,
} from '../errors';
import { type SegmentDecode, SegmentSession } from '../segments';
import type {
  AsrEngine,
  AsrEngineInfo,
  AsrSession,
  AsrSessionOptions,
  EngineState,
  LoadOptions,
} from '../types';
import type { DecodeJob, SchedulerOptions } from '../whisper/scheduler';
import type { Qwen3Model } from './info';
import type { DecodeOutput, FromWorker, ToWorker } from './messages';
import { keepSecond, languageIds, modelLanguages, otherLanguage, rollbackPrefix } from './prompt';

export interface Qwen3Options {
  scheduler?: SchedulerOptions;
  /**
   * Tokens of the last partial's text decoded again by the next partial (they may change with
   * more audio); null decodes every partial from scratch.
   */
  rollback?: number | null;
}

export const QWEN3_DEFAULTS = {
  scheduler: { partialIntervalMs: 1500, firstPartialMs: 1000 },
  rollback: 5,
} satisfies Qwen3Options;

/** One decode, for real-model checks (e2e builds log these). */
export interface DecodeRecord {
  kind: DecodeJob['kind'];
  segmentId: string;
  audioMs: number;
  ms: number;
  tokens: number;
  prefixTokens: number;
  /** Stopped on a repetition loop. */
  looped: boolean;
  language: string;
  noSpeechProb: number;
  avgLogprob: number;
  text: string;
}

export class Qwen3AsrEngine implements AsrEngine {
  private status: EngineState = 'unloaded';
  private worker: Worker | null = null;
  /** The graphics device ran out of memory or was lost after loading. */
  private lostMemory: OutOfMemoryError | null = null;
  private loading: Promise<void> | null = null;
  private nextId = 1;
  /** Live decodes before lookahead's on the one worker (decodequeue.ts). */
  private readonly queue = new DecodeQueue();
  private readonly pending = new Map<
    number,
    { resolve(o: DecodeOutput): void; reject(e: Error): void }
  >();
  private readonly options: Required<Qwen3Options>;
  /** Set by the offscreen document in e2e builds. */
  onDecode: ((record: DecodeRecord) => void) | null = null;

  constructor(
    readonly info: AsrEngineInfo,
    /** Which size: its files and width. */
    private readonly model: Qwen3Model,
    options: Qwen3Options = {},
  ) {
    this.options = {
      scheduler: { ...QWEN3_DEFAULTS.scheduler, ...options.scheduler },
      rollback: options.rollback === undefined ? QWEN3_DEFAULTS.rollback : options.rollback,
    };
  }

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
    try {
      if (this.info.unavailable) {
        throw new EngineUnavailableError(`${this.info.label}: ${this.info.unavailable}.`);
      }
      if (!(await isComplete(this.model.source))) {
        throw new ModelError(
          `${this.info.label} isn’t downloaded yet. Download it in Settings, under Models.`,
          [this.model.modelId],
          true,
        );
      }
    } catch (err) {
      this.status = 'error';
      throw err;
    }
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    this.lostMemory = null;
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(options.signal?.reason ?? new Error('Loading was cancelled.'));
        options.signal?.addEventListener('abort', onAbort, { once: true });
        worker.onerror = (e) => {
          const message = e.message || `${this.info.label} stopped while loading.`;
          // A worker that dies allocating (WebAssembly memory) ran out of memory too.
          reject(
            looksLikeOutOfMemory(message)
              ? new OutOfMemoryError(`${this.info.label}: ${message}`)
              : new ModelError(message),
          );
        };
        worker.onmessage = (event: MessageEvent<FromWorker>) => {
          const m = event.data;
          if (m.type === 'progress') {
            options.onProgress?.({
              stage: m.stage,
              fraction: m.fraction,
              ...(m.file ? { file: m.file } : {}),
            });
          } else if (m.type === 'ready') {
            console.debug('[murmur]', this.info.id, 'ready', m);
            resolve();
          } else if (m.type === 'error' && m.id === null) {
            reject(
              m.memory
                ? new OutOfMemoryError(`${this.info.label}: ${m.message}`)
                : m.unavailable
                  ? new EngineUnavailableError(m.message)
                  : new ModelError(`Couldn't load ${this.info.label}: ${m.message}`, [
                      this.model.modelId,
                    ]),
            );
          }
        };
        worker.postMessage({
          type: 'load',
          model: this.model,
          ...(options.simulateOutOfMemory
            ? { simulateOutOfMemory: options.simulateOutOfMemory }
            : {}),
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

  memoryFailure(): Error | null {
    return this.lostMemory;
  }

  async unload(): Promise<void> {
    this.worker?.terminate();
    this.worker = null;
    this.failAll(new Error('The speech model was unloaded.'));
    this.status = 'unloaded';
  }

  createSession(options: AsrSessionOptions): AsrSession {
    // Any language unless the person said only theirs are spoken.
    const spoken = options.onlySpoken ? modelLanguages(options.spokenLanguages ?? []) : [];
    const languages = spoken.length > 0 ? spoken : null;
    // The second opinion on finals heard as the target language: in the first spoken language
    // that isn't the target, or else the language most of the session's finals were heard in.
    const target = options.targetLanguage ? modelLanguages([options.targetLanguage])[0] : undefined;
    const named = modelLanguages(options.spokenLanguages ?? []);
    const heard = new Map<string, number>();
    /** Each open segment's last partial answer, and its language probability. */
    const partials = new Map<string, { ids: number[]; languageProb: number }>();
    const rollback = this.options.rollback;
    return new SegmentSession(
      {
        decode: async (job: DecodeJob, samples: Float32Array): Promise<SegmentDecode> => {
          const last = job.kind === 'partial' ? partials.get(job.segmentId) : undefined;
          const prefix = last && rollback !== null ? rollbackPrefix(last.ids, rollback) : null;
          // Measured now: decoding hands the samples' buffer to the worker.
          const audioMs = Math.round((samples.length / options.sampleRate) * 1000);
          const lane = options.batch ? 'batch' : 'live';
          // Finals and probes (a probe can stand in for its segment's final), not partials.
          const other =
            job.kind !== 'partial' && target
              ? otherLanguage(target, named, heard, languages)
              : null;
          // Kept for a second decode: the first hands its buffer to the worker.
          const again = other ? samples.slice() : null;
          let out = await this.queue.run(lane, () => this.decode(samples, languages, prefix));
          // A language forced by the prefix keeps the probability it was chosen with.
          let languageProb = prefix && last ? last.languageProb : out.languageProb;
          this.record(job, audioMs, prefix, out);
          if (other && again && out.language === target && out.text) {
            const second = await this.queue.run(lane, () =>
              this.decode(again, null, languageIds(other)),
            );
            this.record(job, audioMs, null, second);
            if (keepSecond(out, second)) {
              // The first decode's no-speech chance: the forced one never weighs it.
              out = { ...second, noSpeechProb: out.noSpeechProb, ms: out.ms + second.ms };
              languageProb = second.languageProb;
            }
          }
          if (job.kind === 'final' && out.text) {
            heard.set(out.language, (heard.get(out.language) ?? 0) + 1);
          }
          // A probe (decoded in full) is as good a base for the next partial.
          if (job.kind !== 'final' && out.text) {
            partials.set(job.segmentId, { ids: out.ids, languageProb });
          }
          return {
            text: out.text,
            language: out.language,
            languageProb,
            noSpeechProb: out.noSpeechProb,
            avgLogprob: out.avgLogprob,
            ms: out.ms,
          };
        },
        forget: (segmentId) => partials.delete(segmentId),
      },
      options,
      this.options.scheduler,
    );
  }

  /** Reports one decode (e2e builds). */
  private record(
    job: DecodeJob,
    audioMs: number,
    prefix: number[] | null,
    out: DecodeOutput,
  ): void {
    this.onDecode?.({
      kind: job.kind,
      segmentId: job.segmentId,
      audioMs,
      ms: out.ms,
      tokens: out.tokens,
      prefixTokens: prefix?.length ?? 0,
      looped: out.looped,
      language: out.language,
      noSpeechProb: out.noSpeechProb,
      avgLogprob: out.avgLogprob,
      text: out.text,
    });
  }

  /** Decodes one stretch of audio (16 kHz mono). */
  decode(
    samples: Float32Array,
    languages: string[] | null,
    prefix: number[] | null,
  ): Promise<DecodeOutput> {
    const worker = this.worker;
    if (!worker || this.status !== 'ready') {
      return Promise.reject(new Error('The speech model is not loaded.'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ type: 'decode', id, samples, languages, prefix } satisfies ToWorker, [
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
    } else if (m.type === 'error' && m.memory) {
      this.lostMemory ??= new OutOfMemoryError(`${this.info.label}: ${m.message}`);
      console.warn('[murmur]', this.info.id, 'graphics memory failure after loading', m.message);
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
