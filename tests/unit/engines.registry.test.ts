import { describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from '@/engines/builtin';
import { ECHO_ASR_INFO, PASSTHROUGH_INFO } from '@/engines/demo/info';
import { checkRequirements, type HardwareInfo, NO_HARDWARE } from '@/engines/hardware';
import {
  DEMO_ASR_ID,
  DEMO_TRANSLATION_ID,
  PROFILE_ORDER,
  recommendProfile,
  resolveEngines,
} from '@/engines/profiles';
import { EngineRegistry } from '@/engines/registry';
import type { AsrEngine, AsrEngineInfo } from '@/engines/types';

const GPU: HardwareInfo = {
  webgpu: { available: true, shaderF16: true, maxBufferMB: 2048 },
  deviceMemoryGB: 8,
  cores: 8,
  companion: false,
};

const gpuAsr: AsrEngineInfo = {
  ...ECHO_ASR_INFO,
  id: 'test-gpu',
  label: 'GPU model',
  runtime: 'browser',
  requirements: { backends: ['webgpu'], shaderF16: true, downloadMB: 500 },
};

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
  it('lists and creates the built-in demo engines', async () => {
    const r = createBuiltinRegistry();
    expect(r.asrEngines().map((e) => e.id)).toEqual([DEMO_ASR_ID]);
    expect(r.translationEngines().map((e) => e.id)).toEqual([DEMO_TRANSLATION_ID]);
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

  it('takes the first candidate that fits, with notes on the ones skipped', () => {
    const r = createBuiltinRegistry().registerAsr({
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
    expect(recommendProfile(GPU)).toBe('best');
    expect(recommendProfile({ ...NO_HARDWARE, companion: true })).toBe('best');
  });
});
