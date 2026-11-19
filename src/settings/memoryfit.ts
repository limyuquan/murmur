/**
 * Which step of each profile's memory ladder (engines/profiles.ts `LADDERS`) last worked on this
 * device, in `chrome.storage.local` under `MEMORY_FIT_KEY`, per graphics card (`gpuKey`): when a
 * model runs out of graphics memory the session steps down, and the next session starts at the
 * step it reached instead of failing the same way again. "Try the larger models" (options page)
 * sets the step back to the top; a session that runs out again steps down and records that.
 *
 * Written by the service worker (the offscreen document has no storage access: it reports a step
 * down as a `memory-fit` event) and by the options page.
 */
import { browser } from 'wxt/browser';
import { gpuKey, type HardwareInfo } from '@/engines/hardware';
import type { ProfileChoice, ProfileId, ResolveOptions } from '@/engines/profiles';
import type { Settings } from './settings';

export const MEMORY_FIT_KEY = 'memoryFit';

export interface MemoryFitRecord {
  /** The ladder step to start at (`LADDERS[profile]` index; its length: below the last step). */
  step: number;
  /** When it was recorded, epoch ms. */
  at: number;
  /** The engine that ran out of memory, and what it said (none: set from the options page). */
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
      kept[profile] = {
        step: r.step as number,
        at: typeof r.at === 'number' ? r.at : 0,
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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
