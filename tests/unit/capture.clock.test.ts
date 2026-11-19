import { describe, expect, it } from 'vitest';
import { contextTimeToEpochMs, msToSamples, SampleClock, samplesToMs } from '@/capture/clock';

describe('contextTimeToEpochMs', () => {
  it('maps context time through the output timestamp', () => {
    const stamp = { contextTime: 10, performanceTime: 5_000 };
    expect(contextTimeToEpochMs(10, stamp, 1_000_000)).toBe(1_005_000);
    expect(contextTimeToEpochMs(10.5, stamp, 1_000_000)).toBe(1_005_500);
    expect(contextTimeToEpochMs(9.75, stamp, 1_000_000)).toBe(1_004_750);
  });
});

describe('SampleClock', () => {
  it('is NaN until anchored', () => {
    const c = new SampleClock();
    expect(c.anchored).toBe(false);
    expect(c.toEpochMs(0)).toBeNaN();
  });

  it('converts both ways from the latest anchor', () => {
    const c = new SampleClock(16_000);
    c.anchor(16_000, 2_000_000);
    expect(c.toEpochMs(16_000)).toBe(2_000_000);
    expect(c.toEpochMs(24_000)).toBe(2_000_500);
    expect(c.toEpochMs(0)).toBe(1_999_000);
    expect(c.toSample(2_000_250)).toBe(20_000);
  });

  it('follows re-anchoring (drift correction)', () => {
    const c = new SampleClock(16_000);
    c.anchor(0, 1000);
    c.anchor(16_000, 2003);
    expect(c.toEpochMs(32_000)).toBe(3003);
  });
});

describe('sample/ms helpers', () => {
  it('round-trips', () => {
    expect(msToSamples(20)).toBe(320);
    expect(samplesToMs(320)).toBe(20);
  });
});
