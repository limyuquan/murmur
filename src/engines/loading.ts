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
): Promise<E> {
  const tried = new Set<string>();
  let current: string | undefined = id;
  let lastError: unknown = null;
  while (current && !tried.has(current)) {
    tried.add(current);
    const engine = await create(current);
    try {
      await load(engine);
      return engine;
    } catch (err) {
      await engine.unload().catch(() => {});
      if (!isUnavailable(err)) throw err;
      console.warn('[earshot]', `${engine.info.label} can't run here:`, err.message);
      lastError = err;
      current = RUNTIME_FALLBACKS[current];
    }
  }
  throw lastError ?? new Error(`No engine called ${id}`);
}
