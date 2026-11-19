/** Messages between the Qwen3-ASR engine (offscreen document) and its worker. */
import type { Qwen3Model } from './info';

export type ToWorker =
  | {
      type: 'load';
      /** Its files are already in the model cache: the worker never downloads. */
      model: Qwen3Model;
    }
  | {
      type: 'decode';
      id: number;
      samples: Float32Array;
      /** Pick each segment's language among these (the model's tags), or null for any. */
      languages: string[] | null;
      /** Answer tokens to force first (a rollback prefix from the last partial), or null. */
      prefix: number[] | null;
    };

export interface DecodeOutput {
  id: number;
  text: string;
  /** The segment's language tag, or `und` when the model heard no speech. */
  language: string;
  /** Probability of `language` among the allowed languages (1 when it came from a prefix). */
  languageProb: number;
  /** The model's own probability that there is no speech (its ` None` answer). */
  noSpeechProb: number;
  avgLogprob: number;
  /** The whole answer, for the next partial's prefix. */
  ids: number[];
  /** Tokens decoded (prefix not counted). */
  tokens: number;
  /** Decoding stopped on a repetition loop. */
  looped: boolean;
  ms: number;
}

export type FromWorker =
  | {
      type: 'progress';
      stage: 'download' | 'compile' | 'warmup';
      fraction: number | null;
      file?: string;
    }
  | { type: 'ready'; loadMs: number; warmupMs: number }
  | { type: 'result'; output: DecodeOutput }
  | { type: 'error'; id: number | null; message: string; unavailable?: boolean };
