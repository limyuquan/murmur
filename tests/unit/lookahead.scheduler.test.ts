/**
 * Lookahead's scheduling rules: nearest the playhead first, never behind it, within the horizon,
 * stepping over what's done; the lead, and the live path's switch with its hysteresis.
 */
import { describe, expect, it } from 'vitest';
import {
  HORIZON_S,
  LiveGate,
  leadOf,
  nextWork,
  PAUSE_LIVE_S,
  playheadAt,
  RESUME_LIVE_S,
} from '@/lookahead/scheduler';
import { SpanSet } from '@/lookahead/spans';

function spans(...list: [number, number][]): SpanSet {
  const set = new SpanSet(0.05);
  for (const [s, e] of list) set.add(s, e);
  return set;
}

describe('nextWork', () => {
  it('starts at the playhead, never behind it, and stops at the horizon', () => {
    expect(nextWork(10, [[0, 300]], spans())).toEqual([10, 10 + HORIZON_S]);
    expect(nextWork(10, [[0, 30]], spans())).toEqual([10, 30]);
  });

  it('steps over what is done, to the first stretch that is not', () => {
    expect(nextWork(10, [[0, 60]], spans([0, 25]))).toEqual([25, 60]);
    expect(nextWork(10, [[0, 60]], spans([0, 25], [30, 40]))).toEqual([25, 30]);
    // A gap too short to matter is skipped.
    expect(nextWork(10, [[0, 60]], spans([0, 25], [25.1, 40]))).toEqual([40, 60]);
    // Done right up to (or just past) the end: nothing, even at the span's edge.
    expect(nextWork(25, [[0, 25.02]], spans([0, 25]))).toBeNull();
    expect(nextWork(24.99, [[0, 60]], spans([0, 25]))).toEqual([25, 60]);
  });

  it('takes the nearest decoded stretch after the playhead', () => {
    expect(
      nextWork(
        50,
        [
          [0, 20],
          [55, 80],
          [120, 200],
        ],
        spans(),
      ),
    ).toEqual([55, 80]);
    // Beyond the horizon: nothing yet.
    expect(nextWork(0, [[100, 200]], spans())).toBeNull();
  });
});

describe('lead and the live path', () => {
  it('is how far finished subtitles reach past the playhead', () => {
    const done = spans([0, 30]);
    expect(leadOf(10, done)).toBe(20);
    expect(leadOf(31, done)).toBe(0);
    expect(leadOf(10, spans([12, 30]))).toBe(0);
  });

  it('pauses live at 3 s of lead and resumes under 1.5 s', () => {
    const gate = new LiveGate();
    expect(gate.update(2.9)).toBe(false);
    expect(gate.update(PAUSE_LIVE_S)).toBe(true);
    expect(gate.update(2)).toBe(true);
    expect(gate.update(RESUME_LIVE_S - 0.01)).toBe(false);
    expect(gate.update(2.5)).toBe(false);
  });

  it('extrapolates the playhead while playing', () => {
    const p = { time: 10, rate: 2, paused: false, at: 1000 };
    expect(playheadAt(p, 2000)).toBe(12);
    expect(playheadAt({ ...p, paused: true }, 2000)).toBe(10);
  });
});
