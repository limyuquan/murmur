/**
 * Qwen3-ASR in the browser (ONNX Runtime Web on WebGPU), and the static info of its two sizes.
 * Both use the same code (model.ts) and the same graphs (SubtitleKing's export: an audio encoder
 * and a merged decoder with fused attention), each at its own width.
 *
 * - 0.6B (Balanced): SubtitleKing's fp16 audio encoder (`upstream`), and our decoder, re-quantized
 *   to 8 bits from the same export and the official weights (every 4-bit build tested lost
 *   0.5–2.3 points of accuracy). Chrome 157, RTX 3070: median real-time factor 0.083 for
 *   segments up to 15 s (≈70 ms + 19 ms per token), load 2–4 s from the model cache, about 1.3 GB
 *   of GPU memory.
 * - 1.7B (Best): the same, with the encoder's weights at 8 bits too (same accuracy as fp16, 0.3 GB
 *   less). As fast per token (≈19 ms: the time goes to per-step overhead, not weights), about
 *   2.4 GB of GPU memory (3.2 GB at the peak), 5.6 GB next to Gemma 4 E4B. Accuracy on the
 *   benchmark set: Korean CER 3.1 % (0.6B: 4.5 %), code-switched speech 4.5 % (6.6 %).
 *
 * Our files (group `murmur`) are hosted at `MURMUR_MODELS` (models/hub.ts): the 0.6B's at the
 * repo's root, the 1.7B's under `qwen3-asr-1.7b/`; the tokenizer's vocabulary is the same file for
 * both. WebGPU with 16-bit float shaders only: on WebAssembly it is 10× slower than real time.
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
export const QWEN3_ASR_17B_ID = 'qwen3-asr-1.7b';
export const QWEN3_ASR_17B_MODEL_ID = `${QWEN3_ASR_17B_ID}-webgpu`;
export type Qwen3AsrId = typeof QWEN3_ASR_ID | typeof QWEN3_ASR_17B_ID;

/** `[path, bytes, hash]`. */
type FileList = [string, number, string][];
interface FileGroups {
  upstream?: { repo: string; revision: string; files: FileList };
  murmur: { files: FileList };
}

const toFiles = (list: FileList, from?: { repo: string; revision: string }) =>
  list.map(([path, bytes, hash]) => ({ path, bytes, hash, ...(from ? { from } : {}) }));

/** Every file a size reads, each from its own repo and commit. */
function source(groups: FileGroups): ModelSource {
  const { upstream } = groups;
  return {
    ...MURMUR_MODELS,
    files: [
      ...(upstream
        ? toFiles(upstream.files, { repo: upstream.repo, revision: upstream.revision })
        : []),
      ...toFiles(groups.murmur.files),
    ],
  };
}

/** Where each of a size's files is in its source. */
export interface Qwen3Files {
  encoder: string;
  encoderData: string;
  decoder: string;
  decoderData: string;
  tied: string;
  vocab: string;
  addedTokens: string;
}

/** What the engine, its worker and the model need to know about one size. */
export interface Qwen3Model {
  id: Qwen3AsrId;
  /** The model's id in the model manager. */
  modelId: string;
  source: ModelSource;
  files: Qwen3Files;
  /** The decoder's width (the encoder's output and the token embeddings). */
  hidden: number;
}

const decoderFiles = (dir: string, encoder: string) => ({
  encoder: `${dir}onnx/${encoder}.onnx`,
  encoderData: `${dir}onnx/${encoder}.onnx_data`,
  decoder: `${dir}onnx/decoder_model_merged_q8.onnx`,
  decoderData: `${dir}onnx/decoder_model_merged_q8.onnx_data`,
  tied: `${dir}onnx/decoder_model_merged_q8.tied.json`,
  vocab: 'vocab.json',
  addedTokens: 'added_tokens.json',
});

export const QWEN3_MODELS: Record<Qwen3AsrId, Qwen3Model> = {
  [QWEN3_ASR_ID]: {
    id: QWEN3_ASR_ID,
    modelId: QWEN3_ASR_MODEL_ID,
    source: source(FILES[QWEN3_ASR_ID] as FileGroups),
    files: decoderFiles('', 'audio_encoder_fp16'),
    hidden: 1024,
  },
  [QWEN3_ASR_17B_ID]: {
    id: QWEN3_ASR_17B_ID,
    modelId: QWEN3_ASR_17B_MODEL_ID,
    source: source(FILES[QWEN3_ASR_17B_ID] as FileGroups),
    files: decoderFiles(`${QWEN3_ASR_17B_ID}/`, 'audio_encoder_q8'),
    hidden: 2048,
  },
};

/** The 0.6B's files (QWEN3_MODELS has both sizes). */
export const QWEN3_ASR_SOURCE = QWEN3_MODELS[QWEN3_ASR_ID].source;
export const QWEN3_FILES = QWEN3_MODELS[QWEN3_ASR_ID].files;

const downloadMB = (id: Qwen3AsrId) =>
  Math.round(QWEN3_MODELS[id].source.files.reduce((n, f) => n + f.bytes, 0) / 1e6);

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

/** What both sizes share. */
const common = {
  kind: 'asr',
  runtime: 'browser',
  ...(unavailable ? { unavailable } : {}),
  languages: QWEN3_LANGUAGES,
  streaming: true,
  detectsLanguage: true,
  // One language per segment, detected for each; a switch lands on a segment boundary.
  codeSwitching: false,
  license: 'Apache-2.0',
  homepage: 'https://github.com/QwenLM/Qwen3-ASR',
} as const;

export const QWEN3_ASR_INFO: AsrEngineInfo = {
  ...common,
  id: QWEN3_ASR_ID,
  label: 'Qwen3-ASR 0.6B',
  description:
    'Accurate speech recognition on the graphics card that follows language switches. 1.1 GB download.',
  requirements: {
    backends: ['webgpu'],
    shaderF16: true,
    // The largest single weight is 156 MB.
    minGpuBufferMB: 256,
    minDeviceMemoryGB: 8,
    // 1.3 GB after load and warm-up; 2.0 GB at the peak on 26 s clips (segments are ≤ 5 s).
    minGpuMemoryMB: 1536,
    downloadMB: downloadMB(QWEN3_ASR_ID),
  },
  models: [
    {
      id: QWEN3_ASR_MODEL_ID,
      label: 'Qwen3-ASR 0.6B, for the graphics card',
      sizeMB: downloadMB(QWEN3_ASR_ID),
      source: QWEN3_MODELS[QWEN3_ASR_ID].source,
    },
  ],
};

export const QWEN3_ASR_17B_INFO: AsrEngineInfo = {
  ...common,
  id: QWEN3_ASR_17B_ID,
  label: 'Qwen3-ASR 1.7B',
  description:
    'The most accurate speech recognition on the graphics card, and it follows language switches. Needs about 3 GB of graphics memory. 2.3 GB download.',
  requirements: {
    backends: ['webgpu'],
    shaderF16: true,
    // The largest single weight is 311 MB.
    minGpuBufferMB: 512,
    minDeviceMemoryGB: 8,
    // 2.4 GB after load and warm-up, 3.15 GB at the peak on 26 s clips; 2.7 GB in a session
    // (5.4 GB with Gemma 4 E4B, 5.6 GB at the peak).
    minGpuMemoryMB: 3072,
    downloadMB: downloadMB(QWEN3_ASR_17B_ID),
  },
  models: [
    {
      id: QWEN3_ASR_17B_MODEL_ID,
      label: 'Qwen3-ASR 1.7B, for the graphics card',
      sizeMB: downloadMB(QWEN3_ASR_17B_ID),
      source: QWEN3_MODELS[QWEN3_ASR_17B_ID].source,
    },
  ],
};

/** Each size's static info, by engine id. */
export const QWEN3_INFOS: Record<Qwen3AsrId, AsrEngineInfo> = {
  [QWEN3_ASR_ID]: QWEN3_ASR_INFO,
  [QWEN3_ASR_17B_ID]: QWEN3_ASR_17B_INFO,
};
