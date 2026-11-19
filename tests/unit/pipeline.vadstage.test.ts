import { describe, expect, it } from 'vitest';
import type { AsyncVoiceActivityDetector } from '@/pipeline/vad';
import { VadStage } from '@/pipeline/vadstage';
import { burst } from './helpers';

/** Answers each frame with its first sample after a delay that varies, or fails from frame `failAt`. */
class FakeModel implements AsyncVoiceActivityDetector {
  readonly frameSamples = 512;
  resets: number[] = [];
  calls = 0;
  constructor(private readonly failAt = Infinity) {}
  process(frame: Float32Array): Promise<number> {
    const n = this.calls++;
    if (n >= this.failAt) return Promise.reject(new Error('model gone'));
    const delay = (n * 7) % 5;
    return new Promise((resolve) => setTimeout(() => resolve(frame[0] ?? 0), delay));
  }
  reset(): void {
    this.resets.push(this.calls);
  }
}

/** Audio whose sample at `i` is `i / 1e6`, so a frame says where it came from. */
const ramp = (n: number, from = 0) => Float32Array.from({ length: n }, (_, i) => (from + i) / 1e6);

describe('VadStage', () => {
  it('cuts any chunking into model frames and hands them on in order', async () => {
    const seen: [number, number, number][] = [];
    const stage = new VadStage(new FakeModel(), (s, at, p) => seen.push([s.length, at, p]));
    const audio = ramp(512 * 6 + 100);
    for (let i = 0; i < audio.length; i += 320) stage.push(audio.subarray(i, i + 320), i);
    await stage.drain();
    expect(seen.map(([n]) => n)).toEqual([512, 512, 512, 512, 512, 512]);
    expect(seen.map(([, at]) => at)).toEqual([0, 512, 1024, 1536, 2048, 2560]);
    expect(seen.map(([, at, p]) => Math.round(p * 1e6) - at)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('runs after() once the frames before it are handed on', async () => {
    const order: string[] = [];
    const stage = new VadStage(new FakeModel(), (_, at) => order.push(`f${at}`));
    stage.push(ramp(1024), 0);
    stage.after(() => order.push('flush'));
    stage.push(ramp(512, 1024), 1024);
    await stage.drain();
    expect(order).toEqual(['f0', 'f512', 'flush', 'f1024']);
  });

  it('starts a new stream at a gap, dropping the partial frame', async () => {
    const model = new FakeModel();
    const starts: number[] = [];
    const stage = new VadStage(model, (_, at) => starts.push(at));
    stage.push(ramp(700), 0);
    stage.push(ramp(512, 5000), 5000);
    await stage.drain();
    expect(starts).toEqual([0, 5000]);
    expect(model.resets).toEqual([1]);
  });

  it('falls back to the energy gate for good when the model fails, and says so once', async () => {
    const failures: Error[] = [];
    const probs: number[] = [];
    const stage = new VadStage(
      new FakeModel(2),
      (_, __, p) => probs.push(p),
      (err) => failures.push(err),
    );
    const loud = burst(512 / 16_000, 0.3);
    const quiet = new Float32Array(512);
    for (const f of [quiet, quiet, loud, quiet, loud]) stage.push(f);
    await stage.drain();
    expect(stage.failed).toBe(true);
    expect(failures.map((e) => e.message)).toEqual(['model gone']);
    expect(probs).toEqual([0, 0, 1, 0, 1]);
  });

  it('keeps going when the handler throws', async () => {
    const seen: number[] = [];
    const stage = new VadStage(new FakeModel(), (_, at) => {
      seen.push(at);
      if (at === 0) throw new Error('boom');
    });
    const errors = console.error;
    console.error = () => {};
    stage.push(ramp(1024), 0);
    await stage.drain();
    console.error = errors;
    expect(seen).toEqual([0, 512]);
  });
});
