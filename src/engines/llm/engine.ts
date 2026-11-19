/**
 * The LLM translation engine (Gemma 4 on LiteRT-LM.js): a thin proxy in the offscreen document
 * over a dedicated worker. Unloading terminates the worker, the only way to give the model's
 * graphics memory back.
 *
 * - One generation at a time. A finished line goes before queued previews of unfinished ones
 *   (`sourceFinal: false`) and stops a preview that is running.
 * - Each line's prompt (prompt.ts) has its language as the speech engine heard it, the earlier
 *   lines it was given with their languages, the glossary entries it needs and the session's
 *   languages. Every line is translated, whatever its language.
 * - The answer streams: a growing draft (`final: false`) as tokens come, then the cleaned final
 *   one. An answer that repeats an earlier line or runs away is rejected with `LlmOutputError`,
 *   so the session can have another translator do that line (translators.ts).
 */
import { isComplete } from '@/models/hub';
import { EngineUnavailableError, ModelError } from '../errors';
import type {
  EngineState,
  LanguageTag,
  LoadOptions,
  TranslationChunk,
  TranslationEngine,
  TranslationEngineInfo,
  TranslationRequest,
} from '../types';
import { LLM_SOURCES, type LlmEngineId, llmModelId, modelFile } from './info';
import type { FromWorker, GenerationStats, ToWorker } from './messages';
import { checkOutput, cleanOutput } from './output';
import {
  buildPrompt,
  fitPrompt,
  languageName,
  maxOutputTokens,
  type Prompt,
  type PromptFlags,
} from './prompt';

/** Prompt and answer together, at most (the size the engine is created with, as measured). */
export const MAX_NUM_TOKENS = 1024;
/** Kept free of the prompt for the chat template's own tokens. */
const TEMPLATE_TOKENS = 32;
/** Least time between two drafts of the same line, ms. */
export const DRAFT_INTERVAL_MS = 50;
/** A cancelled generation that doesn't stop within this long means the worker hangs. */
export const CANCEL_TIMEOUT_MS = 5000;

/**
 * An answer the engine doesn't trust (the line should go to another translator). The message
 * finishes "<engine> …": "repeated an earlier line".
 */
export class LlmOutputError extends Error {
  override readonly name = 'LlmOutputError';
  constructor(
    readonly reason: 'echo' | 'length',
    message: string,
  ) {
    super(message);
  }
}

export interface WorkerLike {
  postMessage(message: ToWorker): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface LlmEngineOptions {
  /** Starts the worker (tests pass a fake). */
  createWorker?: () => WorkerLike;
  /** Whether the model is in the model cache. */
  isDownloaded?: () => Promise<boolean>;
  /** The extension's folder with LiteRT-LM's WebAssembly. */
  wasmBase?: string;
  flags?: PromptFlags;
  draftIntervalMs?: number;
  cancelTimeoutMs?: number;
}

/** One generation, for real-model checks (e2e builds log these). */
export interface GenerationRecord {
  segmentId: string;
  final: boolean;
  /** Queued until the worker started it, ms. */
  waitMs: number;
  stats: GenerationStats;
  cancelled: boolean;
  raw: string;
  text: string;
  /** Why the answer was rejected, if it was. */
  rejected?: string;
}

type JobEvent =
  | { type: 'token' }
  | { type: 'done'; text: string; cancelled: boolean; stats: GenerationStats }
  | { type: 'error'; error: Error };

interface Job {
  id: number;
  segmentId: string;
  final: boolean;
  prompt: Prompt;
  maxTokens: number;
  raw: string;
  tokens: number;
  queuedAt: number;
  startedAt: number | null;
  /** Events not yet taken, and the taker waiting for one. */
  events: JobEvent[];
  wake: (() => void) | null;
  /** The worker said it's done (or failed): the next job may start. */
  settled: boolean;
  /** Asked to stop (aborted, or pre-empted by a finished line). */
  stopping: boolean;
}

export class LlmTranslationEngine implements TranslationEngine {
  private status: EngineState = 'unloaded';
  private worker: WorkerLike | null = null;
  private loading: Promise<void> | null = null;
  private nextId = 1;
  private queue: Job[] = [];
  private active: Job | null = null;
  private session: LoadOptions['session'] | undefined;
  /** Why the worker can't be used any more (it crashed or hangs). */
  private broken: Error | null = null;
  private readonly draftIntervalMs: number;
  private readonly cancelTimeoutMs: number;
  /** Set by the offscreen document in e2e builds. */
  onGeneration: ((record: GenerationRecord) => void) | null = null;

  constructor(
    readonly info: TranslationEngineInfo,
    private readonly id: LlmEngineId,
    private readonly options: LlmEngineOptions = {},
  ) {
    this.draftIntervalMs = options.draftIntervalMs ?? DRAFT_INTERVAL_MS;
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? CANCEL_TIMEOUT_MS;
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
    this.session = options.session;
    this.broken = null;
    const source = LLM_SOURCES[this.id];
    try {
      if (this.info.unavailable) {
        throw new EngineUnavailableError(`${this.info.label}: ${this.info.unavailable}.`);
      }
      const downloaded = await (this.options.isDownloaded?.() ?? isComplete(source));
      if (!downloaded) {
        throw new ModelError(
          `${this.info.label} isn’t downloaded yet. Download it in Settings, under Models.`,
          [llmModelId(this.id)],
          true,
        );
      }
    } catch (err) {
      this.status = 'error';
      throw err;
    }
    const worker = this.options.createWorker?.() ?? spawnWorker();
    this.worker = worker;
    const warmup = buildPrompt({
      text: 'Hello, nice to meet you.',
      sourceLanguage: 'en',
      targetLanguage: options.session?.targetLanguage ?? 'en',
      context: [],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(options.signal?.reason ?? new Error('Loading was cancelled.'));
        if (options.signal?.aborted) return onAbort();
        options.signal?.addEventListener('abort', onAbort, { once: true });
        worker.onerror = (e) =>
          reject(
            new EngineUnavailableError(e.message || `${this.info.label} stopped while loading.`),
          );
        worker.onmessage = (event) => {
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
              m.unavailable
                ? new EngineUnavailableError(m.message)
                : new ModelError(`Couldn't load ${this.info.label}: ${m.message}`, [
                    llmModelId(this.id),
                  ]),
            );
          }
        };
        worker.postMessage({
          type: 'load',
          source,
          file: modelFile(this.id).path,
          wasmBase: this.options.wasmBase ?? defaultWasmBase(),
          maxNumTokens: MAX_NUM_TOKENS,
          warmup,
        });
      });
      worker.onmessage = (event) => this.onMessage(event.data);
      worker.onerror = (e) =>
        this.fail(new EngineUnavailableError(e.message || `${this.info.label} stopped.`));
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
    this.fail(new Error(`${this.info.label} was unloaded.`), false);
    this.status = 'unloaded';
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationChunk> {
    if (request.source.kind !== 'text') throw new Error(`${this.info.label} translates text only.`);
    if (this.broken) throw this.broken;
    if (!this.worker || this.status !== 'ready') {
      throw new Error(`${this.info.label} is not loaded.`);
    }
    request.signal.throwIfAborted();
    const text = request.source.text.trim();
    if (!text) {
      yield { text: '', final: true };
      return;
    }
    const maxTokens = maxOutputTokens(text);
    const language: LanguageTag | null = request.source.language;
    const prompt = fitPrompt(
      {
        text,
        sourceLanguage: language,
        targetLanguage: request.target,
        context: request.context,
        glossary: request.glossary ?? [],
        spokenLanguages: this.session?.spokenLanguages ?? [],
        ...(request.source.mixed ? { mixed: request.source.mixed } : {}),
        ...(this.options.flags ? { flags: this.options.flags } : {}),
      },
      MAX_NUM_TOKENS - maxTokens - TEMPLATE_TOKENS,
    );
    const job = this.enqueue(request.segmentId, request.sourceFinal, prompt, maxTokens);
    const onAbort = () => this.stop(job);
    request.signal.addEventListener('abort', onAbort, { once: true });
    const labels = [languageName(request.target)];
    let draft = '';
    let draftAt = 0;
    try {
      for (;;) {
        const event = await this.next(job, request.signal);
        if (!event) return;
        if (event.type === 'error') throw event.error;
        if (event.type === 'token') {
          const now = performance.now();
          if (now - draftAt < this.draftIntervalMs) continue;
          const next = cleanOutput(job.raw, { labels }, true);
          if (next && next !== draft) {
            draft = next;
            draftAt = now;
            yield { text: draft, final: false };
          }
          continue;
        }
        if (event.cancelled) return;
        const out = cleanOutput(event.text, { labels });
        const decoded = Math.max(event.stats.outputTokens ?? 0, job.tokens);
        const check = checkOutput(out, {
          source: text,
          context: request.context,
          hitLimit: decoded >= maxTokens,
        });
        this.record(job, event, out, check.ok ? undefined : check.detail);
        if (!check.ok) throw new LlmOutputError(check.reason, check.detail);
        yield { text: out, final: true };
        return;
      }
    } finally {
      request.signal.removeEventListener('abort', onAbort);
      // The consumer stopped early: stop the generation too.
      if (!job.settled) this.stop(job);
    }
  }

  private enqueue(segmentId: string, final: boolean, prompt: Prompt, maxTokens: number): Job {
    const job: Job = {
      id: this.nextId++,
      segmentId,
      final,
      prompt,
      maxTokens,
      raw: '',
      tokens: 0,
      queuedAt: performance.now(),
      startedAt: null,
      events: [],
      wake: null,
      settled: false,
      stopping: false,
    };
    if (final) {
      // Before any queued preview, after the finished lines already waiting.
      const at = this.queue.findIndex((j) => !j.final);
      this.queue.splice(at < 0 ? this.queue.length : at, 0, job);
      if (this.active && !this.active.final) this.stop(this.active);
    } else {
      this.queue.push(job);
    }
    this.pump();
    return job;
  }

  /** Starts the next queued job when none runs. */
  private pump(): void {
    if (this.active || !this.worker) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    job.startedAt = performance.now();
    this.worker.postMessage({
      type: 'generate',
      id: job.id,
      system: job.prompt.system,
      user: job.prompt.user,
      maxTokens: job.maxTokens,
    });
  }

  /** Stops `job`: dropped when queued, cancelled in the worker when running. */
  private stop(job: Job): void {
    if (job.stopping || job.settled) return;
    job.stopping = true;
    const queued = this.queue.indexOf(job);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      this.settle(job, { type: 'done', text: '', cancelled: true, stats: emptyStats() });
      return;
    }
    if (this.active !== job) return;
    this.worker?.postMessage({ type: 'cancel', id: job.id });
    // A worker that doesn't answer a cancel hangs (a stalled graphics card): give it up.
    setTimeout(() => {
      if (this.active === job && !job.settled) {
        this.fail(new EngineUnavailableError(`${this.info.label} stopped answering.`));
      }
    }, this.cancelTimeoutMs);
  }

  /** The job's next event; null once the request is aborted. */
  private async next(job: Job, signal: AbortSignal): Promise<JobEvent | null> {
    for (;;) {
      if (signal.aborted) return null;
      const event = job.events.shift();
      if (event) return event;
      await new Promise<void>((resolve) => {
        job.wake = resolve;
        // Don't wait for the worker to confirm a cancel: the line has moved on.
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      job.wake = null;
    }
  }

  private push(job: Job, event: JobEvent): void {
    job.events.push(event);
    job.wake?.();
  }

  private settle(job: Job, event: JobEvent): void {
    if (job.settled) return;
    job.settled = true;
    this.push(job, event);
    if (this.active === job) {
      this.active = null;
      this.pump();
    }
  }

  private onMessage(m: FromWorker): void {
    const job = 'id' in m && this.active?.id === m.id ? this.active : null;
    if (m.type === 'token' && job) {
      job.raw += m.text;
      job.tokens++;
      this.push(job, { type: 'token' });
    } else if (m.type === 'done' && job) {
      this.settle(job, { type: 'done', text: m.text, cancelled: m.cancelled, stats: m.stats });
    } else if (m.type === 'error') {
      if (m.id === null) this.fail(new EngineUnavailableError(m.message));
      else if (job) this.settle(job, { type: 'error', error: new Error(m.message) });
    }
  }

  /** Fails every job; `broken`: the engine can't be used again until reloaded. */
  private fail(err: Error, broken = true): void {
    if (broken) {
      this.broken = err;
      this.status = 'error';
      this.worker?.terminate();
      this.worker = null;
    }
    const jobs = [...(this.active ? [this.active] : []), ...this.queue];
    this.active = null;
    this.queue = [];
    for (const job of jobs) this.settle(job, { type: 'error', error: err });
  }

  private record(
    job: Job,
    event: Extract<JobEvent, { type: 'done' }>,
    text: string,
    rejected?: string,
  ) {
    this.onGeneration?.({
      segmentId: job.segmentId,
      final: job.final,
      waitMs: Math.round((job.startedAt ?? job.queuedAt) - job.queuedAt),
      stats: event.stats,
      cancelled: event.cancelled,
      raw: event.text,
      text,
      ...(rejected ? { rejected } : {}),
    });
  }
}

function emptyStats(): GenerationStats {
  return { firstTokenMs: null, totalMs: 0, promptTokens: null, outputTokens: null };
}

/** Where the extension keeps LiteRT-LM's WebAssembly (copied there at build time). */
function defaultWasmBase(): string {
  return new URL('/litert/', self.location.href).href;
}

function spawnWorker(): WorkerLike {
  // A classic worker, built from entrypoints/llm-worker.ts.
  return new Worker(new URL('/llm-worker.js', self.location.href)) as unknown as WorkerLike;
}
