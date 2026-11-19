/**
 * Gemma 4 E2B and E4B translating subtitles in the browser (LiteRT-LM.js on WebGPU), and their
 * static engine info.
 *
 * One file each, the `-web.litertlm` build from `litert-community` on Hugging Face at a pinned
 * commit, checked against its SHA-256 (files.json). Apache-2.0, ungated.
 *
 * Measured on Chrome 157, RTX 3070, three earlier lines as context:
 * - E2B: first token 142 ms (p90 166), 90 tokens/s, a line in 326 ms; about 1.2 GB of graphics
 *   memory. Next to Qwen3-ASR, the two peaked at 2.9–4.5 GB, depending on which loaded first.
 * - E4B: first token 431 ms, 62 tokens/s, a line in 714 ms; about 2.7 GB of graphics memory.
 *   Somewhat better translations, for three times the wait.
 * - Loading from the model cache: 6 s (E2B) and 10 s (E4B), shader warm-up included.
 * Not yet measured on Apple silicon or on graphics built into the processor.
 */
import type { ModelSource } from '@/models/hub';
import type { TranslationEngineInfo } from '../types';
import FILES from './files.json';

export const GEMMA_E2B_ID = 'gemma4-e2b';
export const GEMMA_E4B_ID = 'gemma4-e4b';
export type LlmEngineId = typeof GEMMA_E2B_ID | typeof GEMMA_E4B_ID;

/** `[path, bytes, hash]`. */
type FileList = [string, number, string][];

function source(id: LlmEngineId): ModelSource {
  const entry = FILES[id];
  return {
    repo: entry.repo,
    revision: entry.revision,
    files: (entry.files as FileList).map(([path, bytes, hash]) => ({ path, bytes, hash })),
  };
}

export const LLM_SOURCES: Record<LlmEngineId, ModelSource> = {
  [GEMMA_E2B_ID]: source(GEMMA_E2B_ID),
  [GEMMA_E4B_ID]: source(GEMMA_E4B_ID),
};

/** The model file each engine loads (its only one). */
export function modelFile(id: LlmEngineId) {
  return LLM_SOURCES[id].files[0] as ModelSource['files'][number];
}

const sizeMB = (id: LlmEngineId) =>
  Math.round(LLM_SOURCES[id].files.reduce((n, f) => n + f.bytes, 0) / 1e6);

/** The model's id in the model store. */
export const llmModelId = (id: LlmEngineId) => `${id}-webgpu`;

const common = {
  kind: 'translation',
  runtime: 'browser',
  inputs: ['text'],
  // Gemma 4 translates between many languages, and lines that mix them.
  sources: 'any',
  targets: 'any',
  streaming: true,
  usesContext: true,
  usesGlossary: true,
  // It rereads a line whose sentence the next line finishes.
  revises: true,
  license: 'Apache-2.0',
  homepage: 'https://huggingface.co/google/gemma-4-E2B-it',
} as const;

export const GEMMA_E2B_INFO: TranslationEngineInfo = {
  ...common,
  id: GEMMA_E2B_ID,
  label: 'Gemma 4 E2B',
  description:
    'A language model that translates each line with the lines before it, and keeps names from your glossary. 2.0 GB download.',
  requirements: {
    backends: ['webgpu'],
    minDeviceMemoryGB: 8,
    minGpuBufferMB: 512,
    // 1.16 GB measured. With Qwen3-ASR 0.6B: 2.9–4.5 GB together, depending on the order.
    minGpuMemoryMB: 1280,
    downloadMB: sizeMB(GEMMA_E2B_ID),
  },
  models: [
    {
      id: llmModelId(GEMMA_E2B_ID),
      label: 'Gemma 4 E2B, for translation',
      sizeMB: sizeMB(GEMMA_E2B_ID),
      source: LLM_SOURCES[GEMMA_E2B_ID],
    },
  ],
};

export const GEMMA_E4B_INFO: TranslationEngineInfo = {
  ...common,
  id: GEMMA_E4B_ID,
  label: 'Gemma 4 E4B',
  description:
    'A larger language model: somewhat better translations, slower, and it needs about 3 GB of graphics memory. 3.0 GB download.',
  requirements: {
    backends: ['webgpu'],
    minDeviceMemoryGB: 8,
    minGpuBufferMB: 1024,
    // 2.68 GB measured. With Qwen3-ASR 1.7B: 5.6 GB together at the peak.
    minGpuMemoryMB: 2816,
    downloadMB: sizeMB(GEMMA_E4B_ID),
  },
  models: [
    {
      id: llmModelId(GEMMA_E4B_ID),
      label: 'Gemma 4 E4B, for translation',
      sizeMB: sizeMB(GEMMA_E4B_ID),
      source: LLM_SOURCES[GEMMA_E4B_ID],
    },
  ],
  homepage: 'https://huggingface.co/google/gemma-4-E4B-it',
};
