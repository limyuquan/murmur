/** What the options and welcome pages say about model sizes and graphics memory. */
import { describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from '@/engines/builtin';
import type { HardwareInfo } from '@/engines/hardware';
import { resolveEngines } from '@/engines/profiles';
import { EngineRegistry } from '@/engines/registry';
import { engineNames, memoryFitCopy, smallerSpeechCopy } from '@/ui/fitcopy';
import { PROFILE_COPY } from '@/ui/models';

const NVIDIA: HardwareInfo = {
  webgpu: { available: true, shaderF16: true, maxBufferMB: 2048, vendor: 'nvidia' },
  deviceMemoryGB: 8,
  cores: 8,
  companion: false,
};
const APPLE: HardwareInfo = { ...NVIDIA, webgpu: { ...NVIDIA.webgpu, vendor: 'apple' } };
const none = { asr: 'demo-echo', translation: 'demo-passthrough' };

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

describe('model size copy', () => {
  it('offers the smaller speech model with both sizes, where the larger one runs', () => {
    expect(smallerSpeechCopy(published())).toEqual({
      label: 'Use the smaller speech model (1.1 GB)',
      hint: 'Qwen3-ASR 0.6B instead of Qwen3-ASR 1.7B (2.3 GB): a smaller download, a few more mistakes.',
    });
    // Not where the files aren't published (the choice would change nothing).
    expect(smallerSpeechCopy(createBuiltinRegistry())).toBeNull();
  });

  it('says why smaller models run, and offers the larger ones', () => {
    const r = published();
    const guess = resolveEngines('balanced', none, r, APPLE);
    expect(engineNames(guess, r)).toBe('Qwen3-ASR 0.6B and Gemma 4 E2B');
    expect(memoryFitCopy(guess, r)).toEqual({
      text: 'Using smaller models to fit this device’s graphics memory: Qwen3-ASR 0.6B and Gemma 4 E2B. Browsers don’t report graphics memory, so this is Murmur’s guess.',
      retry: true,
    });
    const recorded = resolveEngines('best', none, r, NVIDIA, { fit: { step: 1 } });
    expect(memoryFitCopy(recorded, r)?.text).toBe(
      'Using smaller models to fit this device’s graphics memory: Qwen3-ASR 1.7B and Gemma 4 E2B. Larger ones ran out of graphics memory here.',
    );
    // The largest models, or the smaller speech model by choice: nothing to say.
    expect(memoryFitCopy(resolveEngines('best', none, r, NVIDIA), r)).toBeNull();
    expect(
      memoryFitCopy(resolveEngines('balanced', none, r, NVIDIA, { smallerSpeech: true }), r),
    ).toBeNull();
  });

  it('profile cards describe the models honestly', () => {
    const all = JSON.stringify(PROFILE_COPY);
    // The engines come from what the profile resolves to here, not from fixed copy.
    expect(all).not.toMatch(/Whisper|Qwen|Gemma/);
    expect(PROFILE_COPY.balanced.tradeoff).toContain('smaller speech model');
    expect(PROFILE_COPY.balanced.tradeoff).toContain('graphics memory is short');
    expect(PROFILE_COPY.best.tradeoff).toContain('graphics memory is short');
  });
});
