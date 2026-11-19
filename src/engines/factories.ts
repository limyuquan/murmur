/**
 * How to make each built-in engine. Only the offscreen document imports this: the service worker
 * and pages list engines from their static info (builtin.ts) and never load one, and bundling the
 * engines' code (and the speech model worker) into them would only add megabytes.
 */
import type { EngineFactories } from './builtin';
import { WHISPER_BASE_INFO, WHISPER_MODELS, WHISPER_TURBO_INFO } from './whisper/info';

export const ENGINE_FACTORIES: EngineFactories = {
  'chrome-webspeech': async () => new (await import('./chrome/webspeech')).WebSpeechAsrEngine(),
  'whisper-base': async () =>
    new (await import('./whisper/engine')).WhisperAsrEngine(
      WHISPER_BASE_INFO,
      WHISPER_MODELS['whisper-base'],
    ),
  'whisper-large-v3-turbo': async () =>
    new (await import('./whisper/engine')).WhisperAsrEngine(
      WHISPER_TURBO_INFO,
      WHISPER_MODELS['whisper-large-v3-turbo'],
    ),
  'chrome-translator': async () =>
    new (await import('./chrome/translator')).ChromeTranslatorEngine(),
  'demo-echo': async () => new (await import('./demo/echoAsr')).EchoAsrEngine(),
  'demo-needs-pack': async () => new (await import('./demo/testEngines')).NeedsPackAsrEngine(),
  'demo-stalled': async () => new (await import('./demo/testEngines')).StalledAsrEngine(),
  'demo-passthrough': async () =>
    new (await import('./demo/passthroughTranslator')).PassthroughTranslationEngine(),
};
