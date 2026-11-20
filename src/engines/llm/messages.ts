/** Messages between the LLM translation engine (offscreen document) and its worker. */
import type { ModelSource } from '@/models/hub';
import type { SimulatedFailure } from '../types';

export type ToWorker =
  | {
      type: 'load';
      /** Already in the model cache: the worker never downloads. */
      source: ModelSource;
      /** The model file's path in `source`. */
      file: string;
      /** The extension's folder with LiteRT-LM's WebAssembly (its `.js` glue and `.wasm`). */
      wasmBase: string;
      /** Prompt and answer together, tokens, at most. */
      maxNumTokens: number;
      /** A short generation run while loading, so the first real line isn't slow. */
      warmup: { system: string; user: string };
      /** Fail as if out of graphics memory at this point (e2e checks). */
      simulateOutOfMemory?: SimulatedFailure;
    }
  | { type: 'generate'; id: number; system: string; user: string; maxTokens: number }
  /** Stops a generation; it then ends with `done` (`cancelled: true`). */
  | { type: 'cancel'; id: number };

export interface GenerationStats {
  /** From the request to the first text, ms (null: no text). */
  firstTokenMs: number | null;
  totalMs: number;
  promptTokens: number | null;
  outputTokens: number | null;
}

export type FromWorker =
  | {
      type: 'progress';
      stage: 'download' | 'compile' | 'warmup';
      fraction: number | null;
      file?: string;
    }
  | { type: 'ready'; loadMs: number; warmupMs: number }
  /** More of the answer: `text` is what was added. */
  | { type: 'token'; id: number; text: string }
  | { type: 'done'; id: number; text: string; cancelled: boolean; stats: GenerationStats }
  | {
      type: 'error';
      id: number | null;
      message: string;
      unavailable?: boolean;
      /** Graphics (or WebAssembly) memory ran out, or the device was lost. */
      memory?: boolean;
      /** With `memory`: only the device was lost (errors.ts `OutOfMemoryError.lostOnly`). */
      lost?: boolean;
    };
