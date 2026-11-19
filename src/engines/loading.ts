/**
 * Loading an engine, falling back when it can't run on this device at all (the API is missing,
 * Chrome can't promise on-device recognition): the profile chose it from what it could check in
 * the service worker, but some things only show when the engine loads in the offscreen document.
 * A translator may also give way when its model isn't downloaded or doesn't load
 * (`onModelError`): another one translates and the popup offers the download.
 */
import { isModelError, isOutOfMemory, isUnavailable } from './errors';
import { type LadderStep, MEMORY_FALLBACKS, MODEL_FALLBACKS, RUNTIME_FALLBACKS } from './profiles';
import type { AsrEngine, TranslationEngine } from './types';

export interface FallbackOptions {
  /**
   * Also falls back when a model isn't downloaded or doesn't load (`ModelError`), to its
   * `MODEL_FALLBACKS` entry, else its `RUNTIME_FALLBACKS` one (translators: the session starts
   * with another one and offers the download).
   */
  onModelError?: boolean;
  /**
   * Also falls back when an engine runs out of memory (`OutOfMemoryError`), to its
   * `MEMORY_FALLBACKS` entry. Off, such a failure is thrown for a memory ladder to step down.
   */
  onOutOfMemory?: boolean;
  /** Told each time an engine gives way to the next one, and why. */
  onFallback?(id: string, error: Error): void;
}

export async function loadWithFallback<E extends AsrEngine | TranslationEngine>(
  id: string,
  create: (id: string) => Promise<E>,
  load: (engine: E) => Promise<void>,
  signal?: AbortSignal,
  options: FallbackOptions = {},
): Promise<E> {
  const tried = new Set<string>();
  let current: string | undefined = id;
  let lastError: unknown = null;
  while (current && !tried.has(current)) {
    signal?.throwIfAborted();
    tried.add(current);
    const engine = await create(current);
    try {
      // An engine that ignores the signal still lets a stop through.
      await untilAborted(load(engine), signal);
      return engine;
    } catch (err) {
      await engine.unload().catch(() => {});
      if (signal?.aborted) throw err;
      let next: string | undefined;
      if (isOutOfMemory(err)) {
        if (!options.onOutOfMemory) throw err;
        next = MEMORY_FALLBACKS[current];
        if (!next) throw err;
      } else if (isUnavailable(err)) {
        next = RUNTIME_FALLBACKS[current];
      } else if (options.onModelError && isModelError(err)) {
        next = MODEL_FALLBACKS[current] ?? RUNTIME_FALLBACKS[current];
        // Nothing to fall back to: the failure is the session's.
        if (!next) throw err;
      } else {
        throw err;
      }
      console.warn('[murmur]', `${engine.info.label} can't run here:`, err.message);
      options.onFallback?.(current, err);
      lastError = err;
      current = next;
    }
  }
  throw lastError ?? new Error(`No engine called ${id}`);
}

export interface LadderDeps<A extends AsrEngine, T extends TranslationEngine> {
  createAsr(id: string): Promise<A>;
  createTranslation(id: string): Promise<T>;
  loadAsr(engine: A): Promise<void>;
  loadTranslation(engine: T): Promise<void>;
  signal?: AbortSignal;
  /** Told when a translator gives way to another for a reason other than memory. */
  onTranslatorFallback?(id: string, error: Error): void;
  /**
   * Told on each step down, before the next step loads: the step it goes to (null: below the last
   * one), the engine that ran out of memory, and the error.
   */
  onStepDown?(next: LadderStep | null, failed: string, error: Error): void;
  /**
   * Graphics memory the speech engine lost while the translator loaded (its device was lost),
   * if any: the pair doesn't fit after all. Absent: not checked.
   */
  asrMemoryFailure?(engine: A): Error | null;
}

export interface LadderResult<A, T> {
  asr: A;
  translator: T;
  /** The step that loaded; null below the last one. */
  step: LadderStep | null;
  /** The engines that ran out of memory, in order. */
  failures: { engine: string; message: string }[];
}

/**
 * Loads a memory ladder's engines (profiles.ts `LADDERS`), speech recognition first: `steps`
 * runs from where the session starts. An engine that runs out of memory while loading or warming
 * up (`OutOfMemoryError`) is unloaded (its worker ends, freeing its memory) and the session steps
 * down: past every step with that speech engine when it was the speech engine (it doesn't fit
 * alone), else to the next step. Below the last step, `MEMORY_FALLBACKS` (Chrome's own engines).
 * Other failures fall back as they do without a ladder (`loadWithFallback`).
 */
export async function loadLadder<A extends AsrEngine, T extends TranslationEngine>(
  steps: readonly LadderStep[],
  deps: LadderDeps<A, T>,
): Promise<LadderResult<A, T>> {
  const { signal } = deps;
  const failures: LadderResult<A, T>['failures'] = [];
  const memoryFailed = (engine: string, err: Error) =>
    failures.push({ engine, message: err.message });
  const loadAsr = (id: string, onOutOfMemory: boolean) =>
    loadWithFallback(id, deps.createAsr, deps.loadAsr, signal, { onOutOfMemory });
  const loadTranslator = (id: string, onOutOfMemory: boolean) =>
    loadWithFallback(id, deps.createTranslation, deps.loadTranslation, signal, {
      onModelError: true,
      onOutOfMemory,
      ...(deps.onTranslatorFallback ? { onFallback: deps.onTranslatorFallback } : {}),
    });
  /** Below the last step: Chrome's engines, falling back as a custom choice would. */
  const below = async (asr: A | null, from: LadderStep): Promise<LadderResult<A, T>> => {
    const speech = asr ?? (await loadAsr(MEMORY_FALLBACKS[from.asr] ?? from.asr, true));
    try {
      const translator = await loadTranslator(
        MEMORY_FALLBACKS[from.translation] ?? from.translation,
        true,
      );
      return { asr: speech, translator, step: null, failures };
    } catch (err) {
      await speech.unload().catch(() => {});
      throw err;
    }
  };
  if (steps.length === 0) throw new Error('No engines to load.');
  let i = 0;
  let asr: A | null = null;
  /** The speech engine the loaded one was asked for (it may be a fallback). */
  let asrAsked: string | null = null;
  const dropAsr = async () => {
    await asr?.unload().catch(() => {});
    asr = null;
    asrAsked = null;
  };
  /** The step after `i` without the speech engine that ran out of memory alone. */
  const pastAsr = (i: number, ids: readonly string[]) => {
    for (let j = i + 1; j < steps.length; j++) {
      if (!ids.includes((steps[j] as LadderStep).asr)) return j;
    }
    return -1;
  };
  try {
    for (;;) {
      signal?.throwIfAborted();
      const step = steps[i] as LadderStep;
      if (!asr || (step.asr !== asrAsked && step.asr !== asr.info.id)) {
        await dropAsr();
        try {
          asr = await loadAsr(step.asr, false);
          asrAsked = step.asr;
        } catch (err) {
          if (!isOutOfMemory(err)) throw err;
          memoryFailed(step.asr, err);
          const j = pastAsr(i, [step.asr]);
          const next = j >= 0 ? (steps[j] as LadderStep) : null;
          deps.onStepDown?.(next, step.asr, err);
          if (!next) return await below(null, step);
          i = j;
          continue;
        }
      }
      const loaded = asr as A;
      let translator: T;
      try {
        translator = await loadTranslator(step.translation, false);
      } catch (err) {
        if (!isOutOfMemory(err)) throw err;
        memoryFailed(step.translation, err);
        const next = (steps[i + 1] as LadderStep | undefined) ?? null;
        deps.onStepDown?.(next, step.translation, err);
        if (!next) {
          asr = null;
          return await below(loaded, step);
        }
        i++;
        continue;
      }
      // The speech engine's graphics device may have gone while the translator loaded.
      const lost = deps.asrMemoryFailure?.(loaded) ?? null;
      if (lost) {
        await translator.unload().catch(() => {});
        memoryFailed(loaded.info.id, lost);
        const j = pastAsr(i, [step.asr, loaded.info.id]);
        const next = j >= 0 ? (steps[j] as LadderStep) : null;
        deps.onStepDown?.(next, loaded.info.id, lost);
        await dropAsr();
        if (!next) return await below(null, step);
        i = j;
        continue;
      }
      return { asr: loaded, translator, step, failures };
    }
  } catch (err) {
    await dropAsr();
    throw err;
  }
}

/** `work`, or a rejection with the signal's reason as soon as it aborts. */
export function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
