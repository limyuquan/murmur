/**
 * What this device can run, and whether an engine fits. Detection is browser-only; the checks are
 * pure so the options page, the popup and tests share them.
 */
import type { ComputeBackend, HardwareRequirements } from './types';

export interface HardwareInfo {
  webgpu: {
    available: boolean;
    shaderF16: boolean;
    /** `adapter.limits.maxBufferSize`, MB. 0 without WebGPU. */
    maxBufferMB: number;
  };
  /** `navigator.deviceMemory` (GB, capped at 8 by Chrome), or null when unknown. */
  deviceMemoryGB: number | null;
  /** Logical CPU cores. */
  cores: number;
  /** The local companion app answered. */
  companion: boolean;
}

export const NO_HARDWARE: HardwareInfo = {
  webgpu: { available: false, shaderF16: false, maxBufferMB: 0 },
  deviceMemoryGB: null,
  cores: 1,
  companion: false,
};

/** Probes WebGPU and device limits. Works in windows and workers. */
export async function detectHardware(): Promise<HardwareInfo> {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    gpu?: { requestAdapter(): Promise<GpuAdapterLike | null> };
  };
  let webgpu = NO_HARDWARE.webgpu;
  try {
    const adapter = await nav.gpu?.requestAdapter();
    if (adapter) {
      webgpu = {
        available: true,
        shaderF16: adapter.features.has('shader-f16'),
        maxBufferMB: Math.floor(adapter.limits.maxBufferSize / (1024 * 1024)),
      };
    }
  } catch {
    // No WebGPU (blocked adapter, headless without a GPU): fall through.
  }
  return {
    webgpu,
    deviceMemoryGB: nav.deviceMemory ?? null,
    cores: nav.hardwareConcurrency || 1,
    companion: false,
  };
}

interface GpuAdapterLike {
  features: { has(name: string): boolean };
  limits: { maxBufferSize: number };
}

export function availableBackends(hw: HardwareInfo): ComputeBackend[] {
  const out: ComputeBackend[] = ['none', 'wasm'];
  if (hw.webgpu.available) out.push('webgpu');
  if (hw.companion) out.push('companion');
  return out;
}

export type RequirementCheck = { ok: true } | { ok: false; reasons: string[] };

/** Whether `req` fits `hw`, with plain reasons when it doesn't. */
export function checkRequirements(req: HardwareRequirements, hw: HardwareInfo): RequirementCheck {
  const reasons: string[] = [];
  const have = availableBackends(hw);
  const usable = req.backends.filter((b) => have.includes(b));
  if (usable.length === 0) {
    reasons.push(`Needs ${req.backends.map(backendName).join(' or ')}.`);
  }
  const gpuOnly = usable.length > 0 && usable.every((b) => b === 'webgpu');
  if (gpuOnly && req.shaderF16 && !hw.webgpu.shaderF16) {
    reasons.push('Needs a GPU with 16-bit float shaders.');
  }
  if (gpuOnly && req.minGpuBufferMB && hw.webgpu.maxBufferMB < req.minGpuBufferMB) {
    reasons.push(`Needs a GPU buffer of ${req.minGpuBufferMB} MB.`);
  }
  if (
    req.minDeviceMemoryGB &&
    hw.deviceMemoryGB !== null &&
    hw.deviceMemoryGB < req.minDeviceMemoryGB
  ) {
    reasons.push(`Needs ${req.minDeviceMemoryGB} GB of memory.`);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

function backendName(b: ComputeBackend): string {
  switch (b) {
    case 'webgpu':
      return 'WebGPU';
    case 'wasm':
      return 'WebAssembly';
    case 'companion':
      return 'the companion app';
    case 'none':
      return 'nothing';
  }
}
