/**
 * Errors engines throw that the host acts on (rather than just showing the message).
 *
 * - `EngineActionRequiredError`: the engine needs a step only the person can start (a click),
 *   e.g. downloading a Chrome language pack. The session reports the actions; a page runs them.
 * - `EngineUnavailableError`: the engine can't run here at all (API missing, on-device mode not
 *   offered). The host tries the engine's fallback (profiles.ts `RUNTIME_FALLBACKS`).
 * - `ModelError`: the engine's model isn't downloaded (`missing`) or didn't load. The session
 *   reports code `model`, and the popup points to the model manager.
 * - `CompanionError`: the engine needs the companion app, and it isn't answering. Code `companion`.
 * - `UnsupportedLanguageError`: the engine can't handle a line's language at all (not a pack to
 *   download). The session lists the language as one it can't translate.
 * - `OutOfMemoryError`: the engine ran out of graphics (or WebAssembly) memory while loading or
 *   warming up, or its graphics device was lost. The session steps down to smaller models
 *   (profiles.ts `LADDERS`, loading.ts `loadLadder`).
 *
 * Errors cross from the worker or offscreen document by message, so `name` is what's checked.
 */
import type { SetupAction } from './types';

export class EngineActionRequiredError extends Error {
  override readonly name = 'EngineActionRequiredError';
  constructor(
    readonly actions: SetupAction[],
    message = actions.map((a) => a.label).join('; '),
  ) {
    super(message);
  }
}

export class EngineUnavailableError extends Error {
  override readonly name = 'EngineUnavailableError';
}

export function isActionRequired(err: unknown): err is EngineActionRequiredError {
  return err instanceof Error && err.name === 'EngineActionRequiredError' && 'actions' in err;
}

export function isUnavailable(err: unknown): err is EngineUnavailableError {
  return err instanceof Error && err.name === 'EngineUnavailableError';
}

export class ModelError extends Error {
  override readonly name = 'ModelError';
  constructor(
    message: string,
    /** Model ids involved (`EngineModel.id`). */
    readonly models: string[] = [],
    /** True when the model simply isn't downloaded yet. */
    readonly missing = false,
  ) {
    super(message);
  }
}

export class CompanionError extends Error {
  override readonly name = 'CompanionError';
}

export class UnsupportedLanguageError extends Error {
  override readonly name = 'UnsupportedLanguageError';
  constructor(
    readonly language: string,
    message = `Can't handle ${language}.`,
  ) {
    super(message);
  }
}

export function isModelError(err: unknown): err is ModelError {
  return err instanceof Error && err.name === 'ModelError';
}

export function isCompanionError(err: unknown): err is CompanionError {
  return err instanceof Error && err.name === 'CompanionError';
}

export function isUnsupportedLanguage(err: unknown): err is UnsupportedLanguageError {
  return err instanceof Error && err.name === 'UnsupportedLanguageError' && 'language' in err;
}

export class OutOfMemoryError extends Error {
  override readonly name = 'OutOfMemoryError';
}

export function isOutOfMemory(err: unknown): err is OutOfMemoryError {
  return err instanceof Error && err.name === 'OutOfMemoryError';
}

/**
 * Whether an error message from a runtime (WebGPU, ONNX Runtime, LiteRT-LM, Emscripten, the
 * browser) says memory ran out or the graphics device was lost.
 */
export function looksLikeOutOfMemory(message: string): boolean {
  return OUT_OF_MEMORY.test(message);
}

const OUT_OF_MEMORY =
  /out[ -]?of[ -]?memory|\boom\b|allocation failed|(failed to|could not|cannot) allocate|bad_alloc|cannot enlarge memory|device (was |is |has been )?lost|devicelost|not enough memory|insufficient memory/i;
