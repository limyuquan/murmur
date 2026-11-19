/**
 * Memory ladders: which pair of engines a session starts with (the graphics-memory guess, or what
 * worked on this device before, or the smaller speech model by choice), and how loading steps
 * down when an engine runs out of memory while loading or warming up.
 */
import { describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from '@/engines/builtin';
import { CHROME_TRANSLATOR_ID, CHROME_WEBSPEECH_ID } from '@/engines/chrome/info';
import {
  EngineUnavailableError,
  isOutOfMemory,
  looksLikeOutOfMemory,
  ModelError,
  OutOfMemoryError,
} from '@/engines/errors';
import {
  estimateGpuMemoryMB,
  gpuKey,
  gpuKind,
  type HardwareInfo,
  namedCardGB,
} from '@/engines/hardware';
import { loadLadder, loadWithFallback } from '@/engines/loading';
import {
  GEMMA_E2B_ID,
  GEMMA_E4B_ID,
  LADDERS,
  type LadderStep,
  ladderFromStart,
  MEMORY_FALLBACKS,
  QWEN3_ASR_17B_ID,
  QWEN3_ASR_ID,
  recommendProfile,
  resolveEngines,
  WHISPER_BASE_ID,
  WHISPER_TURBO_ID,
} from '@/engines/profiles';
import { EngineRegistry } from '@/engines/registry';
import type { AsrEngine, TranslationEngine } from '@/engines/types';

const NVIDIA: HardwareInfo = {
  webgpu: {
    available: true,
    shaderF16: true,
    maxBufferMB: 2048,
    vendor: 'nvidia',
    architecture: 'ampere',
  },
  deviceMemoryGB: 8,
  cores: 8,
  companion: false,
};
const named = (description: string): HardwareInfo => ({
  ...NVIDIA,
  webgpu: { ...NVIDIA.webgpu, description },
});
const APPLE: HardwareInfo = { ...NVIDIA, webgpu: { ...NVIDIA.webgpu, vendor: 'apple' } };
const none = { asr: 'demo-echo', translation: 'demo-passthrough' };

/** The built-in engines as where Qwen3-ASR's files are published (or the fixture server). */
function published(): EngineRegistry {
  const r = new EngineRegistry();
  for (const info of createBuiltinRegistry().asrEngines()) {
    const { unavailable: _, ...rest } = info;
    r.registerAsr({ info: rest, create: async () => ({}) as never });
  }
  for (const info of createBuiltinRegistry().translationEngines()) {
    r.registerTranslation({ info, create: async () => ({}) as never });
  }
  return r;
}

const pair = (r: { asr: string; translation: string }) => [r.asr, r.translation];

describe('memory ladders', () => {
  it('step from the largest pair down, Best through E2B, Balanced from 1.7B + E2B', () => {
    expect(LADDERS.best?.map(pair)).toEqual([
      [QWEN3_ASR_17B_ID, GEMMA_E4B_ID],
      [QWEN3_ASR_17B_ID, GEMMA_E2B_ID],
      [QWEN3_ASR_ID, GEMMA_E2B_ID],
      [QWEN3_ASR_ID, CHROME_TRANSLATOR_ID],
    ]);
    expect(LADDERS.balanced?.map(pair)).toEqual([
      [QWEN3_ASR_17B_ID, GEMMA_E2B_ID],
      [QWEN3_ASR_ID, GEMMA_E2B_ID],
      [QWEN3_ASR_ID, CHROME_TRANSLATOR_ID],
    ]);
    expect(LADDERS.light).toBeUndefined();
    // Out of memory outside a ladder: the smaller engine, then Chrome's own.
    expect(MEMORY_FALLBACKS[QWEN3_ASR_17B_ID]).toBe(QWEN3_ASR_ID);
    expect(MEMORY_FALLBACKS[QWEN3_ASR_ID]).toBe(CHROME_WEBSPEECH_ID);
    expect(MEMORY_FALLBACKS[GEMMA_E4B_ID]).toBe(GEMMA_E2B_ID);
    expect(MEMORY_FALLBACKS[GEMMA_E2B_ID]).toBe(CHROME_TRANSLATOR_ID);
  });

  it('start at the first pair that fits the graphics-memory guess', () => {
    const r = published();
    const at = (choice: 'balanced' | 'best', hw: HardwareInfo) => {
      const resolved = resolveEngines(choice, none, r, hw);
      return [resolved.asr, resolved.translation, resolved.ladder?.start];
    };
    // An unnamed NVIDIA card (6 GB guessed): the largest pairs.
    expect(at('best', NVIDIA)).toEqual([QWEN3_ASR_17B_ID, GEMMA_E4B_ID, 0]);
    expect(at('balanced', NVIDIA)).toEqual([QWEN3_ASR_17B_ID, GEMMA_E2B_ID, 0]);
    // A named 4 GB laptop card: the 0.6B with E2B.
    const small = named('NVIDIA GeForce RTX 3050 Laptop GPU');
    expect(at('best', small)).toEqual([QWEN3_ASR_ID, GEMMA_E2B_ID, 2]);
    expect(at('balanced', small)).toEqual([QWEN3_ASR_ID, GEMMA_E2B_ID, 1]);
    // A named 6 GB card: the 1.7B with E2B, not E4B.
    expect(at('best', named('NVIDIA GeForce RTX 4050 Laptop GPU'))).toEqual([
      QWEN3_ASR_17B_ID,
      GEMMA_E2B_ID,
      1,
    ]);
    // Apple silicon sharing 8 GB (4 GB guessed): the 0.6B with E2B.
    expect(at('balanced', APPLE)).toEqual([QWEN3_ASR_ID, GEMMA_E2B_ID, 1]);
    // Graphics in the processor: the 0.6B with Chrome's translator.
    const intel = {
      ...NVIDIA,
      webgpu: { ...NVIDIA.webgpu, vendor: 'intel', architecture: 'gen-12lp' },
    };
    expect(at('balanced', intel)).toEqual([QWEN3_ASR_ID, CHROME_TRANSLATOR_ID, 2]);
  });

  it('start where this device last worked, above or below the guess', () => {
    const r = published();
    const best = (step: number, hw = NVIDIA) =>
      resolveEngines('best', none, r, hw, { fit: { step } });
    expect(pair(best(1))).toEqual([QWEN3_ASR_17B_ID, GEMMA_E2B_ID]);
    expect(best(1).ladder?.reason).toBe('record');
    expect(best(1).notes).toEqual([
      'Smaller models: larger ones ran out of graphics memory on this device.',
    ]);
    expect(pair(best(3))).toEqual([QWEN3_ASR_ID, CHROME_TRANSLATOR_ID]);
    // "Try the larger models": the top, even where the guess says less.
    expect(pair(best(0, APPLE))).toEqual([QWEN3_ASR_17B_ID, GEMMA_E4B_ID]);
    expect(best(0, APPLE).ladder?.reason).toBeNull();
    // Below the last step: Chrome's own engines, nothing to step down.
    const below = best(4);
    expect(pair(below)).toEqual([CHROME_WEBSPEECH_ID, CHROME_TRANSLATOR_ID]);
    expect(below.ladder && ladderFromStart(below.ladder)).toEqual([]);
    // A record past the end counts as below.
    expect(pair(best(9))).toEqual([CHROME_WEBSPEECH_ID, CHROME_TRANSLATOR_ID]);
  });

  it('Balanced can use the smaller speech model by choice', () => {
    const r = published();
    const balanced = resolveEngines('balanced', none, r, NVIDIA, { smallerSpeech: true });
    expect(pair(balanced)).toEqual([QWEN3_ASR_ID, GEMMA_E2B_ID]);
    expect(balanced.ladder?.reason).toBe('smaller');
    expect(balanced.notes).toEqual([]);
    // Best keeps its own ladder.
    expect(pair(resolveEngines('best', none, r, NVIDIA, { smallerSpeech: true }))).toEqual([
      QWEN3_ASR_17B_ID,
      GEMMA_E4B_ID,
    ]);
    // A record further down still wins.
    expect(
      pair(resolveEngines('balanced', none, r, NVIDIA, { smallerSpeech: true, fit: { step: 2 } })),
    ).toEqual([QWEN3_ASR_ID, CHROME_TRANSLATOR_ID]);
  });

  it('hands the session the steps from where it starts, one per distinct pair', () => {
    const r = published();
    const best = resolveEngines('best', none, r, NVIDIA, { fit: { step: 1 } });
    expect(best.ladder && ladderFromStart(best.ladder).map((s) => [s.index, s.asr])).toEqual([
      [1, QWEN3_ASR_17B_ID],
      [2, QWEN3_ASR_ID],
      [3, QWEN3_ASR_ID],
    ]);
    // Where Qwen3-ASR's files aren't published, turbo stands in for both sizes.
    const prod = resolveEngines('balanced', none, createBuiltinRegistry(), NVIDIA);
    expect(prod.ladder && ladderFromStart(prod.ladder).map(pair)).toEqual([
      [WHISPER_TURBO_ID, GEMMA_E2B_ID],
      [WHISPER_TURBO_ID, CHROME_TRANSLATOR_ID],
    ]);
  });

  it('recommends Best only where its largest pair fits the guess', () => {
    expect(recommendProfile(NVIDIA)).toBe('best');
    expect(recommendProfile(named('NVIDIA GeForce RTX 3060 Laptop GPU'))).toBe('balanced');
    expect(recommendProfile(named('NVIDIA GeForce RTX 3070'))).toBe('best');
  });
});

describe('graphics-memory hints', () => {
  it('reads a card’s memory from its name', () => {
    expect(namedCardGB('NVIDIA GeForce RTX 3050 Laptop GPU')).toBe(4);
    expect(namedCardGB('NVIDIA GeForce RTX 3050 6GB Laptop GPU')).toBe(6);
    expect(namedCardGB('NVIDIA GeForce RTX 3060 Laptop GPU')).toBe(6);
    expect(namedCardGB('NVIDIA GeForce GTX 1650')).toBe(4);
    expect(namedCardGB('NVIDIA GeForce RTX 3070')).toBe(8);
    expect(namedCardGB('AMD Radeon RX 6500 XT')).toBe(4);
    expect(namedCardGB('Intel(R) Arc(TM) A370M Graphics')).toBe(4);
    expect(namedCardGB('NVIDIA GeForce RTX 4090')).toBeNull();
    expect(namedCardGB(undefined)).toBeNull();
  });

  it('uses names, memory and buffer limits as hints', () => {
    // 85% of a named card: the desktop and the driver keep the rest.
    expect(estimateGpuMemoryMB(named('NVIDIA GeForce RTX 3050 Laptop GPU'))).toBe(3482);
    expect(estimateGpuMemoryMB(NVIDIA)).toBe(6144);
    expect(estimateGpuMemoryMB({ ...NVIDIA, deviceMemoryGB: 4 })).toBe(3482);
    // A card whose largest buffer is under 1 GB is an old or small one.
    expect(
      estimateGpuMemoryMB({ ...NVIDIA, webgpu: { ...NVIDIA.webgpu, maxStorageBufferMB: 512 } }),
    ).toBe(3072);
    // AMD: a named Radeon RX is a card with its own memory; its processor graphics aren't.
    const amd = (description?: string): HardwareInfo => ({
      ...NVIDIA,
      webgpu: {
        ...NVIDIA.webgpu,
        vendor: 'amd',
        architecture: 'rdna-2',
        ...(description ? { description } : {}),
      },
    });
    expect(gpuKind(amd('AMD Radeon RX 6700 XT').webgpu)).toBe('discrete');
    expect(gpuKind(amd('AMD Radeon(TM) Graphics').webgpu)).toBe('integrated');
    expect(gpuKind(amd().webgpu)).toBe('unknown');
    expect(estimateGpuMemoryMB(amd('AMD Radeon RX 6500 XT'))).toBe(3482);
  });

  it('keys the per-device record by the card', () => {
    expect(gpuKey(NVIDIA)).toBe('nvidia|ampere||2048');
    expect(gpuKey(named('NVIDIA GeForce RTX 3070'))).toBe(
      'nvidia|ampere|NVIDIA GeForce RTX 3070|2048',
    );
    expect(
      gpuKey({ ...NVIDIA, webgpu: { available: false, shaderF16: false, maxBufferMB: 0 } }),
    ).toBe('none');
  });

  it('tells out-of-memory messages from other failures', () => {
    for (const m of [
      'GPUOutOfMemoryError: Failed to allocate buffer',
      'RangeError: Array buffer allocation failed',
      'Aborted(OOM)',
      'Cannot enlarge memory arrays',
      'std::bad_alloc',
      'Device was lost: D3D12 device removed',
      'WebGPU device lost',
      'Not enough memory to complete the operation',
    ]) {
      expect(looksLikeOutOfMemory(m), m).toBe(true);
    }
    for (const m of ['Invalid ShaderModule', 'model.onnx isn’t downloaded.', 'room', 'bloom']) {
      expect(looksLikeOutOfMemory(m), m).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Loading down a ladder, with engines that fail as told.

type Behaviour = 'ok' | 'oom' | Error;

class FakeEngine {
  state: 'unloaded' | 'ready' = 'unloaded';
  lost: Error | null = null;
  constructor(
    readonly info: { id: string; label: string },
    private readonly behaviour: Behaviour,
    private readonly log: string[],
  ) {}
  async load(): Promise<void> {
    this.log.push(`load ${this.info.id}`);
    if (this.behaviour === 'oom') {
      throw new OutOfMemoryError(`${this.info.label}: The graphics card ran out of memory.`);
    }
    if (this.behaviour instanceof Error) throw this.behaviour;
    this.state = 'ready';
  }
  async unload(): Promise<void> {
    this.log.push(`unload ${this.info.id}`);
    this.state = 'unloaded';
  }
  memoryFailure(): Error | null {
    return this.lost;
  }
}

function ladderRig(behaviours: Record<string, Behaviour>, steps: readonly LadderStep[]) {
  const log: string[] = [];
  const downs: [number | null, string][] = [];
  const engines: FakeEngine[] = [];
  const make = async (id: string) => {
    const e = new FakeEngine({ id, label: id }, behaviours[id] ?? 'ok', log);
    engines.push(e);
    return e;
  };
  const run = (extra: { asrLost?: (e: FakeEngine) => Error | null } = {}) =>
    loadLadder(steps, {
      createAsr: (id) => make(id) as unknown as Promise<AsrEngine>,
      createTranslation: (id) => make(id) as unknown as Promise<TranslationEngine>,
      loadAsr: (e) => e.load(),
      loadTranslation: (e) => e.load(),
      onStepDown: (next, failed) => downs.push([next?.index ?? null, failed]),
      ...(extra.asrLost
        ? { asrMemoryFailure: (e) => extra.asrLost?.(e as unknown as FakeEngine) ?? null }
        : {}),
    });
  return { log, downs, engines, run };
}

const BEST = (LADDERS.best ?? []).map((p, index) => ({ ...p, index }));
const BALANCED = (LADDERS.balanced ?? []).map((p, index) => ({ ...p, index }));

describe('loadLadder', () => {
  it('loads the first step, speech recognition first', async () => {
    const rig = ladderRig({}, BEST);
    const out = await rig.run();
    expect(out.step?.index).toBe(0);
    expect(rig.log).toEqual([`load ${QWEN3_ASR_17B_ID}`, `load ${GEMMA_E4B_ID}`]);
    expect(out.failures).toEqual([]);
  });

  it('a translator out of memory: the next step, keeping the speech model', async () => {
    const rig = ladderRig({ [GEMMA_E4B_ID]: 'oom' }, BEST);
    const out = await rig.run();
    expect(out.step?.index).toBe(1);
    expect([out.asr.info.id, out.translator.info.id]).toEqual([QWEN3_ASR_17B_ID, GEMMA_E2B_ID]);
    expect(rig.log).toEqual([
      `load ${QWEN3_ASR_17B_ID}`,
      `load ${GEMMA_E4B_ID}`,
      `unload ${GEMMA_E4B_ID}`,
      `load ${GEMMA_E2B_ID}`,
    ]);
    expect(rig.downs).toEqual([[1, GEMMA_E4B_ID]]);
    expect(out.failures.map((f) => f.engine)).toEqual([GEMMA_E4B_ID]);
  });

  it('then the smaller speech model with E2B, when E2B doesn’t fit next to the 1.7B', async () => {
    // E2B fails next to the 1.7B only: the fake fails its first load.
    let e2bLoads = 0;
    const rig = ladderRig({ [GEMMA_E4B_ID]: 'oom' }, BEST);
    const original = FakeEngine.prototype.load;
    FakeEngine.prototype.load = async function (this: FakeEngine) {
      if (this.info.id === GEMMA_E2B_ID && e2bLoads++ === 0) {
        throw new OutOfMemoryError('Gemma 4 E2B: out of memory');
      }
      return original.call(this);
    };
    try {
      const out = await rig.run();
      expect(out.step?.index).toBe(2);
      expect([out.asr.info.id, out.translator.info.id]).toEqual([QWEN3_ASR_ID, GEMMA_E2B_ID]);
      expect(rig.log).toContain(`unload ${QWEN3_ASR_17B_ID}`);
      expect(rig.downs).toEqual([
        [1, GEMMA_E4B_ID],
        [2, GEMMA_E2B_ID],
      ]);
    } finally {
      FakeEngine.prototype.load = original;
    }
  });

  it('a speech model out of memory by itself: every step with it is skipped', async () => {
    const rig = ladderRig({ [QWEN3_ASR_17B_ID]: 'oom' }, BALANCED);
    const out = await rig.run();
    expect(out.step?.index).toBe(1);
    expect(rig.downs).toEqual([[1, QWEN3_ASR_17B_ID]]);
    expect(rig.log).toEqual([
      `load ${QWEN3_ASR_17B_ID}`,
      `unload ${QWEN3_ASR_17B_ID}`,
      `load ${QWEN3_ASR_ID}`,
      `load ${GEMMA_E2B_ID}`,
    ]);
  });

  it('below the last step: Chrome’s speech recognition and translator', async () => {
    const rig = ladderRig({ [QWEN3_ASR_17B_ID]: 'oom', [QWEN3_ASR_ID]: 'oom' }, BALANCED);
    const out = await rig.run();
    expect(out.step).toBeNull();
    expect([out.asr.info.id, out.translator.info.id]).toEqual([
      CHROME_WEBSPEECH_ID,
      CHROME_TRANSLATOR_ID,
    ]);
    expect(rig.downs).toEqual([
      [1, QWEN3_ASR_17B_ID],
      [null, QWEN3_ASR_ID],
    ]);
    // Chrome's speech recognition can't run here: Whisper base, as without a ladder.
    const rig2 = ladderRig(
      {
        [QWEN3_ASR_17B_ID]: 'oom',
        [QWEN3_ASR_ID]: 'oom',
        [CHROME_WEBSPEECH_ID]: new EngineUnavailableError('No on-device speech here.'),
      },
      BALANCED,
    );
    expect((await rig2.run()).asr.info.id).toBe(WHISPER_BASE_ID);
  });

  it('a speech model whose device was lost while the translator loaded steps down too', async () => {
    const rig = ladderRig({}, BALANCED);
    const out = await rig.run({
      asrLost: (e) =>
        e.info.id === QWEN3_ASR_17B_ID
          ? new OutOfMemoryError('The graphics device was lost.')
          : null,
    });
    expect(out.step?.index).toBe(1);
    expect(rig.log).toEqual([
      `load ${QWEN3_ASR_17B_ID}`,
      `load ${GEMMA_E2B_ID}`,
      `unload ${GEMMA_E2B_ID}`,
      `unload ${QWEN3_ASR_17B_ID}`,
      `load ${QWEN3_ASR_ID}`,
      `load ${GEMMA_E2B_ID}`,
    ]);
  });

  it('other failures fall back as before, or stop the session with the speech model freed', async () => {
    // E2B not downloaded: Chrome's translator stands in, no step down.
    const missing = new ModelError(
      'Gemma 4 E2B isn’t downloaded yet.',
      ['gemma4-e2b-webgpu'],
      true,
    );
    const rig = ladderRig({ [GEMMA_E2B_ID]: missing }, BALANCED);
    const out = await rig.run();
    expect([out.asr.info.id, out.translator.info.id]).toEqual([
      QWEN3_ASR_17B_ID,
      CHROME_TRANSLATOR_ID,
    ]);
    expect(rig.downs).toEqual([]);
    // The 0.6B a step down isn't downloaded: the session fails (the popup offers it).
    const rig2 = ladderRig(
      {
        [QWEN3_ASR_17B_ID]: 'oom',
        [QWEN3_ASR_ID]: new ModelError('Qwen3-ASR 0.6B isn’t downloaded yet.', [], true),
      },
      BALANCED,
    );
    await expect(rig2.run()).rejects.toThrow('isn’t downloaded');
    expect(rig2.downs).toEqual([[1, QWEN3_ASR_17B_ID]]);
    // A translator that can't load stops the session: the speech model is unloaded.
    const rig3 = ladderRig({ [CHROME_TRANSLATOR_ID]: new Error('boom') }, [
      { asr: QWEN3_ASR_ID, translation: CHROME_TRANSLATOR_ID, index: 2 },
    ]);
    await expect(rig3.run()).rejects.toThrow('boom');
    expect(rig3.log.at(-1)).toBe(`unload ${QWEN3_ASR_ID}`);
  });

  it('a stop while loading frees what loaded', async () => {
    const controller = new AbortController();
    const log: string[] = [];
    const run = loadLadder(BALANCED, {
      createAsr: async (id) => new FakeEngine({ id, label: id }, 'ok', log) as unknown as AsrEngine,
      createTranslation: async (id) =>
        new FakeEngine({ id, label: id }, 'ok', log) as unknown as TranslationEngine,
      loadAsr: (e) => e.load(),
      loadTranslation: () => new Promise(() => controller.abort(new Error('stopped'))),
      signal: controller.signal,
    });
    await expect(run).rejects.toThrow('stopped');
    expect(log).toContain(`unload ${QWEN3_ASR_17B_ID}`);
  });
});

describe('loadWithFallback out of memory', () => {
  it('throws for a ladder, or falls back to the smaller engine without one', async () => {
    const log: string[] = [];
    const make = async (id: string) =>
      new FakeEngine(
        { id, label: id },
        id === GEMMA_E4B_ID ? 'oom' : 'ok',
        log,
      ) as unknown as TranslationEngine;
    const err = await loadWithFallback(GEMMA_E4B_ID, make, (e) => e.load()).catch((e) => e);
    expect(isOutOfMemory(err)).toBe(true);
    const engine = await loadWithFallback(GEMMA_E4B_ID, make, (e) => e.load(), undefined, {
      onOutOfMemory: true,
    });
    expect(engine.info.id).toBe(GEMMA_E2B_ID);
  });
});
