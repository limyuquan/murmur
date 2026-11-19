/**
 * Measuring the playback lag: the live capture against lookahead's decoded audio of the same
 * moments, placed by the playhead reports.
 */
import { describe, expect, it } from 'vitest';
import { bestMatch, DEFAULT_LAG_S, LagCalibrator, MAX_LAG_S } from '@/lookahead/calibrate';
import { PCM_RATE, PcmTimeline } from '@/lookahead/pcm';

/** Speech-like test audio: noise under a syllable-rate envelope (seeded). */
function speechy(seconds: number, seed = 1): Float32Array {
  let state = seed >>> 0 || 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296 - 0.5;
  };
  const out = new Float32Array(Math.round(seconds * PCM_RATE));
  let low = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / PCM_RATE;
    const envelope = Math.max(
      0,
      Math.sin(2 * Math.PI * 3.7 * t) + 0.3 * Math.sin(2 * Math.PI * 0.9 * t),
    );
    low = 0.7 * low + 0.3 * random();
    out[i] = 0.5 * envelope * low;
  }
  return out;
}

describe('bestMatch', () => {
  it('finds the offset to the sample', () => {
    const reference = speechy(4.4);
    const maxOffset = Math.round(MAX_LAG_S * PCM_RATE);
    for (const offset of [0, 1, 1234, 2048, maxOffset]) {
      const live = reference.slice(offset, offset + 4 * PCM_RATE);
      const match = bestMatch(live, reference, maxOffset);
      expect(match.offset).toBe(offset);
      expect(match.correlation).toBeGreaterThan(0.99);
    }
  });
});

/**
 * A video's audio decoded into a PCM timeline, playing from `from` (media s) at epoch `t0`, heard
 * `lag` seconds late in 20 ms frames, with a playhead report every second.
 */
function play(
  calibrator: LagCalibrator,
  options: { lag: number; seconds: number; from?: number; gain?: number; seekAt?: number },
) {
  const media = speechy(30);
  const pcm = new PcmTimeline();
  pcm.write(0, media);
  const t0 = 1_000_000;
  const from = options.from ?? 2;
  const frame = 320;
  let seek = 0;
  for (let n = 0; n * frame < options.seconds * PCM_RATE; n++) {
    const at = t0 + (n * frame * 1000) / PCM_RATE;
    if (options.seekAt !== undefined && at >= t0 + options.seekAt * 1000) seek = 5;
    const playhead = from + seek + (at - t0) / 1000;
    if (n % 50 === 0) {
      calibrator.onPlayhead('ms1', { time: playhead, rate: 1, paused: false, at });
    }
    const start = Math.round((playhead - options.lag) * PCM_RATE);
    const samples = media.slice(start, start + frame).map((v) => v * (options.gain ?? 1));
    calibrator.onLiveFrame(samples, at);
  }
  const now = t0 + options.seconds * 1000;
  return { pcm, now };
}

describe('LagCalibrator', () => {
  it('starts at the default and measures the lag from a few windows', () => {
    const c = new LagCalibrator();
    expect(c.lagS).toBe(DEFAULT_LAG_S);
    const { pcm, now } = play(c, { lag: 0.128, seconds: 8 });
    expect(c.attempt(now, () => pcm)).toBeCloseTo(0.128, 3);
    expect(c.estimate).toMatchObject({ lagS: 0.128, measured: true, tries: 1 });
    // Not again before its time; then more windows until it is settled.
    expect(c.attempt(now + 500, () => pcm)).toBeNull();
    expect(c.estimate.tries).toBe(1);
    c.attempt(now + 2500, () => pcm);
    c.attempt(now + 5000, () => pcm);
    expect(c.done).toBe(true);
    expect(c.estimate.windows).toHaveLength(3);
    expect(c.lagS).toBeCloseTo(0.128, 3);
  });

  it('keeps within 0 to 300 ms', () => {
    const c = new LagCalibrator();
    const { pcm, now } = play(c, { lag: 0, seconds: 8 });
    expect(c.attempt(now, () => pcm)).toBe(0);
    const late = new LagCalibrator();
    const played = play(late, { lag: MAX_LAG_S, seconds: 8 });
    expect(late.attempt(played.now, () => played.pcm)).toBeCloseTo(MAX_LAG_S, 3);
  });

  it('skips a window with a seek in it, a quiet one, or audio it doesn’t have', () => {
    const seek = new LagCalibrator();
    const a = play(seek, { lag: 0.1, seconds: 8, seekAt: 6 });
    expect(seek.attempt(a.now, () => a.pcm)).toBeNull();
    expect(seek.estimate.measured).toBe(false);

    const quiet = new LagCalibrator();
    const b = play(quiet, { lag: 0.1, seconds: 8, gain: 0.001 });
    expect(quiet.attempt(b.now, () => b.pcm)).toBeNull();
    expect(quiet.lagS).toBe(DEFAULT_LAG_S);

    const missing = new LagCalibrator();
    const c = play(missing, { lag: 0.1, seconds: 8 });
    expect(missing.attempt(c.now, () => new PcmTimeline())).toBeNull();
    expect(missing.estimate.tries).toBe(0);
  });

  it('rejects audio that doesn’t match (other sounds in the tab)', () => {
    const c = new LagCalibrator();
    const { now } = play(c, { lag: 0.1, seconds: 8 });
    const other = new PcmTimeline();
    other.write(0, speechy(30, 99));
    expect(c.attempt(now, () => other)).toBeNull();
    expect(c.estimate).toMatchObject({ measured: false, tries: 1 });
  });
});
