/** The service worker's engine registry (static info only) and this device's hardware. */
import { createBuiltinRegistry } from '@/engines/builtin';
import { detectHardware, type HardwareInfo } from '@/engines/hardware';

export const registry = createBuiltinRegistry();
let hardware: Promise<HardwareInfo> | null = null;

/** This device's hardware, detected once per worker. */
export function deviceHardware(): Promise<HardwareInfo> {
  hardware ??= detectHardware();
  return hardware;
}
