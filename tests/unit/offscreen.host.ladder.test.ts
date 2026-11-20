/**
 * The offscreen host on a memory ladder: an engine that runs out of graphics memory (here, as e2e
 * checks simulate it) steps the session down, the service worker hears which step to start at
 * next time, and the running status says smaller models run.
 */
import { describe, expect, it, vi } from 'vitest';
import { OutOfMemoryError } from '@/engines/errors';
import type { LoadOptions } from '@/engines/types';
import type { ActiveSessionStatus, OffscreenEvent, SessionConfig } from '@/messaging/protocol';
import type { Cue } from '@/pipeline/types';

vi.mock('@/capture/graph', () => ({
  startCapture: vi.fn(async () => ({ track: null, stop: async () => {} })),
}));
vi.mock('@/capture/sources', () => ({ tabAudioSource: () => ({}), toneSource: () => ({}) }));
vi.mock('@/engines/hardware', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/engines/hardware')>();
  return { ...original, detectHardware: async () => original.NO_HARDWARE };
});
const pipelines = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock('@/pipeline/pipeline', () => ({
  Pipeline: class {
    constructor(options: Record<string, unknown>) {
      pipelines.last = options;
    }
    push() {}
    async close() {}
  },
}));
vi.mock('@/shared/e2e', () => ({ IS_E2E: true }));
const loads = vi.hoisted(() => ({ log: [] as string[] }));
// Every real engine id, as a fake that fails as the load options simulate.
vi.mock('@/engines/factories', async () => {
  const { createBuiltinRegistry } = await import('@/engines/builtin');
  const registry = createBuiltinRegistry();
  const fake = (info: { id: string; label: string; kind: string }) => async () => ({
    info,
    state: 'unloaded',
    async load(options: LoadOptions = {}) {
      loads.log.push(`load ${info.id}`);
      if (options.simulateOutOfMemory) {
        throw new OutOfMemoryError(`${info.label}: The graphics card ran out of memory.`);
      }
    },
    async unload() {
      loads.log.push(`unload ${info.id}`);
    },
    createSession: () => ({}),
    translate: async function* () {},
  });
  const factories: Record<string, () => Promise<unknown>> = {};
  for (const info of [...registry.asrEngines(), ...registry.translationEngines()]) {
    factories[info.id] = fake(info);
  }
  return { ENGINE_FACTORIES: factories };
});

const { OffscreenHost, FIT_NOTE, SLOW_NOTE, SPEED_NOTE } = await import('@/offscreen/host');

const CONFIG: SessionConfig = {
  sessionId: 's1',
  tabId: 3,
  source: { kind: 'tone' },
  asrEngine: 'qwen3-asr-1.7b',
  translationEngine: 'gemma4-e4b',
  targetLanguage: 'en',
  sourceLanguage: null,
  translatePartials: false,
  ladder: {
    profile: 'best',
    id: 'best-ladder',
    startedAt: 1000,
    gpu: 'nvidia|ampere||2048',
    steps: [
      { index: 0, asr: 'qwen3-asr-1.7b', translation: 'gemma4-e4b' },
      { index: 1, asr: 'qwen3-asr-1.7b', translation: 'gemma4-e2b' },
      { index: 2, asr: 'qwen3-asr-0.6b', translation: 'gemma4-e2b' },
      { index: 3, asr: 'qwen3-asr-0.6b', translation: 'chrome-translator' },
    ],
    length: 4,
    smaller: false,
  },
};

async function run(config: SessionConfig) {
  loads.log = [];
  const events: OffscreenEvent[] = [];
  const steps: string[] = [];
  const host = new OffscreenHost({
    send: async (event) => {
      events.push(event);
    },
    loadVad: async () => {
      throw new Error('no VAD here');
    },
    languageDetector: async () => null,
    onStepDown: (engine) => steps.push(engine),
  });
  await host.start(config);
  await host.loaded();
  const statuses = events.flatMap((e) => (e.type === 'session-status' ? [e.status] : []));
  const fits = events.filter((e) => e.type === 'memory-fit');
  await host.stop();
  return { statuses, fits, steps, last: statuses.at(-1) as ActiveSessionStatus };
}

describe('OffscreenHost memory ladder', () => {
  it('steps down when E4B runs out of memory warming up, and says so', async () => {
    const out = await run({ ...CONFIG, simulateOutOfMemory: { 'gemma4-e4b': 'warmup' } });
    expect(loads.log.slice(0, 4)).toEqual([
      'load qwen3-asr-1.7b',
      'load gemma4-e4b',
      'unload gemma4-e4b',
      'load gemma4-e2b',
    ]);
    expect(out.fits).toEqual([
      {
        target: 'background',
        type: 'memory-fit',
        sessionId: 's1',
        profile: 'best',
        gpu: 'nvidia|ampere||2048',
        ladder: 'best-ladder',
        startedAt: 1000,
        from: 0,
        step: 1,
        engine: 'gemma4-e4b',
        message: 'Gemma 4 E4B: The graphics card ran out of memory.',
      },
    ]);
    expect(out.steps).toEqual(['gemma4-e4b']);
    expect(out.last).toMatchObject({
      state: 'running',
      asr: 'Qwen3-ASR 1.7B',
      translation: 'Gemma 4 E2B',
      fitNote: FIT_NOTE,
    });
    // Not "E4B couldn't run here": the step down is the note.
    expect(out.last.state === 'running' && out.last.translationNote).toBeFalsy();
    expect(out.statuses.some((s) => s.state === 'loading' && s.detail.startsWith(FIT_NOTE))).toBe(
      true,
    );
  });

  it('goes past the 1.7B when it runs out by itself', async () => {
    const out = await run({ ...CONFIG, simulateOutOfMemory: { 'qwen3-asr-1.7b': 'load' } });
    expect(out.fits.map((e) => e.type === 'memory-fit' && e.step)).toEqual([2]);
    expect(out.last).toMatchObject({ asr: 'Qwen3-ASR 0.6B', translation: 'Gemma 4 E2B' });
  });

  it('starting lower by the guess or a record says so too; no ladder, no note', async () => {
    const lower = await run({
      ...CONFIG,
      asrEngine: 'qwen3-asr-0.6b',
      translationEngine: 'gemma4-e2b',
      ladder: { ...(CONFIG.ladder as NonNullable<SessionConfig['ladder']>), smaller: true },
    });
    expect(lower.last).toMatchObject({ state: 'running', fitNote: FIT_NOTE });
    const { ladder: _, ...plain } = CONFIG;
    const custom = await run(plain);
    expect(custom.last.state === 'running' && custom.last.fitNote).toBeFalsy();
  });

  it('without a ladder, an engine out of memory hands over to a smaller one', async () => {
    const { ladder: _, ...plain } = CONFIG;
    const out = await run({ ...plain, simulateOutOfMemory: { 'gemma4-e4b': 'load' } });
    expect(out.last).toMatchObject({ state: 'running', translation: 'Gemma 4 E2B' });
    expect(out.fits).toEqual([]);
  });

  it('says why it starts lower when larger models fell behind, or are too slow here', async () => {
    const ladder = CONFIG.ladder as NonNullable<SessionConfig['ladder']>;
    const lower = { ...CONFIG, asrEngine: 'qwen3-asr-1.7b', translationEngine: 'gemma4-e2b' };
    const slow = await run({ ...lower, ladder: { ...ladder, smaller: true, why: 'slow' } });
    expect(slow.last).toMatchObject({ state: 'running', fitNote: SLOW_NOTE });
    const speed = await run({ ...lower, ladder: { ...ladder, smaller: true, why: 'speed' } });
    expect(speed.last).toMatchObject({ state: 'running', fitNote: SPEED_NOTE });
  });
});

describe('OffscreenHost falling behind', () => {
  /** A final line with text, as the pipeline sends it. */
  const line = (n: number): Cue => ({
    id: `c${n}`,
    seq: n,
    startEpochMs: 0,
    endEpochMs: 0,
    source: { text: `line ${n}`, language: 'fr', final: true },
    translation: null,
    untranslated: 'pending',
  });

  it('tells the service worker when speech recognition stays slow: a smaller speech model', async () => {
    loads.log = [];
    const events: OffscreenEvent[] = [];
    const slow: unknown[] = [];
    const host = new OffscreenHost({
      send: async (event) => {
        events.push(event);
      },
      loadVad: async () => {
        throw new Error('no VAD here');
      },
      languageDetector: async () => null,
      onSlow: (found, next) => slow.push({ found, next: next?.index ?? null }),
    });
    await host.start(CONFIG);
    await host.loaded();
    const pipeline = pipelines.last as {
      onCue(cue: Cue): void;
      onHealth(health: Record<string, unknown>): void;
    };
    const health = { behind: false, backlogMs: 0, droppedPartials: 0, droppedSegments: 0 };
    pipeline.onHealth({ ...health, rtf: 0.8 });
    // The same line again (an update) counts once.
    for (let i = 0; i < 14; i++) {
      pipeline.onCue(line(i));
      pipeline.onCue(line(i));
    }
    expect(events.some((e) => e.type === 'memory-fit')).toBe(false);
    pipeline.onCue(line(14));
    const fits = events.filter((e) => e.type === 'memory-fit');
    expect(fits).toEqual([
      {
        target: 'background',
        type: 'memory-fit',
        sessionId: 's1',
        profile: 'best',
        gpu: 'nvidia|ampere||2048',
        ladder: 'best-ladder',
        startedAt: 1000,
        from: 0,
        // The next step with a smaller speech model, not just a smaller translator.
        step: 2,
        engine: 'qwen3-asr-1.7b',
        message: 'Qwen3-ASR 1.7B took 0.8 s per second of speech for 15 lines in a row.',
        cause: 'slow',
      },
    ]);
    expect(slow).toEqual([{ found: { engine: 'asr', rtf: 0.8, lines: 15 }, next: 2 }]);
    const statuses = events.flatMap((e) => (e.type === 'session-status' ? [e.status] : []));
    expect(statuses.at(-1)).toMatchObject({
      state: 'running',
      asr: 'Qwen3-ASR 1.7B',
      translation: 'Gemma 4 E4B',
      fitNote:
        'Qwen3-ASR 1.7B is falling behind the speech here. If it happens again, Murmur will start with smaller models.',
    });
    // Once a session.
    for (let i = 15; i < 40; i++) pipeline.onCue(line(i));
    expect(events.filter((e) => e.type === 'memory-fit')).toHaveLength(1);
    await host.stop();
  });

  it('never steps below the last step for slowness; no ladder, no step down', async () => {
    const ladder = CONFIG.ladder as NonNullable<SessionConfig['ladder']>;
    const last = { index: 3, asr: 'qwen3-asr-0.6b', translation: 'chrome-translator' };
    const atLast = {
      ...CONFIG,
      asrEngine: last.asr,
      translationEngine: last.translation,
      ladder: { ...ladder, steps: [last] },
    };
    for (const [config, expected] of [
      [atLast, []],
      [(({ ladder: _, ...plain }) => plain)(CONFIG), []],
    ] as const) {
      const events: OffscreenEvent[] = [];
      const host = new OffscreenHost({
        send: async (event) => {
          events.push(event);
        },
        loadVad: async () => {
          throw new Error('no VAD here');
        },
        languageDetector: async () => null,
      });
      await host.start(config);
      await host.loaded();
      const pipeline = pipelines.last as {
        onCue(cue: Cue): void;
        onHealth(health: Record<string, unknown>): void;
      };
      pipeline.onHealth({
        behind: false,
        backlogMs: 0,
        droppedPartials: 0,
        droppedSegments: 0,
        rtf: 1.2,
      });
      for (let i = 0; i < 20; i++) pipeline.onCue(line(i));
      expect(events.flatMap((e) => (e.type === 'memory-fit' ? [e.step] : []))).toEqual(expected);
      await host.stop();
    }
  });
  it('doesn’t count lines while the tab is hidden', async () => {
    const events: OffscreenEvent[] = [];
    const host = new OffscreenHost({
      send: async (event) => {
        events.push(event);
      },
      loadVad: async () => {
        throw new Error('no VAD here');
      },
      languageDetector: async () => null,
    });
    const port = {
      sender: { tab: { id: CONFIG.tabId }, frameId: 0 },
      postMessage: () => {},
      onDisconnect: { addListener: () => {} },
    };
    host.addOverlay(port);
    host.setOverlayVisible(port, false);
    await host.start(CONFIG);
    await host.loaded();
    const pipeline = pipelines.last as {
      onCue(cue: Cue): void;
      onHealth(health: Record<string, unknown>): void;
    };
    pipeline.onHealth({
      behind: false,
      backlogMs: 0,
      droppedPartials: 0,
      droppedSegments: 0,
      rtf: 2,
    });
    for (let i = 0; i < 40; i++) pipeline.onCue(line(i));
    expect(events.filter((e) => e.type === 'memory-fit')).toEqual([]);
    await host.stop();
  });
});
