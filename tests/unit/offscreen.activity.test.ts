import { describe, expect, it } from 'vitest';
import { overlayStatus, type SessionActivity } from '@/messaging/protocol';
import { ActivityTracker, activityChanged, LATE } from '@/offscreen/activity';
import type { Cue } from '@/pipeline/types';

function cue(id: string, seq: number, patch: Partial<Cue> = {}): Cue {
  return {
    id,
    seq,
    startEpochMs: 0,
    endEpochMs: 1000,
    source: { text: `said ${id}`, language: 'fr', final: true },
    translation: { text: `meant ${id}`, language: 'en', final: true },
    untranslated: null,
    ...patch,
  };
}

const loud = new Float32Array(320).fill(0.1);
const quiet = new Float32Array(320);

describe('ActivityTracker', () => {
  it('reports the stage from the newest lines', () => {
    const t = new ActivityTracker(0);
    expect(t.snapshot(0).stage).toBe('listening');
    t.onCue(
      cue('a', 1, {
        source: { text: 'sa', language: 'fr', final: false },
        translation: null,
        untranslated: 'pending',
      }),
      0,
    );
    expect(t.snapshot(0).stage).toBe('transcribing');
    t.onCue(cue('a', 1, { translation: null, untranslated: 'pending' }), 0);
    expect(t.snapshot(0).stage).toBe('translating');
    t.onCue(cue('a', 1), 0);
    expect(t.snapshot(0).stage).toBe('listening');
  });

  it('lists languages heard, most heard first, and those the engines lack', () => {
    const t = new ActivityTracker(0, { supports: (l) => l !== 'xx' });
    t.onCue(cue('a', 1, { source: { text: 'a', language: 'de', final: true } }), 0);
    t.onCue(cue('b', 2), 0);
    t.onCue(cue('c', 3, { source: { text: 'c', language: 'fr-CA', final: true } }), 0);
    t.onCue(cue('d', 4, { source: { text: 'd', language: 'xx', final: true } }), 0);
    expect(t.snapshot(0)).toMatchObject({ languages: ['fr', 'de', 'xx'], unsupported: ['xx'] });
  });

  it('measures the delay from speech end to the finished line', () => {
    const t = new ActivityTracker(0);
    t.onCue(cue('a', 1, { endEpochMs: 1000 }), 3500);
    expect(t.snapshot(3500)).toMatchObject({ delayMs: 2500, behind: false });
    t.onCue(cue('b', 2, { endEpochMs: 2000 }), 10_000);
    t.onCue(cue('c', 3, { endEpochMs: 3000 }), 11_000);
    expect(t.snapshot(11_000)).toMatchObject({ delayMs: 8000, behind: true });
  });

  it('counts a backlog of untranslated lines as falling behind', () => {
    const t = new ActivityTracker(0, { maxBacklog: 2 });
    t.onCue(cue('a', 1, { translation: null, untranslated: 'pending' }), 0);
    expect(t.snapshot(0).behind).toBe(false);
    t.onCue(cue('b', 2, { translation: null, untranslated: 'pending' }), 0);
    expect(t.snapshot(0).behind).toBe(true);
  });

  it('falls behind when the speech engine is slower than real time or says so', () => {
    const t = new ActivityTracker(0);
    const health = { behind: false, backlogMs: 0, droppedPartials: 0, droppedSegments: 0 };
    t.onHealth({ ...health, rtf: 0.4 });
    expect(t.snapshot(0)).toMatchObject({ behind: false, rtf: 0.4 });
    t.onHealth({ ...health, rtf: 1.3, backlogMs: 5000 });
    expect(t.snapshot(0)).toMatchObject({ behind: true, rtf: 1.3, backlogMs: 5000 });
    t.onHealth({ ...health, rtf: null, behind: true });
    expect(t.snapshot(0).behind).toBe(true);
  });

  it('lists languages an engine refused, once heard', () => {
    const t = new ActivityTracker(0);
    t.onUnsupported('xx-YY');
    t.onCue(cue('a', 1, { source: { text: 'a', language: 'xx', final: true } }), 0);
    expect(t.snapshot(0).unsupported).toEqual(['xx']);
  });

  it('tracks silence', () => {
    const t = new ActivityTracker(1000);
    t.onFrame(quiet, 2000);
    expect(t.snapshot(9000)).toMatchObject({ silentMs: 8000, soundEver: false });
    t.onFrame(loud, 9000);
    expect(t.snapshot(9500)).toMatchObject({ silentMs: 500, soundEver: true });
  });
});

describe('the overlay’s late chip', () => {
  /** A finished line every second from `from` to `to` (ms), each `delay` ms after its speech. */
  function lines(
    t: ActivityTracker,
    from: number,
    to: number,
    delay: number,
    seen: (number | null)[],
  ) {
    for (let now = from; now < to; now += 1000) {
      t.onCue(cue(`l${now}`, now, { endEpochMs: now - delay }), now);
      seen.push(t.snapshot(now).lateMs);
    }
  }
  const chip = (a: SessionActivity) =>
    overlayStatus({
      state: 'running',
      tabId: 1,
      sessionId: 's',
      asr: 'a',
      translation: 't',
      heard: true,
      activity: a,
    });

  it('stays off at a normal delay, even while the popup says the session is behind', () => {
    const t = new ActivityTracker(0, { maxBacklog: 2 });
    const seen: (number | null)[] = [];
    lines(t, 1000, 20_000, 1000, seen);
    // A line or two slower than the rest, two lines waiting for translation, a slow moment.
    t.onCue(cue('slow', 30_000, { endEpochMs: 18_000 }), 20_500);
    t.onCue(cue('w1', 30_001, { translation: null, untranslated: 'pending' }), 20_600);
    t.onCue(cue('w2', 30_002, { translation: null, untranslated: 'pending' }), 20_700);
    t.onHealth({
      behind: false,
      backlogMs: 1200,
      droppedPartials: 0,
      droppedSegments: 0,
      rtf: 1.2,
    });
    const now = t.snapshot(21_000);
    expect(now.behind).toBe(true);
    expect(now.delayMs).toBeLessThan(3000);
    expect(now.lateMs).toBeNull();
    expect(chip(now)).toEqual({ state: 'running', behindMs: null });
    expect(seen.every((x) => x === null)).toBe(true);
  });

  it('shows a delay over 4 s once it has lasted, and hides it with hysteresis', () => {
    const t = new ActivityTracker(0);
    const seen: (number | null)[] = [];
    lines(t, 1000, 10_000, 1000, seen);
    // From 10 s on, every line 6 s late: shown after `absoluteForMs`, not at once.
    const late: (number | null)[] = [];
    lines(t, 10_000, 20_000, 6000, late);
    const firstShown = late.findIndex((x) => x !== null);
    expect(firstShown).toBeGreaterThanOrEqual(LATE.absoluteForMs / 1000);
    expect(late.at(-1)).toBe(6000);
    expect(chip(t.snapshot(20_000))).toEqual({ state: 'running', behindMs: 6000 });
    // Back to 3.2 s (under 4 s but over the hide line): it stays.
    const easing: (number | null)[] = [];
    lines(t, 20_000, 26_000, 3200, easing);
    expect(easing.every((x) => x !== null)).toBe(true);
    // Back to normal: it goes, after `hideForMs` under the hide line, not on the first line.
    const normal: (number | null)[] = [];
    lines(t, 26_000, 36_000, 1000, normal);
    const firstHidden = normal.indexOf(null);
    expect(firstHidden).toBeGreaterThan(0);
    expect(normal.slice(firstHidden).every((x) => x === null)).toBe(true);
  });

  it('shows twice the session’s typical delay only when it lasts over 5 s', () => {
    const t = new ActivityTracker(0);
    const seen: (number | null)[] = [];
    lines(t, 1000, 20_000, 1400, seen);
    // 3.5 s for 4 s: not long enough.
    const brief: (number | null)[] = [];
    lines(t, 20_000, 24_000, 3500, brief);
    expect(brief.every((x) => x === null)).toBe(true);
    lines(t, 24_000, 30_000, 1400, seen);
    // 3.5 s for 8 s: shown once it has lasted 5 s.
    const sustained: (number | null)[] = [];
    lines(t, 30_000, 38_000, 3500, sustained);
    const firstShown = sustained.findIndex((x) => x !== null);
    expect(firstShown).toBeGreaterThanOrEqual(LATE.relativeForMs / 1000);
    expect(sustained.at(-1)).toBe(3500);
  });

  it('counts speech stuck waiting for recognition', () => {
    const t = new ActivityTracker(0);
    const seen: (number | null)[] = [];
    lines(t, 1000, 6000, 1000, seen);
    const health = { behind: true, droppedPartials: 0, droppedSegments: 0, rtf: 2 };
    t.onHealth({ ...health, backlogMs: 7000 });
    expect(t.snapshot(6000).lateMs).toBeNull();
    t.onHealth({ ...health, backlogMs: 10_000 });
    expect(t.snapshot(9500).lateMs).toBe(10_000);
  });
});

describe('activityChanged', () => {
  it('ignores small changes in delay and silence', () => {
    const t = new ActivityTracker(0);
    const a = t.snapshot(100);
    expect(activityChanged(undefined, a)).toBe(true);
    expect(activityChanged(a, { ...a, silentMs: 900 })).toBe(false);
    expect(activityChanged(a, { ...a, silentMs: 9000 })).toBe(true);
    expect(activityChanged(a, { ...a, stage: 'translating' })).toBe(true);
  });
});
