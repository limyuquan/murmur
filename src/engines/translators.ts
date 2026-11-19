/**
 * What the session wraps around its translator:
 *
 * - The glossary: a translator that uses one (`usesGlossary`) gets, with each line, the entries
 *   that line or its context uses (glossary.ts). The pipeline knows nothing of glossaries.
 * - A fallback per line (`LineFallbackTranslator`): a translator that may be slow or fail on a
 *   line (an LLM) gets a time budget for each finished line: 3 s for a live line, until shortly
 *   before it shows for a line made ahead of time (lookahead). If it fails, gives an answer it
 *   rejects itself, or takes longer than the budget, the backup (Chrome's translator) translates
 *   that line instead, and the session is told why. If it stops for good (its worker crashed),
 *   the backup translates every later line.
 *
 * Previews of unfinished lines get neither the budget nor the backup: a later preview or the
 * finished line replaces them anyway. Nor does a revision of the line before, which a finished
 * line's stream may carry after its own final chunk.
 */
import { isUnavailable } from './errors';
import { compileGlossary, type GlossaryEntry } from './glossary';
import type {
  EngineState,
  LoadOptions,
  TranslationChunk,
  TranslationEngine,
  TranslationRequest,
} from './types';

/** Longest a finished line may take before the backup translates it, ms. */
export const LINE_BUDGET_MS = 3000;
/** A line made ahead of time is translated this long before it is shown, at the latest, ms. */
export const LOOKAHEAD_MARGIN_MS = 1000;
/** Longest a line made ahead of time may take, however far ahead it is, ms. */
export const LOOKAHEAD_BUDGET_CAP_MS = 20_000;

/**
 * The time budget of a line made ahead of time that is shown in `untilMs` (Infinity: paused): up
 * to `LOOKAHEAD_MARGIN_MS` before it shows, at most `LOOKAHEAD_BUDGET_CAP_MS`, and never less than
 * a live line gets (a line due now is as late as a live one, and no later for waiting).
 */
export function lookaheadBudgetMs(untilMs: number): number {
  if (Number.isNaN(untilMs)) return LINE_BUDGET_MS;
  return Math.round(
    Math.max(LINE_BUDGET_MS, Math.min(LOOKAHEAD_BUDGET_CAP_MS, untilMs - LOOKAHEAD_MARGIN_MS)),
  );
}

/** Gives each request the glossary entries its line or context uses. */
export function withGlossary(
  engine: TranslationEngine,
  entries: readonly GlossaryEntry[],
): TranslationEngine {
  if (!engine.info.usesGlossary || entries.length === 0) return engine;
  const matcher = compileGlossary(entries);
  return {
    info: engine.info,
    get state() {
      return engine.state;
    },
    load: (options?: LoadOptions) => engine.load(options),
    unload: () => engine.unload(),
    translate(request: TranslationRequest) {
      if (request.source.kind !== 'text') return engine.translate(request);
      const texts = [request.source.text, ...request.context.map((c) => c.source)];
      return engine.translate({ ...request, glossary: matcher.hits(texts) });
    },
  };
}

export interface FallbackEvent {
  segmentId: string;
  /** Plain words, after the translator's name: "took longer than 3 s", "failed (…)". */
  reason: string;
  /** The primary translator stopped for good: the backup translates every later line. */
  permanent: boolean;
}

export interface LineFallbackOptions {
  /** Makes and loads the backup translator (once, when first needed). */
  backup: () => Promise<TranslationEngine>;
  /** For lines whose request names none. Default `LINE_BUDGET_MS`. */
  budgetMs?: number;
  onFallback?(event: FallbackEvent): void;
}

export class LineFallbackTranslator implements TranslationEngine {
  private backupEngine: Promise<TranslationEngine> | null = null;
  /** Why the primary translator can't be used any more. */
  private broken: string | null = null;

  constructor(
    private readonly primary: TranslationEngine,
    private readonly options: LineFallbackOptions,
  ) {}

  get info() {
    return this.primary.info;
  }

  get state(): EngineState {
    return this.primary.state;
  }

  load(options?: LoadOptions): Promise<void> {
    return this.primary.load(options);
  }

  async unload(): Promise<void> {
    const backup = this.backupEngine;
    this.backupEngine = null;
    await Promise.all([this.primary.unload(), backup?.then((b) => b.unload()).catch(() => {})]);
  }

  /** Starts loading the backup now, so the first line that needs it doesn't wait. */
  prepareBackup(): void {
    void this.backup().catch(() => {});
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationChunk> {
    if (this.broken) {
      yield* await this.viaBackup(request);
      return;
    }
    if (!request.sourceFinal) {
      yield* this.primary.translate(request);
      return;
    }
    const budget = request.budgetMs ?? this.options.budgetMs ?? LINE_BUDGET_MS;
    const timer = new AbortController();
    const signal = AbortSignal.any([request.signal, timer.signal]);
    const timeout = setTimeout(() => timer.abort(new Error('too slow')), budget);
    let reason: string;
    let permanent = false;
    let done = false;
    try {
      for await (const chunk of this.primary.translate({ ...request, signal })) {
        if (signal.aborted) break;
        if (done) {
          // After the line's own final, only revisions of the line before.
          if (chunk.revises) yield chunk;
          continue;
        }
        yield chunk;
        if (chunk.final && !chunk.revises) {
          // The line is done: no budget, nor backup, for what follows (a revision).
          done = true;
          clearTimeout(timeout);
          if (!request.previous) return;
        }
      }
      if (done) return;
      if (request.signal.aborted) return;
      reason = timer.signal.aborted
        ? `took longer than ${formatSeconds(budget)}`
        : 'gave no answer';
    } catch (err) {
      if (request.signal.aborted || done) return;
      if (timer.signal.aborted) {
        reason = `took longer than ${formatSeconds(budget)}`;
      } else {
        const message = err instanceof Error ? err.message : String(err);
        if (isUnavailable(err)) {
          permanent = true;
          reason = `stopped working (${message})`;
          this.broken = reason;
        } else if (err instanceof Error && err.name === 'LlmOutputError') {
          reason = message;
        } else {
          reason = `failed (${message})`;
        }
      }
    } finally {
      clearTimeout(timeout);
    }
    const chunks = await this.viaBackup(request);
    this.options.onFallback?.({ segmentId: request.segmentId, reason, permanent });
    yield* chunks;
  }

  private backup(): Promise<TranslationEngine> {
    this.backupEngine ??= this.options.backup();
    // A backup that failed to load may load next time (a pack arrived).
    this.backupEngine.catch(() => {
      this.backupEngine = null;
    });
    return this.backupEngine;
  }

  private async viaBackup(request: TranslationRequest): Promise<AsyncIterable<TranslationChunk>> {
    const backup = await this.backup();
    return backup.translate(request);
  }
}

function formatSeconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))} s`;
}

export interface SessionTranslatorOptions {
  glossary?: readonly GlossaryEntry[];
  /** The backup for each line, when the translator has one (profiles.ts `LINE_FALLBACKS`). */
  backup?: (() => Promise<TranslationEngine>) | null;
  budgetMs?: number;
  onFallback?(event: FallbackEvent): void;
}

/** The translator a session runs: `engine` with its glossary and, if it has one, its backup. */
export function sessionTranslator(
  engine: TranslationEngine,
  options: SessionTranslatorOptions,
): TranslationEngine {
  const translator = withGlossary(engine, options.glossary ?? []);
  if (!options.backup) return translator;
  const fallback = new LineFallbackTranslator(translator, {
    backup: options.backup,
    ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
    ...(options.onFallback ? { onFallback: options.onFallback } : {}),
  });
  fallback.prepareBackup();
  return fallback;
}
