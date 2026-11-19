/**
 * The Whisper models Earshot runs in the browser (transformers.js, WebGPU with a WebAssembly
 * fallback), and their static engine info. Weights come from Hugging Face at a pinned revision
 * the first time the engine loads, and stay in the Cache API (`transformers-cache`).
 *
 * Measured with transformers.js 4.3.2 on Chrome 157, RTX 3070 (12 s clips, warm): base on WebGPU
 * (fp32 encoder, q4 decoder) real-time factor 0.06–0.09, on WebAssembly q8 with 6 threads 0.5–0.6;
 * large-v3-turbo on WebGPU (fp16 encoder, q4 decoder) 0.10–0.15. The first WebGPU decode compiles
 * shaders (up to ~26 s for base), so the engine warms up while loading.
 */
import type { AsrEngineInfo } from '../types';

export type WhisperId = 'whisper-base' | 'whisper-large-v3-turbo';

/** transformers.js weight formats Earshot uses. */
export type WeightFormat = 'fp32' | 'fp16' | 'q8' | 'q4';

/** transformers.js `dtype`: one per ONNX file. */
export type WhisperDtype = Record<'encoder_model' | 'decoder_model_merged', WeightFormat>;

export interface WhisperModel {
  id: WhisperId;
  repo: string;
  /** Hugging Face commit, so every install gets the same files. */
  revision: string;
  webgpu: { dtype: WhisperDtype; downloadMB: number } | null;
  wasm: { dtype: WhisperDtype; downloadMB: number } | null;
}

export const WHISPER_MODELS: Record<WhisperId, WhisperModel> = {
  'whisper-base': {
    id: 'whisper-base',
    repo: 'onnx-community/whisper-base',
    revision: '27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c',
    webgpu: { dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, downloadMB: 210 },
    wasm: { dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, downloadMB: 80 },
  },
  'whisper-large-v3-turbo': {
    id: 'whisper-large-v3-turbo',
    repo: 'onnx-community/whisper-large-v3-turbo',
    revision: '360ebcde2559d60bb474678be3c1de9ef347d01a',
    webgpu: { dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' }, downloadMB: 1610 },
    // About 10× slower than real time on a CPU: not offered without WebGPU.
    wasm: null,
  },
};

const COMMON = {
  kind: 'asr',
  runtime: 'browser',
  languages: 'any',
  streaming: true,
  detectsLanguage: true,
  // Detects one language per segment; segments are short, so a switch lands on a boundary.
  codeSwitching: false,
  license: 'MIT',
  homepage: 'https://github.com/openai/whisper',
} as const;

export const WHISPER_BASE_INFO: AsrEngineInfo = {
  ...COMMON,
  id: 'whisper-base',
  label: 'Whisper base',
  description:
    'Small and quick. Runs on most computers, on the graphics card or the processor. Less accurate.',
  requirements: { backends: ['webgpu', 'wasm'], downloadMB: 210 },
};

export const WHISPER_TURBO_INFO: AsrEngineInfo = {
  ...COMMON,
  id: 'whisper-large-v3-turbo',
  label: 'Whisper large v3 turbo',
  description: 'Accurate speech recognition on the graphics card. 1.6 GB download.',
  requirements: {
    backends: ['webgpu'],
    shaderF16: true,
    minGpuBufferMB: 1024,
    minDeviceMemoryGB: 8,
    downloadMB: 1610,
  },
};
