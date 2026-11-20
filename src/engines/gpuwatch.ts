/**
 * Notices a model worker's graphics card running out of memory, in a worker (Qwen3-ASR's, the
 * LLM's). Runtimes (ONNX Runtime, LiteRT-LM) create their own `GPUDevice` and don't always turn a
 * failed allocation into an error: WebGPU reports it as an `uncapturederror` event on the device
 * (a `GPUOutOfMemoryError`), the buffer is left invalid, and the model computes garbage, or the
 * device is lost. So `watchGpuDevices` wraps `GPUAdapter.prototype.requestDevice` before the
 * runtime loads, and watches every device it makes. The worker checks `failure()` after loading
 * and after its warm-up run, and fails the load with `memory: true`; the session then steps down
 * to smaller models (engines/loading.ts `loadLadder`).
 */
import { looksLikeOutOfMemory } from './errors';

/** What the worker sees of a device. */
export interface WatchedDevice {
  addEventListener(type: 'uncapturederror', listener: (event: { error?: unknown }) => void): void;
  readonly lost: Promise<{ reason?: string; message?: string }>;
}

export interface GpuWatch {
  /** The first memory failure seen (a plain message), or null. */
  failure(): string | null;
  /**
   * Whether that failure was only a lost device (reason `unknown`), with no out-of-memory error
   * before it: possibly not memory at all (`OutOfMemoryError.lostOnly`).
   */
  lostOnly(): boolean;
  /** Calls `listener` on the first memory failure (at once if there was one). */
  onFailure(listener: (message: string) => void): void;
  /** Records a failure as a device would (e2e checks: a simulated out-of-memory). */
  record(message: string): void;
  /** Watches `device` (done for every device the runtime requests once installed). */
  watch(device: WatchedDevice): void;
}

export function createGpuWatch(): GpuWatch {
  let first: string | null = null;
  let lostOnly = false;
  const listeners: ((message: string) => void)[] = [];
  const record = (message: string, lost = false) => {
    if (first !== null) return;
    first = message;
    lostOnly = lost;
    for (const l of listeners.splice(0)) l(message);
  };
  return {
    failure: () => first,
    lostOnly: () => lostOnly,
    onFailure(listener) {
      if (first !== null) listener(first);
      else listeners.push(listener);
    },
    record: (message) => record(message),
    watch(device) {
      device.addEventListener('uncapturederror', (event) => {
        const message = gpuErrorMessage(event.error);
        if (message) record(message);
      });
      void device.lost.then(
        (info) => {
          // `destroyed`: the runtime let go of it (a worker ending, a session released).
          if (info?.reason === 'destroyed') return;
          record(`The graphics device was lost${info?.message ? `: ${info.message}` : '.'}`, true);
        },
        () => {},
      );
    },
  };
}

/**
 * The message of a WebGPU error that means memory ran out (a `GPUOutOfMemoryError`, or an
 * internal error saying so), else null. Validation errors are the runtime's own mistakes, or
 * follow from a buffer an earlier allocation failure left invalid (already recorded).
 */
export function gpuErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const name = (error as { constructor?: { name?: string } }).constructor?.name ?? '';
  const message = String((error as { message?: unknown }).message ?? '');
  if (name === 'GPUOutOfMemoryError') {
    return `The graphics card ran out of memory${message ? `: ${message}` : '.'}`;
  }
  if (looksLikeOutOfMemory(message)) return `The graphics card ran out of memory: ${message}`;
  return null;
}

interface AdapterPrototype {
  requestDevice(this: unknown, ...args: unknown[]): Promise<WatchedDevice>;
}

/**
 * A watch over every device this worker's runtimes request from now on. Installs once per
 * worker; without WebGPU it watches nothing (and nothing fails).
 */
export function watchGpuDevices(scope: typeof globalThis = globalThis): GpuWatch {
  const existing = (scope as { __murmurGpuWatch?: GpuWatch }).__murmurGpuWatch;
  if (existing) return existing;
  const watch = createGpuWatch();
  (scope as { __murmurGpuWatch?: GpuWatch }).__murmurGpuWatch = watch;
  const proto = (scope as { GPUAdapter?: { prototype: AdapterPrototype } }).GPUAdapter?.prototype;
  if (proto && typeof proto.requestDevice === 'function') {
    const original = proto.requestDevice;
    proto.requestDevice = async function (this: unknown, ...args: unknown[]) {
      const device = await original.apply(this, args);
      try {
        watch.watch(device);
      } catch {
        // Not a device we can listen to: the runtime still gets it.
      }
      return device;
    };
  }
  return watch;
}
