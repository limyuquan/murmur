import { describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from '@/engines/builtin';
import { ECHO_ASR_INFO, PASSTHROUGH_INFO } from '@/engines/demo/info';
import {
  checkRequirements,
  estimateGpuMemoryMB,
  gpuKind,
  type HardwareInfo,
  NO_HARDWARE,
} from '@/engines/hardware';
import {
  DEMO_ASR_ID,
  DEMO_TRANSLATION_ID,
  GEMMA_E2B_ID,
  GEMMA_E4B_ID,
  LINE_FALLBACKS,
  PROFILE_ORDER,
  PROFILES,
  QWEN3_ASR_ID,
  RUNTIME_FALLBACKS,
  recommendProfile,
  resolveEngines,
  WHISPER_BASE_ID,
  WHISPER_TURBO_ID,
} from '@/engines/profiles';
import { EngineRegistry } from '@/engines/registry';
import type { AsrEngine, AsrEngineInfo } from '@/engines/types';

const GPU: HardwareInfo = {
  webgpu: { available: true, shaderF16: true, maxBufferMB: 2048 },
  deviceMemoryGB: 8,
  cores: 8,
  companion: false,
};
const NVIDIA: HardwareInfo = {
  ...GPU,
  webgpu: { ...GPU.webgpu, vendor: 'nvidia', architecture: 'ampere' },
};

const gpuAsr: AsrEngineInfo = {
  ...ECHO_ASR_INFO,
  id: 'test-gpu',
  label: 'GPU model',
  runtime: 'browser',
  requirements: { backends: ['webgpu'], shaderF16: true, downloadMB: 500 },
};

/** The demo engines, as e2e builds register them. */
function demoRegistry(): EngineRegistry {
  return new EngineRegistry()
    .registerAsr({
      info: ECHO_ASR_INFO,
      create: async () => new (await import('@/engines/demo/echoAsr')).EchoAsrEngine(),
    })
    .registerTranslation({
      info: PASSTHROUGH_INFO,
      create: async () =>
        new (await import('@/engines/demo/passthroughTranslator')).PassthroughTranslationEngine(),
    });
}

function fakeEngine(info: AsrEngineInfo): AsrEngine {
  return {
    info,
    state: 'unloaded',
    load: async () => {},
    unload: async () => {},
    createSession: () => {
      throw new Error('not used');
    },
  };
}

describe('EngineRegistry', () => {
  it('ships the real engines, and the demo engines only in e2e builds', () => {
    const r = createBuiltinRegistry();
    expect(r.asrEngines().map((e) => e.id)).toEqual([
      'chrome-webspeech',
      WHISPER_BASE_ID,
      WHISPER_TURBO_ID,
      QWEN3_ASR_ID,
    ]);
    expect(r.translationEngines().map((e) => e.id)).toEqual([
      'chrome-translator',
      GEMMA_E2B_ID,
      GEMMA_E4B_ID,
    ]);
    expect(r.hasAsr(DEMO_ASR_ID)).toBe(false);
  });

  it('creates and loads engines', async () => {
    const r = demoRegistry();
    const asr = await r.createAsr(DEMO_ASR_ID);
    expect(asr.info).toBe(ECHO_ASR_INFO);
    const mt = await r.createTranslation(DEMO_TRANSLATION_ID);
    expect(mt.info).toBe(PASSTHROUGH_INFO);
    await asr.load();
    expect(asr.state).toBe('ready');
  });

  it('rejects duplicates and kind mismatches', () => {
    const r = new EngineRegistry().registerAsr({
      info: gpuAsr,
      create: async () => fakeEngine(gpuAsr),
    });
    expect(() => r.registerAsr({ info: gpuAsr, create: async () => fakeEngine(gpuAsr) })).toThrow(
      /already registered/,
    );
    expect(() =>
      r.registerTranslation({
        info: gpuAsr as never,
        create: async () => fakeEngine(gpuAsr) as never,
      }),
    ).toThrow(/asr engine, not translation/);
  });

  it('fails clearly for unknown ids and lying factories', async () => {
    const r = new EngineRegistry().registerAsr({
      info: gpuAsr,
      create: async () => fakeEngine(ECHO_ASR_INFO),
    });
    await expect(r.createAsr('nope')).rejects.toThrow('No asr engine called nope');
    await expect(r.createAsr('test-gpu')).rejects.toThrow(/made demo-echo/);
  });
});

describe('checkRequirements', () => {
  it('passes plain-JS engines anywhere', () => {
    expect(checkRequirements(ECHO_ASR_INFO.requirements, NO_HARDWARE)).toEqual({ ok: true });
  });

  it('explains what is missing', () => {
    expect(checkRequirements(gpuAsr.requirements, NO_HARDWARE)).toEqual({
      ok: false,
      reasons: ['Needs WebGPU.'],
    });
    const noF16 = { ...GPU, webgpu: { ...GPU.webgpu, shaderF16: false } };
    expect(checkRequirements(gpuAsr.requirements, noF16)).toEqual({
      ok: false,
      reasons: ['Needs a GPU with 16-bit float shaders.'],
    });
    expect(checkRequirements({ backends: ['wasm'], minDeviceMemoryGB: 16 }, GPU)).toEqual({
      ok: false,
      reasons: ['Needs 16 GB of memory.'],
    });
  });

  it('accepts the companion as a backend when it is running', () => {
    const req = { backends: ['companion'] as const };
    expect(checkRequirements(req, NO_HARDWARE).ok).toBe(false);
    expect(checkRequirements(req, { ...NO_HARDWARE, companion: true }).ok).toBe(true);
  });
});

describe('profiles', () => {
  it('every profile resolves to registered engines today', () => {
    const r = createBuiltinRegistry();
    for (const id of PROFILE_ORDER) {
      const resolved = resolveEngines(
        id,
        { asr: DEMO_ASR_ID, translation: DEMO_TRANSLATION_ID },
        r,
        NO_HARDWARE,
      );
      expect(r.hasAsr(resolved.asr)).toBe(true);
      expect(r.hasTranslation(resolved.translation)).toBe(true);
    }
  });

  it('profiles: Light is Chrome speech, Balanced is Qwen3-ASR then Whisper turbo and base', () => {
    expect(PROFILES.light.asr).toEqual(['chrome-webspeech', WHISPER_BASE_ID]);
    expect(PROFILES.light.translation).toEqual(['chrome-translator']);
    expect(PROFILES.balanced.asr).toEqual([QWEN3_ASR_ID, WHISPER_TURBO_ID, WHISPER_BASE_ID]);
    expect(PROFILES.best.asr).toEqual(PROFILES.balanced.asr);
    // Qwen3-ASR's files aren't published, so builds that download from Hugging Face skip it.
    const r = createBuiltinRegistry();
    const none = { asr: DEMO_ASR_ID, translation: DEMO_TRANSLATION_ID };
    expect(resolveEngines('balanced', none, r, GPU)).toMatchObject({
      asr: WHISPER_TURBO_ID,
      translation: GEMMA_E2B_ID,
    });
    // No WebGPU: turbo doesn't fit, base runs on WebAssembly.
    expect(resolveEngines('balanced', none, r, NO_HARDWARE).asr).toBe(WHISPER_BASE_ID);
    // A custom choice of demo engines in a build without them: the real last resorts.
    expect(resolveEngines('custom', none, r, GPU)).toMatchObject({
      asr: WHISPER_BASE_ID,
      translation: 'chrome-translator',
    });
  });

  it('takes the first candidate that fits, with notes on the ones skipped', () => {
    const r = demoRegistry().registerAsr({
      info: gpuAsr,
      create: async () => fakeEngine(gpuAsr),
    });
    const custom = { asr: 'test-gpu', translation: DEMO_TRANSLATION_ID };
    expect(resolveEngines('custom', custom, r, GPU)).toEqual({
      asr: 'test-gpu',
      translation: DEMO_TRANSLATION_ID,
      notes: [],
    });
    expect(resolveEngines('custom', custom, r, NO_HARDWARE)).toEqual({
      asr: DEMO_ASR_ID,
      translation: DEMO_TRANSLATION_ID,
      notes: ['GPU model: Needs WebGPU.'],
    });
    expect(resolveEngines('custom', { ...custom, asr: 'gone' }, r, GPU).notes).toEqual([
      "gone isn't available in this build.",
    ]);
  });

  it('recommends a profile from the hardware', () => {
    expect(recommendProfile(NO_HARDWARE)).toBe('light');
    expect(recommendProfile({ ...GPU, webgpu: { ...GPU.webgpu, shaderF16: false } })).toBe(
      'balanced',
    );
    // Best only on a card with its own memory.
    expect(recommendProfile(GPU)).toBe('balanced');
    expect(recommendProfile(NVIDIA)).toBe('best');
    expect(recommendProfile({ ...GPU, webgpu: { ...GPU.webgpu, vendor: 'apple' } })).toBe(
      'balanced',
    );
    expect(recommendProfile({ ...NO_HARDWARE, companion: true })).toBe('best');
  });

  it('translation: Gemma 4 E2B in Balanced, E4B in Best, by graphics memory', () => {
    expect(PROFILES.balanced.translation).toEqual([GEMMA_E2B_ID, 'chrome-translator']);
    expect(PROFILES.best.translation).toEqual([GEMMA_E4B_ID, GEMMA_E2B_ID, 'chrome-translator']);
    const r = createBuiltinRegistry();
    const none = { asr: DEMO_ASR_ID, translation: DEMO_TRANSLATION_ID };
    const mt = (choice: 'light' | 'balanced' | 'best', hw: HardwareInfo) =>
      resolveEngines(choice, none, r, hw).translation;
    expect(mt('light', NVIDIA)).toBe('chrome-translator');
    expect(mt('balanced', NVIDIA)).toBe(GEMMA_E2B_ID);
    expect(mt('best', NVIDIA)).toBe(GEMMA_E4B_ID);
    // Apple silicon shares 8 GB: E2B fits, E4B doesn't.
    const apple = { ...GPU, webgpu: { ...GPU.webgpu, vendor: 'apple' } };
    expect(mt('best', apple)).toBe(GEMMA_E2B_ID);
    expect(resolveEngines('best', none, r, apple).notes).toContain(
      'Gemma 4 E4B: Needs about 5 GB of graphics memory, more than this device seems to have.',
    );
    // Graphics in the processor, or less memory: Chrome's translator.
    const intel = {
      ...GPU,
      webgpu: { ...GPU.webgpu, vendor: 'intel', architecture: 'gen-12lp' },
    };
    expect(mt('balanced', intel)).toBe('chrome-translator');
    expect(mt('best', intel)).toBe('chrome-translator');
    expect(mt('balanced', { ...NVIDIA, deviceMemoryGB: 4 })).toBe('chrome-translator');
    // A software adapter, or no WebGPU.
    expect(mt('balanced', { ...NVIDIA, webgpu: { ...NVIDIA.webgpu, fallback: true } })).toBe(
      'chrome-translator',
    );
    expect(mt('balanced', NO_HARDWARE)).toBe('chrome-translator');
  });

  it('falls back from an LLM that can’t load, and for single lines, to Chrome’s translator', () => {
    expect(RUNTIME_FALLBACKS[GEMMA_E2B_ID]).toBe('chrome-translator');
    // Not E4B to E2B: E2B may not be downloaded.
    expect(RUNTIME_FALLBACKS[GEMMA_E4B_ID]).toBe('chrome-translator');
    expect(LINE_FALLBACKS[GEMMA_E2B_ID]).toBe('chrome-translator');
    expect(LINE_FALLBACKS[GEMMA_E4B_ID]).toBe('chrome-translator');
    expect(LINE_FALLBACKS['chrome-translator']).toBeUndefined();
  });

  it('guesses graphics memory from the kind of card', () => {
    expect(gpuKind(NVIDIA.webgpu)).toBe('discrete');
    expect(gpuKind({ ...GPU.webgpu, vendor: 'intel', architecture: 'xe-hpg' })).toBe('discrete');
    expect(gpuKind({ ...GPU.webgpu, vendor: 'intel', architecture: 'gen-12lp' })).toBe(
      'integrated',
    );
    expect(gpuKind({ ...GPU.webgpu, vendor: 'apple' })).toBe('unified');
    expect(gpuKind({ ...GPU.webgpu, vendor: 'amd' })).toBe('unknown');
    expect(gpuKind(NO_HARDWARE.webgpu)).toBe('software');
    expect(estimateGpuMemoryMB(NVIDIA)).toBeGreaterThanOrEqual(5120);
    expect(estimateGpuMemoryMB({ ...GPU, webgpu: { ...GPU.webgpu, vendor: 'apple' } })).toBe(4096);
    expect(estimateGpuMemoryMB(NO_HARDWARE)).toBe(0);
  });
});
