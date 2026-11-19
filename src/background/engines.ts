/** The service worker's engine registry (static info only) and this device's hardware. */
import { createBuiltinRegistry } from '@/engines/builtin';
import { detectHardware, type HardwareInfo } from '@/engines/hardware';
import type { ProfileChoice, ResolveOptions } from '@/engines/profiles';
import { loadMemoryFit, resolveOptions } from '@/settings/memoryfit';
import type { Settings } from '@/settings/settings';

export const registry = createBuiltinRegistry();
let hardware: Promise<HardwareInfo> | null = null;

/** This device's hardware, detected once per worker. */
export function deviceHardware(): Promise<HardwareInfo> {
  hardware ??= detectHardware();
  return hardware;
}

/** `resolveOptions` (settings/memoryfit.ts) with this device and the stored records. */
export async function deviceResolveOptions(
  settings: Pick<Settings, 'smallerSpeech'>,
  profile: ProfileChoice,
): Promise<ResolveOptions> {
  return resolveOptions(settings, profile, await deviceHardware(), await loadMemoryFit());
}
