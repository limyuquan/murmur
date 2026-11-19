import { describe, expect, it } from 'vitest';
import { ActivityTracker, activityChanged } from '@/offscreen/activity';
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

  it('tracks silence', () => {
    const t = new ActivityTracker(1000);
    t.onFrame(quiet, 2000);
    expect(t.snapshot(9000)).toMatchObject({ silentMs: 8000, soundEver: false });
    t.onFrame(loud, 9000);
    expect(t.snapshot(9500)).toMatchObject({ silentMs: 500, soundEver: true });
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
