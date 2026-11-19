/** Messages between the Whisper engine (offscreen document) and its worker. */
import type { WhisperDtype } from './info';

export type WhisperDevice = 'webgpu' | 'wasm';

export type ToWorker =
  | {
      type: 'load';
      repo: string;
      revision: string;
      /** Tried in order; the first that loads and warms up wins. */
      devices: { device: WhisperDevice; dtype: WhisperDtype }[];
    }
  | {
      type: 'decode';
      id: number;
      samples: Float32Array;
      /** Restrict language detection to these (Whisper codes, e.g. `ko`), or null for any. */
      languages: string[] | null;
    };

export interface DecodeOutput {
  id: number;
  text: string;
  /** Whisper's language code for the segment (`ko`, `ja`, `zh`, ...). */
  language: string;
  /** Probability of `language` among the allowed languages. */
  languageProb: number;
  noSpeechProb: number;
  avgLogprob: number;
  tokens: number;
  ms: number;
}

export type FromWorker =
  | {
      type: 'progress';
      stage: 'download' | 'compile' | 'warmup';
      fraction: number | null;
      file?: string;
    }
  | { type: 'ready'; device: WhisperDevice; loadMs: number; warmupMs: number }
  | { type: 'result'; output: DecodeOutput }
  | { type: 'error'; id: number | null; message: string };
