/**
 * Errors engines throw that the host acts on (rather than just showing the message).
 *
 * - `EngineActionRequiredError`: the engine needs a step only the person can start (a click),
 *   e.g. downloading a Chrome language pack. The session reports the actions; a page runs them.
 * - `EngineUnavailableError`: the engine can't run here at all (API missing, on-device mode not
 *   offered). The host tries the engine's fallback (profiles.ts `RUNTIME_FALLBACKS`).
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
