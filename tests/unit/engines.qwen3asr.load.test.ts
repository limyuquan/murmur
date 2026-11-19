import { describe, expect, it, vi } from 'vitest';

const events: string[] = [];

vi.mock('onnxruntime-web/webgpu', () => ({
  InferenceSession: {
    create: async (model: Uint8Array) => {
      events.push(`session ${new TextDecoder().decode(model)}`);
      return {};
    },
  },
  Tensor: class {},
}));

const { Qwen3Asr } = await import('@/engines/qwen3asr/model');
const { QWEN3_FILES } = await import('@/engines/qwen3asr/info');

describe('Qwen3Asr.load', () => {
  it('makes the encoder’s session before it reads the decoder’s files', async () => {
    const files: Record<string, string> = {
      [QWEN3_FILES.vocab]: '{"a":0}',
      [QWEN3_FILES.addedTokens]: '{}',
      [QWEN3_FILES.tied]: '{"q8":{"offset":0,"length":4},"scales":{"offset":4,"length":4}}',
      [QWEN3_FILES.encoder]: 'encoder',
      [QWEN3_FILES.encoderData]: 'encoder data',
      [QWEN3_FILES.decoder]: 'decoder',
      [QWEN3_FILES.decoderData]: 'decoder data',
    };
    const progress: number[] = [];
    await Qwen3Asr.load(
      async (path) => {
        events.push(`read ${path.split('/').pop()}`);
        return new TextEncoder().encode(files[path] ?? '');
      },
      (fraction) => progress.push(fraction),
    );
    const at = (e: string) => events.indexOf(e);
    expect(at('session encoder')).toBeGreaterThan(at('read audio_encoder_fp16.onnx_data'));
    expect(at('session encoder')).toBeLessThan(at('read decoder_model_merged_q8.onnx'));
    expect(at('session decoder')).toBeGreaterThan(at('read decoder_model_merged_q8.onnx_data'));
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBe(1);
  });
});
