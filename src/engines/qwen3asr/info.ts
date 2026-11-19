/**
 * Qwen3-ASR-0.6B in the browser (ONNX Runtime Web on WebGPU), and its static engine info.
 *
 * The files (files.json) come from two places, each pinned:
 * - the fp16 audio encoder, from SubtitleKing's ONNX export (`upstream`);
 * - the decoder, re-quantized by us to 8 bits from the same export and the official weights
 *   (every 4-bit build tested lost 0.5–2.3 points of accuracy), its tied-embedding offsets, and
 *   the tokenizer's vocabulary (`murmur`, hosted at `MURMUR_MODELS` in models/hub.ts).
 *
 * Measured on Chrome 157, RTX 3070: median real-time factor 0.083 for segments up to 15 s
 * (≈70 ms + 19 ms per token), load 2–4 s from the model cache, about 1.3 GB of GPU memory.
 * WebGPU with 16-bit float shaders only: on WebAssembly it is 10× slower than real time.
 */
import {
  HUGGING_FACE,
  isPublished,
  MODEL_HOST,
  type ModelSource,
  MURMUR_MODELS,
} from '@/models/hub';
import type { AsrEngineInfo } from '../types';
import FILES from './files.json';

export const QWEN3_ASR_ID = 'qwen3-asr-0.6b';
export const QWEN3_ASR_MODEL_ID = `${QWEN3_ASR_ID}-webgpu`;

/** `[path, bytes, hash]`. */
type FileList = [string, number, string][];

const toFiles = (list: FileList, from?: { repo: string; revision: string }) =>
  list.map(([path, bytes, hash]) => ({ path, bytes, hash, ...(from ? { from } : {}) }));

/** Every file the engine reads, each from its own repo and commit. */
export const QWEN3_ASR_SOURCE: ModelSource = {
  ...MURMUR_MODELS,
  files: [
    ...toFiles(FILES.upstream.files as FileList, {
      repo: FILES.upstream.repo,
      revision: FILES.upstream.revision,
    }),
    ...toFiles(FILES.murmur.files as FileList),
  ],
};

/** Paths in QWEN3_ASR_SOURCE. */
export const QWEN3_FILES = {
  encoder: 'onnx/audio_encoder_fp16.onnx',
  encoderData: 'onnx/audio_encoder_fp16.onnx_data',
  decoder: 'onnx/decoder_model_merged_q8.onnx',
  decoderData: 'onnx/decoder_model_merged_q8.onnx_data',
  tied: 'onnx/decoder_model_merged_q8.tied.json',
  vocab: 'vocab.json',
  addedTokens: 'added_tokens.json',
} as const;

const DOWNLOAD_MB = Math.round(QWEN3_ASR_SOURCE.files.reduce((n, f) => n + f.bytes, 0) / 1e6);

/**
 * Why the engine can't be offered, or undefined: our files aren't on Hugging Face yet, and this
 * build downloads from there (`host`, models/hub.ts MODEL_HOST).
 */
export function qwen3Unavailable(host = MODEL_HOST): string | undefined {
  return !isPublished(MURMUR_MODELS) && host === HUGGING_FACE
    ? 'model files not published yet'
    : undefined;
}

/** The languages the model knows, as BCP-47 primary tags (its 30, in its own order). */
export const QWEN3_LANGUAGES = [
  'zh',
  'en',
  'yue',
  'ar',
  'de',
  'fr',
  'es',
  'pt',
  'id',
  'it',
  'ko',
  'ru',
  'th',
  'vi',
  'ja',
  'tr',
  'hi',
  'ms',
  'nl',
  'sv',
  'da',
  'fi',
  'pl',
  'cs',
  'fil',
  'fa',
  'el',
  'ro',
  'hu',
  'mk',
] as const;

const unavailable = qwen3Unavailable();

export const QWEN3_ASR_INFO: AsrEngineInfo = {
  kind: 'asr',
  id: QWEN3_ASR_ID,
  label: 'Qwen3-ASR 0.6B',
  description:
    'Accurate speech recognition on the graphics card that follows language switches. 1.1 GB download.',
  runtime: 'browser',
  requirements: {
    backends: ['webgpu'],
    shaderF16: true,
    // The largest single weight is 156 MB; the whole model needs about 1.3 GB of GPU memory.
    minGpuBufferMB: 256,
    minDeviceMemoryGB: 8,
    downloadMB: DOWNLOAD_MB,
  },
  ...(unavailable ? { unavailable } : {}),
  models: [
    {
      id: QWEN3_ASR_MODEL_ID,
      label: 'Qwen3-ASR 0.6B, for the graphics card',
      sizeMB: DOWNLOAD_MB,
      source: QWEN3_ASR_SOURCE,
    },
  ],
  languages: QWEN3_LANGUAGES,
  streaming: true,
  detectsLanguage: true,
  // One language per segment, detected for each; a switch lands on a segment boundary.
  codeSwitching: false,
  license: 'Apache-2.0',
  homepage: 'https://github.com/QwenLM/Qwen3-ASR',
};
