/**
 * The offscreen host and the speech detector: engines that take segments get the model (loaded
 * alongside them, released on stop); when it can't load, the session runs on the energy gate.
 * The demo echo engine stands in for such an engine here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '@/messaging/protocol';
import type { SileroVad } from '@/pipeline/silero';

vi.mock('@/capture/graph', () => ({
  startCapture: vi.fn(async () => ({ track: null, stop: async () => {} })),
}));
vi.mock('@/capture/sources', () => ({ tabAudioSource: () => ({}), toneSource: () => ({}) }));
vi.mock('@/engines/hardware', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/engines/hardware')>();
  return { ...original, detectHardware: async () => original.NO_HARDWARE };
});
vi.mock('@/engines/demo/info', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/engines/demo/info')>();
  return { ...original, ECHO_ASR_INFO: { ...original.ECHO_ASR_INFO, runtime: 'browser' } };
});
const pipelines = vi.hoisted(() => ({ vad: undefined as unknown }));
vi.mock('@/pipeline/pipeline', () => ({
  Pipeline: class {
    constructor(options: { vad: unknown }) {
      pipelines.vad = options.vad;
    }
    push() {}
    async close() {}
  },
}));
vi.mock('@/shared/e2e', () => ({ IS_E2E: true }));

const { OffscreenHost } = await import('@/offscreen/host');

const CONFIG: SessionConfig = {
  sessionId: 's1',
  tabId: 3,
  source: { kind: 'tone' },
  asrEngine: 'demo-echo',
  translationEngine: 'demo-passthrough',
  targetLanguage: 'en',
  sourceLanguage: null,
  translatePartials: false,
};

beforeEach(() => {
  pipelines.vad = undefined;
});

describe('OffscreenHost speech detector', () => {
  it('gives an engine that takes segments the model, and releases it on stop', async () => {
    const dispose = vi.fn(async () => {});
    const model = { cost: { frames: 0, ms: 0 }, dispose } as unknown as SileroVad;
    const seen: unknown[] = [];
    const host = new OffscreenHost({
      send: async () => {},
      loadVad: async () => model,
      onVad: (vad) => seen.push(vad),
    });
    await host.start(CONFIG);
    await host.loaded();
    expect(pipelines.vad).toBe(model);
    expect(seen).toEqual([model]);
    await host.stop();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('runs on the energy gate when the model fails to load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const statuses: string[] = [];
    const host = new OffscreenHost({
      send: async (event) => {
        statuses.push(event.status.state);
      },
      loadVad: async () => {
        throw new Error('no WebAssembly');
      },
    });
    await host.start(CONFIG);
    await host.loaded();
    expect(pipelines.vad).toBeNull();
    expect(statuses.at(-1)).toBe('running');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    await host.stop();
  });

  it('loads lookahead’s detector as soon as lookahead starts, not at its first job', async () => {
    const model = { cost: { frames: 0, ms: 0 }, dispose: async () => {} } as unknown as SileroVad;
    let loads = 0;
    const steps: string[] = [];
    const host = new OffscreenHost({
      send: async () => {},
      loadVad: async () => {
        loads++;
        return model;
      },
      onStartup: (step) => steps.push(step),
    });
    await host.start(CONFIG);
    const inner = host as unknown as {
      session: { lookahead: unknown; lookaheadVad: unknown };
      createLookahead(running: unknown): unknown;
    };
    // The page's tee spoke before the engines were ready.
    const before = loads;
    inner.session.lookahead = inner.createLookahead(inner.session);
    expect(loads).toBe(before + 1);
    await host.loaded();
    expect(inner.session.lookaheadVad).toBe(model);
    // The start-up steps, in order (e2e builds log when each was done).
    expect(steps).toEqual(['capture', 'asr', 'translation', 'pipeline']);
    await host.stop();
  });
});
