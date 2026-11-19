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
    /**
     * `adapter.info.description` (or `device`): the card's name, e.g. "NVIDIA GeForce RTX 3050
     * Laptop GPU". Chrome leaves it empty unless WebGPU developer features are on.
     */
    description?: string;
    /** `adapter.limits.maxStorageBufferBindingSize`, MB, when known. */
    maxStorageBufferMB?: number;
    /** A software adapter (no graphics card behind it). */
    fallback?: boolean;
  };
  /**
   * `navigator.deviceMemory`: the computer's memory, GB, rounded to a power of two, or null when
   * unknown. Older Chrome capped it at 8; Chrome 158 reports 16 on a 16 GB Mac, so 8 may mean
   * "8 or more" and anything above is as reported.
   */
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
        maxBufferMB: Math.floor(adapter.limits.maxBufferSize / MB),
        ...(adapter.limits.maxStorageBufferBindingSize
          ? { maxStorageBufferMB: Math.floor(adapter.limits.maxStorageBufferBindingSize / MB) }
          : {}),
        ...(info?.vendor ? { vendor: info.vendor } : {}),
        ...(info?.architecture ? { architecture: info.architecture } : {}),
        ...(info?.description || info?.device
          ? { description: (info.description || info.device) as string }
          : {}),
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

const MB = 1024 * 1024;

interface GpuAdapterLike {
  features: { has(name: string): boolean };
  limits: { maxBufferSize: number; maxStorageBufferBindingSize?: number };
  info?: {
    vendor?: string;
    architecture?: string;
    description?: string;
    device?: string;
    isFallbackAdapter?: boolean;
  };
  isFallbackAdapter?: boolean;
}

/**
 * What kind of graphics card this looks like, from what WebGPU tells (it never tells how much
 * memory a card has):
 * - `discrete`: a card with its own memory (NVIDIA; Intel Arc; AMD Radeon RX when named).
 * - `unified`: Apple silicon, sharing the computer's memory with plenty of bandwidth.
 * - `integrated`: other graphics built into the processor (Intel, Qualcomm, Arm), sharing memory.
 * - `software`: no graphics card (a fallback adapter).
 * - `unknown`: AMD without a name (its cards and its processor graphics report alike), and
 *   anything else.
 */
export type GpuKind = 'discrete' | 'unified' | 'integrated' | 'software' | 'unknown';

/**
 * Graphics that share the computer's memory (Apple silicon, integrated graphics): models fit in
 * more memory there than on most cards, but run slower than their size suggests (fewer, slower
 * cores sharing the memory's bandwidth with everything else).
 */
export function sharesMemory(webgpu: HardwareInfo['webgpu']): boolean {
  const kind = gpuKind(webgpu);
  return kind === 'unified' || kind === 'integrated';
}

export function gpuKind(webgpu: HardwareInfo['webgpu']): GpuKind {
  if (!webgpu.available || webgpu.fallback) return 'software';
  const vendor = webgpu.vendor?.toLowerCase() ?? '';
  const arch = webgpu.architecture?.toLowerCase() ?? '';
  const name = webgpu.description?.toLowerCase() ?? '';
  if (vendor === 'nvidia') return 'discrete';
  if (vendor === 'apple') return 'unified';
  if (vendor === 'intel') {
    return /^xe(2)?-hp[gc]/.test(arch) || /\barc\b.*\b[ab]\d{3}/.test(name)
      ? 'discrete'
      : 'integrated';
  }
  if (vendor === 'qualcomm' || vendor === 'arm' || vendor === 'img-tec') return 'integrated';
  if (vendor === 'amd') {
    if (/radeon\s*(\(tm\)\s*)?(rx|pro\s*w)/.test(name)) return 'discrete';
    if (/radeon\s*(\(tm\)\s*)?(graphics|vega|\d{3}m)\b/.test(name)) return 'integrated';
  }
  return 'unknown';
}

/**
 * Graphics memory a named card has, GB, from its name when the browser gives one: a size in the
 * name ("RTX 3050 6GB Laptop GPU"), else the size most of that model ship with. Null when the
 * name says nothing Murmur knows. Only cards that commonly have 8 GB or less are listed: those
 * are the ones where the estimate matters.
 */
export function namedCardGB(description: string | undefined): number | null {
  if (!description) return null;
  const name = description.toLowerCase();
  const stated = /\b(\d{1,2})\s?gb\b/.exec(name);
  if (stated) return Number(stated[1]);
  for (const [pattern, gb] of NAMED_CARDS) if (pattern.test(name)) return gb;
  return null;
}

const NAMED_CARDS: readonly [RegExp, number][] = [
  // NVIDIA laptop chips first: the same number has more memory on the desktop.
  [/\bmx\s?\d{3}\b/, 2],
  [/\brtx\s?(2050|3050)\b.*\b(laptop|mobile|max-q)\b/, 4],
  [/\brtx\s?(3050\s?ti|a500|a1000|a2000)\b.*\b(laptop|mobile|max-q)\b/, 4],
  [/\brtx\s?(3060|4050)\b.*\b(laptop|mobile|max-q)\b/, 6],
  [/\brtx\s?(3070|3070\s?ti|4060|4070)\b.*\b(laptop|mobile|max-q)\b/, 8],
  [/\bgtx\s?(1050|1050\s?ti|1650|1650\s?ti|1650\s?super)\b/, 4],
  [/\bgtx\s?(1060|1660|1660\s?ti|1660\s?super)\b/, 6],
  [/\brtx\s?(2060)\b/, 6],
  [/\brtx\s?(3050)\b/, 8],
  [/\brtx\s?(2070|2080|3060\s?ti|3070|3070\s?ti|4060|4060\s?ti)\b/, 8],
  // Intel Arc.
  [/\barc\b.*\ba3\d0m?\b/, 4],
  [/\barc\b.*\ba5\d0m\b/, 4],
  [/\barc\b.*\ba380\b/, 6],
  // AMD Radeon RX.
  [/\brx\s?(5300|5500|6400|6500|6500\s?xt|6500m|6550m)\b/, 4],
  [/\brx\s?(5600|5600m|6600m|7600s)\b/, 6],
];

/**
 * Graphics memory left for models on a card of `gb`, MB: the desktop, the browser and the driver
 * keep some (about 0.6 GB on an 8 GB card in Murmur's measurements, more on Windows laptops).
 */
function usableMB(gb: number): number {
  return Math.round(gb * 1024 * 0.85);
}

/**
 * A rough guess at the graphics memory models may use here, MB. A guess only: WebGPU doesn't say
 * how much memory a card has, so this goes by what it does say, as hints:
 * - the card's name, when the browser gives one (`namedCardGB`);
 * - the kind of card (`gpuKind`), and for graphics that share the computer's memory, that memory
 *   (`navigator.deviceMemory`: 16 on a 16 GB Mac in Chrome 158; older versions stopped at 8);
 * - a computer reporting under 8 GB of memory rarely has a card with more than 4 GB;
 * - a card whose largest buffer is under 1 GB (`maxBufferSize`, `maxStorageBufferBindingSize`) is
 *   an old or small one.
 * No test allocation: on Windows the driver lets a program allocate past the card's memory (it
 *   spills into the computer's), so a probe that succeeds proves little, and one that fills the
 *   card can make the GPU process drop every page's graphics. Profiles go by this guess, then by
 *   what actually happened on this device: a load that runs out of graphics memory steps down to
 *   smaller models, and the next session starts there (profiles.ts, `LADDERS`).
 */
export function estimateGpuMemoryMB(hw: HardwareInfo): number {
  const ramMB = (hw.deviceMemoryGB ?? 4) * 1024;
  const kind = gpuKind(hw.webgpu);
  if (kind === 'software') return 0;
  const named = namedCardGB(hw.webgpu.description);
  if (named !== null && (kind === 'discrete' || kind === 'unknown')) return usableMB(named);
  let mb: number;
  switch (kind) {
    case 'discrete':
      // Most cards Chrome users run WebGPU on have 6–8 GB or more.
      mb = 6144;
      if (hw.deviceMemoryGB !== null && hw.deviceMemoryGB < 8) mb = usableMB(4);
      break;
    case 'unified':
      // About half the computer's memory is free for graphics next to the system, the browser
      // and the person's other apps: 8 GB on a 16 GB Mac (measured: Qwen3-ASR 1.7B with Gemma 4
      // E4B took 6.2 GB there without running out, and the system's memory pressure went
      // critical while they loaded). An older Chrome's 8 ("8 or more") gives 4 GB, the 8 GB
      // Mac's share. Capped at 16 GB, far above what any pair needs.
      mb = Math.min(ramMB, 32 * 1024) / 2;
      break;
    case 'integrated':
      mb = Math.min(2048, ramMB / 4);
      break;
    case 'unknown':
      mb = hw.webgpu.maxBufferMB >= 2048 ? 3072 : 2048;
      break;
  }
  const largestBufferMB = Math.min(
    hw.webgpu.maxBufferMB,
    hw.webgpu.maxStorageBufferMB ?? Number.POSITIVE_INFINITY,
  );
  if (largestBufferMB < 1024) mb = Math.min(mb, 3072);
  return mb;
}

/**
 * Identifies this device's graphics for the per-device record of which models fit
 * (settings/memoryfit.ts): another card (or another browser profile on another computer) starts
 * afresh.
 */
export function gpuKey(hw: HardwareInfo): string {
  const w = hw.webgpu;
  if (!w.available) return 'none';
  return [w.vendor ?? '?', w.architecture ?? '?', w.description ?? '', w.maxBufferMB].join('|');
}

export function availableBackends(hw: HardwareInfo): ComputeBackend[] {
  const out: ComputeBackend[] = ['none', 'wasm'];
  if (hw.webgpu.available) out.push('webgpu');
  if (hw.companion) out.push('companion');
  return out;
}

export type RequirementCheck = { ok: true } | { ok: false; reasons: string[] };

export interface CheckOptions {
  /**
   * Check the engine's graphics memory against the estimate (default). Profiles with a memory
   * ladder check the two engines together instead (profiles.ts).
   */
  memory?: boolean;
}

/** Whether `req` fits `hw`, with plain reasons when it doesn't. */
export function checkRequirements(
  req: HardwareRequirements,
  hw: HardwareInfo,
  { memory = true }: CheckOptions = {},
): RequirementCheck {
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
  if (memory && gpuOnly && req.minGpuMemoryMB && estimateGpuMemoryMB(hw) < req.minGpuMemoryMB) {
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
  options: CheckOptions = {},
): RequirementCheck {
  if (info.unavailable) return { ok: false, reasons: [info.unavailable] };
  return checkRequirements(info.requirements, hw, options);
}

export function formatGB(mb: number): string {
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
