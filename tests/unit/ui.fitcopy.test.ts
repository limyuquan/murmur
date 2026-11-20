/** What the options and welcome pages say about model sizes and graphics memory. */
import { describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from '@/engines/builtin';
import type { HardwareInfo } from '@/engines/hardware';
import { resolveEngines } from '@/engines/profiles';
import { EngineRegistry } from '@/engines/registry';
import { engineNames, memoryFitCopy, memoryText, smallerSpeechCopy } from '@/ui/fitcopy';
import { downloadText, fitWarning, PROFILE_COPY } from '@/ui/models';

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
      action: 'Try the larger models',
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

  it('says when larger models fell behind, or are too slow on this kind of graphics', () => {
    const r = published();
    const slow = resolveEngines('best', none, r, NVIDIA, { fit: { step: 1, cause: 'slow' } });
    expect(memoryFitCopy(slow, r)).toEqual({
      text: 'Using smaller models: Qwen3-ASR 1.7B and Gemma 4 E2B. Larger ones fell behind the speech here.',
      retry: true,
      action: 'Try the larger models',
    });
    const mac = resolveEngines('best', none, r, { ...APPLE, deviceMemoryGB: 16 });
    const copy = memoryFitCopy(mac, r);
    expect(copy?.action).toBe('Use Gemma 4 E4B anyway');
    expect(copy?.text).toMatch(
      /^Using Qwen3-ASR 1\.7B and Gemma 4 E2B\. Gemma 4 E4B translates a little better, but on graphics that share the computer’s memory, like Apple silicon, it is too slow for live subtitles/,
    );
  });

  it('shows the computer’s memory as reported', () => {
    expect(memoryText(null)).toBe('Unknown');
    expect(memoryText(4)).toBe('About 4 GB');
    // An older Chrome stopped at 8.
    expect(memoryText(8)).toBe('8 GB or more');
    expect(memoryText(16)).toBe('About 16 GB');
  });

  it('warns honestly about Best on graphics that share memory', () => {
    expect(fitWarning('best', { ...APPLE, deviceMemoryGB: 16 })).toMatch(
      /^On graphics that share the computer’s memory, Best starts with Balanced’s models/,
    );
    expect(fitWarning('best', NVIDIA)).toBeNull();
  });

  it('profile cards describe the models honestly', () => {
    const all = JSON.stringify(PROFILE_COPY);
    // The engines come from what the profile resolves to here, not from fixed copy.
    expect(all).not.toMatch(/Whisper|Qwen|Gemma/);
    // The smaller speech model is offered (ModelSizeOptions) only where this build has it.
    expect(all).not.toContain('smaller speech model');
    expect(all).not.toMatch(/companion/i);
    expect(PROFILE_COPY.balanced.tradeoff).toContain('graphics memory is short');
    expect(PROFILE_COPY.best.tradeoff).toContain('graphics memory is short');
  });

  it('gives the download by kind of model', () => {
    const model = (role: 'speech' | 'translation', sizeMB: number) =>
      ({ id: role, label: role, role, sizeMB, runtime: 'browser', source: {} }) as never;
    expect(downloadText([model('speech', 1611), model('translation', 2008)])).toBe(
      '3.6 GB: speech recognition 1.6 GB, translation 2.0 GB',
    );
    expect(downloadText([model('speech', 80)])).toBe('80 MB');
  });
});
