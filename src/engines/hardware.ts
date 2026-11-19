/**
 * What this device can run, and whether an engine fits. Detection is browser-only; the checks are
 * pure so the options page, the popup and tests share them.
 */
import type { ComputeBackend, EngineInfoBase, HardwareRequirements } from './types';

export interface HardwareInfo {
  webgpu: {
    available: boolean;
    shaderF16: boolean;
    /** `adapter.limits.maxBufferSize`, MB. 0 without WebGPU. */
    maxBufferMB: number;
    /** `adapter.info.vendor` ("nvidia", "apple", "intel"), when Chrome tells. */
    vendor?: string;
    /** `adapter.info.architecture` ("ampere", "gen-12lp", "metal-3"), when Chrome tells. */
    architecture?: string;
    /** A software adapter (no graphics card behind it). */
    fallback?: boolean;
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
      const { info, isFallbackAdapter } = adapter as unknown as GpuAdapterLike;
      const fallback = info?.isFallbackAdapter ?? isFallbackAdapter;
      webgpu = {
        available: true,
        shaderF16: adapter.features.has('shader-f16'),
        maxBufferMB: Math.floor(adapter.limits.maxBufferSize / (1024 * 1024)),
        ...(info?.vendor ? { vendor: info.vendor } : {}),
        ...(info?.architecture ? { architecture: info.architecture } : {}),
        ...(fallback !== undefined ? { fallback } : {}),
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
  info?: { vendor?: string; architecture?: string; isFallbackAdapter?: boolean };
  isFallbackAdapter?: boolean;
}

/**
 * What kind of graphics card this looks like, from what WebGPU tells (it never tells how much
 * memory a card has):
 * - `discrete`: a card with its own memory (NVIDIA; Intel Arc).
 * - `unified`: Apple silicon, sharing the computer's memory with plenty of bandwidth.
 * - `integrated`: other graphics built into the processor (Intel, Qualcomm, Arm), sharing memory.
 * - `software`: no graphics card (a fallback adapter).
 * - `unknown`: AMD (its cards and its processor graphics report alike), and anything else.
 */
export type GpuKind = 'discrete' | 'unified' | 'integrated' | 'software' | 'unknown';

export function gpuKind(webgpu: HardwareInfo['webgpu']): GpuKind {
  if (!webgpu.available || webgpu.fallback) return 'software';
  const vendor = webgpu.vendor?.toLowerCase() ?? '';
  const arch = webgpu.architecture?.toLowerCase() ?? '';
  if (vendor === 'nvidia') return 'discrete';
  if (vendor === 'apple') return 'unified';
  if (vendor === 'intel') return /^xe(2)?-hp[gc]/.test(arch) ? 'discrete' : 'integrated';
  if (vendor === 'qualcomm' || vendor === 'arm' || vendor === 'img-tec') return 'integrated';
  return 'unknown';
}

/**
 * A rough guess at the graphics memory models may use here, MB. A guess only: WebGPU doesn't say
 * how much memory a card has, so this goes by the kind of card, and the computer's memory for
 * graphics that share it. Engines that ask for more than it finds aren't chosen by a profile; one
 * that runs out anyway fails to load and hands over to its fallback.
 */
export function estimateGpuMemoryMB(hw: HardwareInfo): number {
  const ramMB = (hw.deviceMemoryGB ?? 4) * 1024;
  switch (gpuKind(hw.webgpu)) {
    case 'software':
      return 0;
    case 'discrete':
      return 6144;
    case 'unified':
      // Chrome reports at most 8 GB; about half of it is free for graphics.
      return ramMB / 2;
    case 'integrated':
      return Math.min(2048, ramMB / 4);
    case 'unknown':
      return hw.webgpu.maxBufferMB >= 2048 ? 3072 : 2048;
  }
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
  if (gpuOnly && req.minGpuMemoryMB && estimateGpuMemoryMB(hw) < req.minGpuMemoryMB) {
    reasons.push(
      gpuKind(hw.webgpu) === 'software'
        ? 'Needs a graphics card.'
        : `Needs about ${formatGB(req.minGpuMemoryMB)} of graphics memory, more than this device seems to have.`,
    );
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

/** Whether the engine can run here: offered in this build, and its requirements fit `hw`. */
export function checkEngine(
  info: Pick<EngineInfoBase, 'requirements' | 'unavailable'>,
  hw: HardwareInfo,
): RequirementCheck {
  if (info.unavailable) return { ok: false, reasons: [info.unavailable] };
  return checkRequirements(info.requirements, hw);
}

function formatGB(mb: number): string {
  return `${(mb / 1024).toFixed(1).replace(/\.0$/, '')} GB`;
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
