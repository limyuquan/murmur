/**
 * Which step of each profile's memory ladder (engines/profiles.ts `LADDERS`) to start at on this
 * device, in `chrome.storage.local` under `MEMORY_FIT_KEY`, per graphics card (`gpuKey`), for the
 * ladder it was made on (`ladder`: the engines of every step, `ladderId`; a record made on other
 * engines doesn't apply).
 *
 * - Running out of graphics memory: the session steps down, and the next session starts at the
 *   step it reached instead of failing the same way again. That holds.
 * - Falling behind the speech (engines/slowness.ts) is weaker evidence (another program can have
 *   the graphics card for a while): one session that falls behind is only noted (a strike, under
 *   `SLOW_STRIKES_KEY`); a second, at the same step within `STRIKE_MS`, steps down one step. That
 *   step down never leaves the ladder and moves back up with time (profiles.ts `SLOW_FIT_MS`).
 * - "Try the larger models" (options page) sets the step back to the top; a session already
 *   running when the person chose it doesn't overwrite that (background/session.ts).
 *
 * Written by the service worker (the offscreen document has no storage access: it reports a step
 * down as a `memory-fit` event) and by the options page.
 */
import { browser } from 'wxt/browser';
import { gpuKey, type HardwareInfo } from '@/engines/hardware';
import type { FitCause, ProfileChoice, ProfileId, ResolveOptions } from '@/engines/profiles';
import type { Settings } from './settings';

export const MEMORY_FIT_KEY = 'memoryFit';

export const SLOW_STRIKES_KEY = 'slowStrikes';

/** How long a session that fell behind counts towards a step down for slowness. */
export const STRIKE_MS = 14 * 24 * 60 * 60 * 1000;

export interface MemoryFitRecord {
  /** The ladder the step is on (`ladderId`, as resolved on this device). */
  ladder: string;
  /** The ladder step to start at (`LADDERS[profile]` index; its length: below the last step). */
  step: number;
  /** When it was recorded, epoch ms. */
  at: number;
  /**
   * Why the session stepped down to it: an engine ran out of memory, or the models kept falling
   * behind (`slow`). None: the person chose it (options page).
   */
  cause?: FitCause;
  /**
   * The engine that ran out of memory or fell behind, and what happened (none: set from the
   * options page).
   */
  engine?: string;
  message?: string;
}

/** Records by graphics card, then profile. */
export type MemoryFit = Record<string, Partial<Record<ProfileId, MemoryFitRecord>>>;

/** Most graphics cards kept (a laptop with an external card, a changed card). */
const MAX_GPUS = 8;

/** The valid part of what is stored. */
export function cleanMemoryFit(stored: unknown): MemoryFit {
  const out: MemoryFit = {};
  if (!isObject(stored)) return out;
  for (const [gpu, profiles] of Object.entries(stored).slice(-MAX_GPUS)) {
    if (!isObject(profiles)) continue;
    const kept: Partial<Record<ProfileId, MemoryFitRecord>> = {};
    for (const profile of ['light', 'balanced', 'best'] as const) {
      const r = profiles[profile];
      if (!isObject(r) || !Number.isInteger(r.step) || (r.step as number) < 0) continue;
      // Made before records named their ladder: it may describe other engines.
      if (typeof r.ladder !== 'string') continue;
      kept[profile] = {
        ladder: r.ladder.slice(0, 1000),
        step: r.step as number,
        at: typeof r.at === 'number' ? r.at : 0,
        ...(r.cause === 'memory' || r.cause === 'slow' ? { cause: r.cause } : {}),
        ...(typeof r.engine === 'string' ? { engine: r.engine } : {}),
        ...(typeof r.message === 'string' ? { message: r.message.slice(0, 300) } : {}),
      };
    }
    out[gpu] = kept;
  }
  return out;
}

/** This card's record for `profile`, or null. */
export function fitFor(fit: MemoryFit, gpu: string, profile: ProfileId): MemoryFitRecord | null {
  return fit[gpu]?.[profile] ?? null;
}

/**
 * What a profile resolves with on this device beyond the settings' engines: the step of its
 * memory ladder that last worked here, and the smaller speech model.
 */
export function resolveOptions(
  settings: Pick<Settings, 'smallerSpeech'>,
  profile: ProfileChoice,
  hardware: HardwareInfo,
  fit: MemoryFit | null,
): ResolveOptions {
  return {
    fit: profile === 'custom' || !fit ? null : fitFor(fit, gpuKey(hardware), profile),
    smallerSpeech: settings.smallerSpeech,
  };
}

/** `fit` with `record` for `gpu` and `profile` (the newest card last). */
export function withFit(
  fit: MemoryFit,
  gpu: string,
  profile: ProfileId,
  record: MemoryFitRecord,
): MemoryFit {
  const { [gpu]: current, ...others } = fit;
  return { ...others, [gpu]: { ...current, [profile]: record } };
}

export async function loadMemoryFit(): Promise<MemoryFit> {
  const stored = await browser.storage.local.get(MEMORY_FIT_KEY);
  return cleanMemoryFit(stored[MEMORY_FIT_KEY]);
}

/** Records `record` for `gpu` and `profile`. */
export async function saveMemoryFit(
  gpu: string,
  profile: ProfileId,
  record: MemoryFitRecord,
): Promise<void> {
  const next = withFit(await loadMemoryFit(), gpu, profile, record);
  await browser.storage.local.set({ [MEMORY_FIT_KEY]: next });
}

/** Calls `listener` with the records whenever they change. Returns an unsubscribe. */
export function watchMemoryFit(listener: (fit: MemoryFit) => void): () => void {
  const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string): void => {
    const change = changes[MEMORY_FIT_KEY];
    if (area === 'local' && change) listener(cleanMemoryFit(change.newValue));
  };
  browser.storage.onChanged.addListener(onChanged);
  return () => browser.storage.onChanged.removeListener(onChanged);
}

/** A session that fell behind at `step` of `ladder`, at `at` (one strike). */
export interface SlowStrike {
  ladder: string;
  step: number;
  at: number;
}

export type SlowStrikes = Record<string, Partial<Record<ProfileId, SlowStrike>>>;

/**
 * What a session that fell behind at step `from` of `ladder` leaves: a strike when there is no
 * recent one at the same step (`record: false`), else a step down to `to` (`record: true`, and
 * the strike is used up).
 */
export function afterSlowSession(
  strike: SlowStrike | null,
  event: { ladder: string; from: number },
  now: number,
): { record: boolean; strike: SlowStrike | null } {
  const counts =
    strike !== null &&
    strike.ladder === event.ladder &&
    strike.step === event.from &&
    now - strike.at >= 0 &&
    now - strike.at <= STRIKE_MS;
  if (counts) return { record: true, strike: null };
  return { record: false, strike: { ladder: event.ladder, step: event.from, at: now } };
}

export async function loadSlowStrikes(): Promise<SlowStrikes> {
  const stored = (await browser.storage.local.get(SLOW_STRIKES_KEY))[SLOW_STRIKES_KEY];
  const out: SlowStrikes = {};
  if (!isObject(stored)) return out;
  for (const [gpu, profiles] of Object.entries(stored).slice(-MAX_GPUS)) {
    if (!isObject(profiles)) continue;
    const kept: Partial<Record<ProfileId, SlowStrike>> = {};
    for (const profile of ['balanced', 'best'] as const) {
      const r = profiles[profile];
      if (!isObject(r) || typeof r.ladder !== 'string') continue;
      if (!Number.isInteger(r.step) || typeof r.at !== 'number') continue;
      kept[profile] = { ladder: r.ladder, step: r.step as number, at: r.at };
    }
    out[gpu] = kept;
  }
  return out;
}

/** Sets (or, with null, clears) the strike for `gpu` and `profile`. */
export async function saveSlowStrike(
  gpu: string,
  profile: ProfileId,
  strike: SlowStrike | null,
): Promise<void> {
  const { [gpu]: current, ...others } = await loadSlowStrikes();
  const { [profile]: _, ...rest } = current ?? {};
  const next = { ...others, [gpu]: strike ? { ...rest, [profile]: strike } : rest };
  await browser.storage.local.set({ [SLOW_STRIKES_KEY]: next });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
