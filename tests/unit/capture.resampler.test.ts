import { describe, expect, it } from 'vitest';
import { downmix, FrameBatcher, StreamingResampler } from '@/capture/resampler';
import { concat, rms, sine } from './helpers';

/** Runs `input` through a fresh resampler in chunks of `chunk`, then flushes. */
function resample(input: Float32Array, inRate: number, chunk = input.length): Float32Array {
  const r = new StreamingResampler(inRate, 16_000);
  const parts: Float32Array[] = [];
  for (let i = 0; i < input.length; i += chunk) {
    parts.push(r.process(input.subarray(i, i + chunk)).slice());
  }
  parts.push(r.flush());
  return concat(parts);
}

describe('StreamingResampler', () => {
  it.each([48_000, 44_100, 22_050, 8_000])('keeps the duration from %i Hz', (rate) => {
    const out = resample(sine(440, rate, 1), rate);
    expect(Math.abs(out.length - 16_000)).toBeLessThanOrEqual(1);
  });

  it.each([48_000, 44_100])('passes a 1 kHz tone at full level from %i Hz', (rate) => {
    const out = resample(sine(1000, rate, 1), rate);
    // Skip the filter's edges.
    expect(rms(out, 400, out.length - 400)).toBeCloseTo(Math.SQRT1_2, 2);
  });

  it('keeps the tone at its frequency (zero crossings)', () => {
    const out = resample(sine(1000, 48_000, 1), 48_000);
    let crossings = 0;
    for (let i = 401; i < out.length - 400; i++) {
      if ((out[i - 1] ?? 0) < 0 !== (out[i] ?? 0) < 0) crossings++;
    }
    const seconds = (out.length - 801) / 16_000;
    expect(crossings / 2 / seconds).toBeCloseTo(1000, -1);
  });

  it('removes tones above the new Nyquist frequency instead of aliasing them', () => {
    const out = resample(sine(12_000, 48_000, 1), 48_000);
    expect(rms(out, 400, out.length - 400)).toBeLessThan(0.01); // < −40 dB
  });

  it('gives the same output whatever the chunk sizes', () => {
    const input = sine(330, 44_100, 0.5);
    const whole = resample(input, 44_100);
    for (const chunk of [128, 441, 1000, 7]) {
      const chunked = resample(input, 44_100, chunk);
      expect(chunked.length).toBe(whole.length);
      for (let i = 0; i < whole.length; i++) {
        expect(chunked[i]).toBeCloseTo(whole[i] ?? Number.NaN, 6);
      }
    }
  });

  it('passes DC at exactly 1', () => {
    const out = resample(new Float32Array(48_000).fill(0.5), 48_000);
    expect(out[8000]).toBeCloseTo(0.5, 5);
  });

  it('is a copy-through at the same rate', () => {
    const input = sine(100, 16_000, 0.1);
    const r = new StreamingResampler(16_000, 16_000);
    expect(Array.from(r.process(input))).toEqual(Array.from(input));
    expect(r.outputCount).toBe(input.length);
  });

  it('maps output samples to exact input positions', () => {
    const r = new StreamingResampler(48_000, 16_000);
    expect(r.inputPosition(16_000)).toBe(48_000);
    const r2 = new StreamingResampler(44_100, 16_000);
    expect(r2.inputPosition(160)).toBeCloseTo(441, 9);
  });

  it('holds back only about a millisecond of input', () => {
    const r = new StreamingResampler(48_000, 16_000);
    const out = r.process(new Float32Array(4800));
    expect(1600 - out.length).toBeLessThanOrEqual(Math.ceil(r.halfWidth / 3) + 1);
    expect(r.halfWidth).toBeLessThan(64);
  });

  it('rejects bad rates', () => {
    expect(() => new StreamingResampler(0, 16_000)).toThrow(RangeError);
  });
});

describe('downmix', () => {
  it('averages channels', () => {
    const l = Float32Array.from([1, 0.5, -1]);
    const r = Float32Array.from([0, 0.5, 1]);
    expect(Array.from(downmix([l, r]))).toEqual([0.5, 0.5, 0]);
  });

  it('copies mono and writes into a given buffer', () => {
    const out = new Float32Array(2);
    const result = downmix([Float32Array.from([0.25, -0.25])], out);
    expect(result).toBe(out);
    expect(Array.from(out)).toEqual([0.25, -0.25]);
  });

  it('returns silence for no channels', () => {
    expect(downmix([]).length).toBe(0);
  });
});

describe('FrameBatcher', () => {
  it('cuts any chunking into fixed frames with absolute start indexes', () => {
    const b = new FrameBatcher(4);
    const frames: [number[], number][] = [];
    const emit = (f: Float32Array, start: number) => frames.push([Array.from(f), start]);
    b.push(Float32Array.from([0, 1, 2]), emit);
    b.push(Float32Array.from([3, 4, 5, 6, 7, 8, 9]), emit);
    b.push(Float32Array.from([10, 11]), emit);
    expect(frames).toEqual([
      [[0, 1, 2, 3], 0],
      [[4, 5, 6, 7], 4],
      [[8, 9, 10, 11], 8],
    ]);
  });
});
