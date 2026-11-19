/**
 * The Whisper models Murmur runs in the browser (transformers.js, WebGPU with a WebAssembly
 * fallback), and their static engine info. Weights come from Hugging Face at a pinned revision,
 * downloaded when the person asks (models/store.ts), one set per backend: the WebGPU and
 * WebAssembly builds use different weight formats.
 *
 * Measured with transformers.js 4.3.2 on Chrome 157, RTX 3070 (12 s clips, warm): base on WebGPU
 * (fp32 encoder, q4 decoder) real-time factor 0.06–0.09, on WebAssembly q8 with 6 threads 0.5–0.6;
 * large-v3-turbo on WebGPU (fp16 encoder, q4 decoder) 0.10–0.15. The first WebGPU decode compiles
 * shaders (up to ~26 s for base), so the engine warms up while loading.
 */
import type { ModelSource } from '@/models/hub';
import type { AsrEngineInfo, EngineModel } from '../types';
import FILES from './files.json';

export type WhisperId = 'whisper-base' | 'whisper-large-v3-turbo';

/** transformers.js weight formats Murmur uses. */
export type WeightFormat = 'fp32' | 'fp16' | 'q8' | 'q4';

/** transformers.js `dtype`: one per ONNX file. */
export type WhisperDtype = Record<'encoder_model' | 'decoder_model_merged', WeightFormat>;

export interface WhisperModel {
  id: WhisperId;
  repo: string;
  /** Hugging Face commit, so every install gets the same files. */
  revision: string;
  /** Weight formats and download, per backend; null where it doesn't run. */
  webgpu: WhisperVariant | null;
  wasm: WhisperVariant | null;
}

export interface WhisperVariant {
  dtype: WhisperDtype;
  /** The files transformers.js reads for this dtype (files.json, sizes from the Hub). */
  source: ModelSource;
  downloadMB: number;
}

type FileList = [string, number][];

function variant(id: WhisperId, backend: 'webgpu' | 'wasm', dtype: WhisperDtype) {
  const entry = FILES[id] as { repo: string; revision: string; shared: FileList } & Record<
    'webgpu' | 'wasm',
    FileList | null
  >;
  const own = entry[backend];
  if (!own) return null;
  const files = [...entry.shared, ...own].map(([path, bytes]) => ({ path, bytes }));
  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  return {
    dtype,
    source: { repo: entry.repo, revision: entry.revision, files },
    downloadMB: Math.round(bytes / 1e6),
  } satisfies WhisperVariant;
}

const model = (id: WhisperId, webgpu: WhisperDtype, wasm: WhisperDtype | null): WhisperModel => ({
  id,
  repo: FILES[id].repo,
  revision: FILES[id].revision,
  webgpu: variant(id, 'webgpu', webgpu),
  wasm: wasm ? variant(id, 'wasm', wasm) : null,
});

export const WHISPER_MODELS: Record<WhisperId, WhisperModel> = {
  'whisper-base': model(
    'whisper-base',
    { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    { encoder_model: 'q8', decoder_model_merged: 'q8' },
  ),
  // About 10× slower than real time on a CPU: not offered without WebGPU.
  'whisper-large-v3-turbo': model(
    'whisper-large-v3-turbo',
    { encoder_model: 'fp16', decoder_model_merged: 'q4' },
    null,
  ),
};

/** The model's downloads, one per backend it runs on. */
function engineModels(m: WhisperModel, label: string): EngineModel[] {
  const out: EngineModel[] = [];
  if (m.webgpu) {
    out.push({
      id: `${m.id}-webgpu`,
      label: `${label}, for the graphics card`,
      sizeMB: m.webgpu.downloadMB,
      backend: 'webgpu',
      source: m.webgpu.source,
    });
  }
  if (m.wasm) {
    out.push({
      id: `${m.id}-wasm`,
      label: `${label}, for the processor`,
      sizeMB: m.wasm.downloadMB,
      backend: 'wasm',
      source: m.wasm.source,
    });
  }
  return out;
}

/** Languages Whisper transcribes (its language tokens, as BCP-47 primary tags). */
export const WHISPER_LANGUAGES = [
  'af',
  'am',
  'ar',
  'as',
  'az',
  'ba',
  'be',
  'bg',
  'bn',
  'bo',
  'br',
  'bs',
  'ca',
  'cs',
  'cy',
  'da',
  'de',
  'el',
  'en',
  'es',
  'et',
  'eu',
  'fa',
  'fi',
  'fo',
  'fr',
  'gl',
  'gu',
  'ha',
  'haw',
  'he',
  'hi',
  'hr',
  'ht',
  'hu',
  'hy',
  'id',
  'is',
  'it',
  'ja',
  'jv',
  'ka',
  'kk',
  'km',
  'kn',
  'ko',
  'la',
  'lb',
  'ln',
  'lo',
  'lt',
  'lv',
  'mg',
  'mi',
  'mk',
  'ml',
  'mn',
  'mr',
  'ms',
  'mt',
  'my',
  'ne',
  'nl',
  'nn',
  'no',
  'oc',
  'pa',
  'pl',
  'ps',
  'pt',
  'ro',
  'ru',
  'sa',
  'sd',
  'si',
  'sk',
  'sl',
  'sn',
  'so',
  'sq',
  'sr',
  'su',
  'sv',
  'sw',
  'ta',
  'te',
  'tg',
  'th',
  'tk',
  'tl',
  'tr',
  'tt',
  'uk',
  'ur',
  'uz',
  'vi',
  'yi',
  'yo',
  'zh',
] as const;

const COMMON = {
  kind: 'asr',
  runtime: 'browser',
  languages: WHISPER_LANGUAGES,
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
  requirements: {
    backends: ['webgpu', 'wasm'],
    downloadMB: WHISPER_MODELS['whisper-base'].wasm?.downloadMB ?? 0,
  },
  models: engineModels(WHISPER_MODELS['whisper-base'], 'Whisper base'),
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
    downloadMB: WHISPER_MODELS['whisper-large-v3-turbo'].webgpu?.downloadMB ?? 0,
  },
  // Large v3 also knows Cantonese.
  languages: [...WHISPER_LANGUAGES, 'yue'],
  models: engineModels(WHISPER_MODELS['whisper-large-v3-turbo'], 'Whisper large v3 turbo'),
};
