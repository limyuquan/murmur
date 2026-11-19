/**
 * The engines this build ships, by static info. Add an engine here, give it a factory in
 * factories.ts (dynamic-import so its runtime loads only when chosen), then list its id in a
 * profile (profiles.ts) or pick it under Custom. The demo engines exist in e2e builds only.
 *
 * Without `factories` (service worker, pages) the registry lists engines but can't create them;
 * the offscreen document passes `ENGINE_FACTORIES`.
 */
import { IS_E2E } from '@/shared/e2e';
import { CHROME_TRANSLATOR_INFO, CHROME_WEBSPEECH_INFO } from './chrome/info';
import {
  ECHO_ASR_INFO,
  NEEDS_PACK_ASR_INFO,
  PASSTHROUGH_INFO,
  STALLED_ASR_INFO,
} from './demo/info';
import { QWEN3_ASR_INFO } from './qwen3asr/info';
import { EngineRegistry } from './registry';
import type { AnyEngine, AsrEngine, TranslationEngine } from './types';
import { WHISPER_BASE_INFO, WHISPER_TURBO_INFO } from './whisper/info';

export type EngineFactories = Record<string, () => Promise<AnyEngine>>;

export function createBuiltinRegistry(factories: EngineFactories = {}): EngineRegistry {
  const make =
    <E extends AnyEngine>(id: string) =>
    async (): Promise<E> => {
      const factory = factories[id];
      if (!factory) throw new Error(`Engine ${id} can only be created in the offscreen document.`);
      return (await factory()) as E;
    };
  const registry = new EngineRegistry();
  for (const info of [
    CHROME_WEBSPEECH_INFO,
    WHISPER_BASE_INFO,
    WHISPER_TURBO_INFO,
    QWEN3_ASR_INFO,
  ]) {
    registry.registerAsr({ info, create: make<AsrEngine>(info.id) });
  }
  registry.registerTranslation({
    info: CHROME_TRANSLATOR_INFO,
    create: make<TranslationEngine>(CHROME_TRANSLATOR_INFO.id),
  });
  if (IS_E2E) {
    registry
      .registerAsr({ info: ECHO_ASR_INFO, create: make<AsrEngine>(ECHO_ASR_INFO.id) })
      .registerAsr({ info: NEEDS_PACK_ASR_INFO, create: make<AsrEngine>(NEEDS_PACK_ASR_INFO.id) })
      .registerAsr({ info: STALLED_ASR_INFO, create: make<AsrEngine>(STALLED_ASR_INFO.id) })
      .registerTranslation({
        info: PASSTHROUGH_INFO,
        create: make<TranslationEngine>(PASSTHROUGH_INFO.id),
      });
  }
  return registry;
}
