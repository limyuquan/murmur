/**
 * The model workers' watch on their graphics devices: a `GPUOutOfMemoryError` or a lost device
 * is a memory failure; validation errors and a device the runtime destroyed aren't.
 */
import { describe, expect, it } from 'vitest';
import {
  createGpuWatch,
  gpuErrorMessage,
  type WatchedDevice,
  watchGpuDevices,
} from '@/engines/gpuwatch';

class GPUOutOfMemoryError {
  constructor(readonly message: string) {}
}
class GPUValidationError {
  constructor(readonly message: string) {}
}

class FakeDevice implements WatchedDevice {
  private listener: ((event: { error?: unknown }) => void) | null = null;
  private loseIt: (info: { reason?: string; message?: string }) => void = () => {};
  readonly lost = new Promise<{ reason?: string; message?: string }>((r) => {
    this.loseIt = r;
  });
  addEventListener(_type: 'uncapturederror', listener: (event: { error?: unknown }) => void) {
    this.listener = listener;
  }
  error(error: unknown) {
    this.listener?.({ error });
  }
  lose(info: { reason?: string; message?: string }) {
    this.loseIt(info);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('GPU watch', () => {
  it('records the first out-of-memory error, not validation errors', () => {
    const watch = createGpuWatch();
    const device = new FakeDevice();
    watch.watch(device);
    device.error(new GPUValidationError('Buffer is invalid.'));
    expect(watch.failure()).toBeNull();
    device.error(new GPUOutOfMemoryError('Failed to allocate 512 MB.'));
    device.error(new GPUOutOfMemoryError('again'));
    expect(watch.failure()).toBe('The graphics card ran out of memory: Failed to allocate 512 MB.');
    const heard: string[] = [];
    watch.onFailure((m) => heard.push(m));
    expect(heard).toHaveLength(1);
  });

  it('records a lost device, unless the runtime destroyed it', async () => {
    const watch = createGpuWatch();
    const heard: string[] = [];
    watch.onFailure((m) => heard.push(m));
    const a = new FakeDevice();
    const b = new FakeDevice();
    watch.watch(a);
    watch.watch(b);
    a.lose({ reason: 'destroyed', message: '' });
    await tick();
    expect(watch.failure()).toBeNull();
    b.lose({ reason: 'unknown', message: 'D3D12 device removed' });
    await tick();
    expect(heard).toEqual(['The graphics device was lost: D3D12 device removed']);
  });

  it('reads internal errors that say memory ran out', () => {
    expect(gpuErrorMessage({ message: 'Out of memory while creating a buffer' })).toMatch(
      /ran out of memory/,
    );
    expect(gpuErrorMessage({ message: 'Shader compilation failed' })).toBeNull();
    expect(gpuErrorMessage(null)).toBeNull();
  });

  it('watches every device the runtime requests, once per worker', async () => {
    const device = new FakeDevice();
    class GPUAdapter {
      async requestDevice() {
        return device;
      }
    }
    const scope = { GPUAdapter } as unknown as typeof globalThis;
    const watch = watchGpuDevices(scope);
    expect(watchGpuDevices(scope)).toBe(watch);
    expect(await new GPUAdapter().requestDevice()).toBe(device);
    device.error(new GPUOutOfMemoryError('no room'));
    expect(watch.failure()).toMatch(/no room/);
    // A simulated failure (e2e checks) goes the same way.
    const other = watchGpuDevices({} as typeof globalThis);
    other.record('The graphics card ran out of memory (simulated, at warmup).');
    expect(other.failure()).toMatch(/simulated/);
  });
});
