/**
 * Loading an engine, falling back when it can't run on this device at all (the API is missing,
 * Chrome can't promise on-device recognition): the profile chose it from what it could check in
 * the service worker, but some things only show when the engine loads in the offscreen document.
 */
import { isUnavailable } from './errors';
import { RUNTIME_FALLBACKS } from './profiles';
import type { AsrEngine, TranslationEngine } from './types';

export async function loadWithFallback<E extends AsrEngine | TranslationEngine>(
  id: string,
  create: (id: string) => Promise<E>,
  load: (engine: E) => Promise<void>,
  signal?: AbortSignal,
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
      if (signal?.aborted || !isUnavailable(err)) throw err;
      console.warn('[murmur]', `${engine.info.label} can't run here:`, err.message);
      lastError = err;
      current = RUNTIME_FALLBACKS[current];
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
