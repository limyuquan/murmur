/** Which models each profile needs on this device, from the engines it resolves to. */
import type { HardwareInfo } from '@/engines/hardware';
import {
  PROFILE_ORDER,
  type ProfileChoice,
  type ProfileId,
  resolveEngines,
} from '@/engines/profiles';
import type { EngineRegistry } from '@/engines/registry';
import type { EngineInfo, EngineModel } from '@/engines/types';
import type { ModelInfo } from './types';

function toModel(info: EngineInfo, m: EngineModel): ModelInfo {
  return {
    id: m.id,
    label: m.label,
    sizeMB: m.sizeMB,
    role: info.kind === 'asr' ? 'speech' : 'translation',
    runtime: info.runtime === 'companion' ? 'companion' : 'browser',
    source: m.source,
  };
}

/**
 * The downloads `info` needs on this device. An engine with one download per backend needs the
 * WebGPU one where WebGPU works, else the WebAssembly one.
 */
export function engineModels(info: EngineInfo | undefined, hardware: HardwareInfo): ModelInfo[] {
  if (!info?.models) return [];
  const perBackend = info.models.filter((m) => m.backend);
  const plain = info.models.filter((m) => !m.backend);
  const order = hardware.webgpu.available ? ['webgpu', 'wasm'] : ['wasm', 'webgpu'];
  const pick = order.map((b) => perBackend.find((m) => m.backend === b)).find((m) => m);
  return [...plain, ...(pick ? [pick] : [])].map((m) => toModel(info, m));
}

/** Every download any engine in `registry` declares, on any backend. */
export function knownModels(registry: EngineRegistry): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const info of [...registry.asrEngines(), ...registry.translationEngines()]) {
    for (const m of info.models ?? []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(toModel(info, m));
    }
  }
  return out;
}

/** Models `choice` needs on this device, de-duplicated, speech first. */
export function modelsFor(
  choice: ProfileChoice,
  custom: { asr: string; translation: string },
  registry: EngineRegistry,
  hardware: HardwareInfo,
): ModelInfo[] {
  const engines = resolveEngines(choice, custom, registry, hardware);
  const models = [
    ...engineModels(registry.asrInfo(engines.asr), hardware),
    ...engineModels(registry.translationInfo(engines.translation), hardware),
  ];
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
