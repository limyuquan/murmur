/** Which models each profile needs, from the engines it resolves to (or the planned ones). */
import type { HardwareInfo } from '@/engines/hardware';
import {
  PROFILE_ORDER,
  type ProfileChoice,
  type ProfileId,
  resolveEngines,
} from '@/engines/profiles';
import type { EngineRegistry } from '@/engines/registry';
import type { EngineInfo } from '@/engines/types';
import { PLANNED_MODELS } from './planned';
import type { ModelInfo } from './types';

function engineModels(info: EngineInfo | undefined): ModelInfo[] {
  if (!info?.models) return [];
  return info.models.map((m) => ({
    id: m.id,
    label: m.label,
    sizeMB: m.sizeMB,
    role: info.kind === 'asr' ? 'speech' : 'translation',
    runtime: info.runtime === 'companion' ? 'companion' : 'browser',
    simulated: false,
  }));
}

/** Models `choice` needs on this device, de-duplicated, speech first. */
export function modelsFor(
  choice: ProfileChoice,
  custom: { asr: string; translation: string },
  registry: EngineRegistry,
  hardware: HardwareInfo,
): ModelInfo[] {
  const engines = resolveEngines(choice, custom, registry, hardware);
  const real = [
    ...engineModels(registry.asrInfo(engines.asr)),
    ...engineModels(registry.translationInfo(engines.translation)),
  ];
  const models = real.length > 0 || choice === 'custom' ? real : [...PLANNED_MODELS[choice]];
  const seen = new Set<string>();
  return models.filter((m) => !seen.has(m.id) && seen.add(m.id));
}

/** Every model any profile (or the custom choice) uses, with the profiles that use it. */
export function allModels(
  custom: { asr: string; translation: string },
  registry: EngineRegistry,
  hardware: HardwareInfo,
): { info: ModelInfo; profiles: ProfileId[] }[] {
  const byId = new Map<string, { info: ModelInfo; profiles: ProfileId[] }>();
  for (const profile of PROFILE_ORDER) {
    for (const info of modelsFor(profile, custom, registry, hardware)) {
      const entry = byId.get(info.id) ?? { info, profiles: [] };
      entry.profiles.push(profile);
      byId.set(info.id, entry);
    }
  }
  for (const info of modelsFor('custom', custom, registry, hardware)) {
    if (!byId.has(info.id)) byId.set(info.id, { info, profiles: [] });
  }
  return [...byId.values()];
}

export function totalMB(models: readonly ModelInfo[]): number {
  return models.reduce((n, m) => n + m.sizeMB, 0);
}
