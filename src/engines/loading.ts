/**
 * Loading an engine, falling back when it can't run on this device at all (the API is missing,
 * Chrome can't promise on-device recognition): the profile chose it from what it could check in
 * the service worker, but some things only show when the engine loads in the offscreen document.
 * A translator may also give way when its model isn't downloaded or doesn't load
 * (`onModelError`): another one translates and the popup offers the download.
 */
import { isModelError, isUnavailable } from './errors';
import { MODEL_FALLBACKS, RUNTIME_FALLBACKS } from './profiles';
import type { AsrEngine, TranslationEngine } from './types';

export interface FallbackOptions {
  /**
   * Also falls back when a model isn't downloaded or doesn't load (`ModelError`), to its
   * `MODEL_FALLBACKS` entry, else its `RUNTIME_FALLBACKS` one (translators: the session starts
   * with another one and offers the download).
   */
  onModelError?: boolean;
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
      if (isUnavailable(err)) {
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
