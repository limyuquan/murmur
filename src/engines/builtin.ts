/**
 * The engines this build ships. Add an engine here (factory with static info; `create()` may
 * dynamic-import so its runtime loads only when chosen), then list its id in a profile
 * (profiles.ts) or pick it under Custom.
 */
import { ECHO_ASR_INFO, PASSTHROUGH_INFO } from './demo/info';
import { EngineRegistry } from './registry';

export function createBuiltinRegistry(): EngineRegistry {
  return new EngineRegistry()
    .registerAsr({
      info: ECHO_ASR_INFO,
      create: async () => new (await import('./demo/echoAsr')).EchoAsrEngine(),
    })
    .registerTranslation({
      info: PASSTHROUGH_INFO,
      create: async () =>
        new (await import('./demo/passthroughTranslator')).PassthroughTranslationEngine(),
    });
}
