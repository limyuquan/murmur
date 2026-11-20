/**
 * How to make the demo and test engines (e2e builds only). Builds in other modes load an empty
 * map in its place (`noDemoEngines` in wxt.config.ts), so none of this code ships.
 */
import type { EngineFactories } from '../builtin';

export const DEMO_FACTORIES: EngineFactories = {
  'demo-echo': async () => new (await import('./echoAsr')).EchoAsrEngine(),
  'demo-needs-pack': async () => new (await import('./testEngines')).NeedsPackAsrEngine(),
  'demo-stalled': async () => new (await import('./testEngines')).StalledAsrEngine(),
  'demo-passthrough': async () =>
    new (await import('./passthroughTranslator')).PassthroughTranslationEngine(),
};
