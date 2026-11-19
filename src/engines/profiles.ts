/**
 * Model profiles: what most people pick instead of individual engines. Each profile lists engine
 * ids in order of preference; the first one that is registered and fits the device wins, and the
 * demo engines are the last resort. So adding a real engine is: register it (builtin.ts), then put
 * its id at the front of the profiles it suits. `custom` uses the engines chosen in settings.
 */
import { CHROME_TRANSLATOR_ID, CHROME_WEBSPEECH_ID } from './chrome/info';
import { checkEngine, type HardwareInfo } from './hardware';
import { QWEN3_ASR_ID } from './qwen3asr/info';
import type { EngineRegistry } from './registry';
import type { EngineInfo } from './types';

export type ProfileId = 'light' | 'balanced' | 'best';
export type ProfileChoice = ProfileId | 'custom';

export interface ModelProfile {
  id: ProfileId;
  label: string;
  description: string;
  /** ASR engine ids, most preferred first. */
  asr: readonly string[];
  /** Translation engine ids, most preferred first. */
  translation: readonly string[];
}

export const DEMO_ASR_ID = 'demo-echo';
export const DEMO_TRANSLATION_ID = 'demo-passthrough';
export const WHISPER_BASE_ID = 'whisper-base';
export const WHISPER_TURBO_ID = 'whisper-large-v3-turbo';
export { QWEN3_ASR_ID };

/**
 * What runs when an engine turns out not to work here once it loads (EngineUnavailableError):
 * the service worker can't see Chrome's speech APIs, so the profile can't rule them out.
 */
export const RUNTIME_FALLBACKS: Readonly<Record<string, string>> = {
  [CHROME_WEBSPEECH_ID]: WHISPER_BASE_ID,
  // Its worker found no 16-bit float shaders after all, or its files aren't published.
  [QWEN3_ASR_ID]: WHISPER_TURBO_ID,
};

/**
 * Last resorts when nothing a profile lists fits, in order. The demo engines are only registered
 * in e2e builds, so elsewhere these are real engines.
 */
const ASR_LAST_RESORT = [WHISPER_BASE_ID, DEMO_ASR_ID];
const TRANSLATION_LAST_RESORT = [CHROME_TRANSLATOR_ID, DEMO_TRANSLATION_ID];

export const PROFILES: Record<ProfileId, ModelProfile> = {
  // Chrome's own on-device speech and translation: nothing for Murmur to download.
  light: {
    id: 'light',
    label: 'Light',
    description: 'Small models. Runs on most laptops, including without a graphics card.',
    asr: [CHROME_WEBSPEECH_ID, WHISPER_BASE_ID],
    translation: [CHROME_TRANSLATOR_ID],
  },
  // Translation stays Chrome's until an in-browser translation model is chosen (benchmarks).
  // Qwen3-ASR follows language switches best; turbo where it can't run (no 16-bit float shaders,
  // or its files aren't published in this build).
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    description: 'Medium models on the graphics card. Better accuracy, larger download.',
    asr: [QWEN3_ASR_ID, WHISPER_TURBO_ID, WHISPER_BASE_ID],
    translation: [CHROME_TRANSLATOR_ID],
  },
  // Until the companion app exists, the best the browser runs.
  best: {
    id: 'best',
    label: 'Best',
    description: 'The largest models: a strong graphics card or the companion app.',
    asr: [WHISPER_TURBO_ID, WHISPER_BASE_ID],
    translation: [CHROME_TRANSLATOR_ID],
  },
};

export const PROFILE_ORDER: readonly ProfileId[] = ['light', 'balanced', 'best'];

export interface ResolvedEngines {
  asr: string;
  translation: string;
  /** Plain notes on any fallback ("X needs WebGPU; using Y."). */
  notes: string[];
}

/** Picks the engines to run for `choice` on this device. */
export function resolveEngines(
  choice: ProfileChoice,
  custom: { asr: string; translation: string },
  registry: EngineRegistry,
  hardware: HardwareInfo,
): ResolvedEngines {
  const notes: string[] = [];
  const asrCandidates = choice === 'custom' ? [custom.asr] : PROFILES[choice].asr;
  const mtCandidates = choice === 'custom' ? [custom.translation] : PROFILES[choice].translation;
  const asrInfo = (id: string) => registry.asrInfo(id);
  const mtInfo = (id: string) => registry.translationInfo(id);
  const asr = pick(asrCandidates, asrInfo, lastResort(ASR_LAST_RESORT, asrInfo), hardware, notes);
  const translation = pick(
    mtCandidates,
    mtInfo,
    lastResort(TRANSLATION_LAST_RESORT, mtInfo),
    hardware,
    notes,
  );
  return { asr, translation, notes };
}

function lastResort(ids: readonly string[], info: (id: string) => EngineInfo | undefined): string {
  return ids.find((id) => info(id)) ?? (ids[0] as string);
}

function pick(
  candidates: readonly string[],
  info: (id: string) => EngineInfo | undefined,
  fallback: string,
  hardware: HardwareInfo,
  notes: string[],
): string {
  for (const id of candidates) {
    const engine = info(id);
    if (!engine) {
      notes.push(`${id} isn't available in this build.`);
      continue;
    }
    const check = checkEngine(engine, hardware);
    if (check.ok) return id;
    notes.push(`${engine.label}: ${check.reasons.join(' ')}`);
  }
  return fallback;
}

/** The profile to suggest for this device. */
export function recommendProfile(hw: HardwareInfo): ProfileId {
  if (hw.companion) return 'best';
  if (!hw.webgpu.available) return 'light';
  const memory = hw.deviceMemoryGB ?? 4;
  if (hw.webgpu.shaderF16 && memory >= 8 && hw.webgpu.maxBufferMB >= 1024) return 'best';
  return 'balanced';
}
