/**
 * Model profiles: what most people pick instead of individual engines. Each profile lists engine
 * ids in order of preference; the first one that is registered and fits the device wins, and the
 * demo engines are the last resort. So adding a real engine is: register it (builtin.ts), then put
 * its id at the front of the profiles it suits. `custom` uses the engines chosen in settings.
 */
import { checkRequirements, type HardwareInfo } from './hardware';
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

export const PROFILES: Record<ProfileId, ModelProfile> = {
  light: {
    id: 'light',
    label: 'Light',
    description: 'Small models. Runs on most laptops, including without a graphics card.',
    asr: [DEMO_ASR_ID],
    translation: [DEMO_TRANSLATION_ID],
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    description: 'Medium models on the graphics card. Better accuracy, larger download.',
    asr: [DEMO_ASR_ID],
    translation: [DEMO_TRANSLATION_ID],
  },
  best: {
    id: 'best',
    label: 'Best',
    description: 'The largest models: a strong graphics card or the companion app.',
    asr: [DEMO_ASR_ID],
    translation: [DEMO_TRANSLATION_ID],
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
  const asr = pick(asrCandidates, (id) => registry.asrInfo(id), DEMO_ASR_ID, hardware, notes);
  const translation = pick(
    mtCandidates,
    (id) => registry.translationInfo(id),
    DEMO_TRANSLATION_ID,
    hardware,
    notes,
  );
  return { asr, translation, notes };
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
    const check = checkRequirements(engine.requirements, hardware);
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
