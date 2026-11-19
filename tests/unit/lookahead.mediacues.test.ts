/**
 * Cues on the video's timeline in the overlay: shown by media time (playing, paused, seeking,
 * any rate), reused after a seek back, live duplicates dropped, lookahead winning where it has
 * finished subtitles, and the clock that places live cues.
 */
import { describe, expect, it } from 'vitest';
import { MAX_MEDIA_CUES, MediaClock, MediaCues, share } from '@/overlay/mediacues';
import type { Cue } from '@/pipeline/types';

function cue(id: string, start: number, end: number, origin: Cue['origin'] = 'lookahead'): Cue {
  return {
    id,
    seq: 1,
    startEpochMs: 0,
    endEpochMs: 0,
    origin,
    media: { timeline: 'v', start, end },
    source: { text: `Ligne ${id}`, language: 'fr', final: true },
    translation: { text: `Line ${id}`, language: 'en', final: true },
    untranslated: null,
  };
}

const ids = (m: MediaCues, t: number) => {
  m.advance('v', t);
  return m.visible(t).map((b) => b.id);
};

describe('MediaCues', () => {
  it('shows a cue from its start to the end of its speech, by media time', () => {
    const m = new MediaCues();
    m.add(cue('a', 2, 6));
    m.add(cue('b', 10, 11));
    expect(ids(m, 0)).toEqual([]);
    expect(ids(m, 1.99)).toEqual([]);
    expect(ids(m, 2)).toEqual(['a']);
    // Long speech: held to its end, not just its reading time.
    expect(ids(m, 5.9)).toEqual(['a']);
    expect(ids(m, 7)).toEqual([]);
    expect(ids(m, 10.2)).toEqual(['b']);
  });

  it('stays still while paused and follows any playback rate', () => {
    const m = new MediaCues();
    m.add(cue('a', 2, 3));
    expect(ids(m, 2.5)).toEqual(['a']);
    // Paused: the same time over and over.
    for (let i = 0; i < 5; i++) expect(ids(m, 2.5)).toEqual(['a']);
    // 2×: the media clock still says when.
    m.add(cue('b', 3.4, 4));
    expect(ids(m, 3.0)).toEqual(['a']);
    expect(ids(m, 3.5)).toContain('b');
  });

  it('shows the cue at once after a seek back, and none after a seek past it', () => {
    const m = new MediaCues();
    m.add(cue('a', 2, 4));
    m.add(cue('b', 20, 22));
    expect(ids(m, 21)).toEqual(['b']);
    expect(ids(m, 2.5)).toEqual(['a']);
    expect(ids(m, 30)).toEqual([]);
  });

  it('shows a cue that arrives late from now, and replaces a changed one in place', () => {
    const m = new MediaCues();
    expect(ids(m, 5)).toEqual([]);
    m.add(cue('a', 4.8, 6));
    expect(ids(m, 5.1)).toEqual(['a']);
    const changed = cue('a', 4.8, 6);
    changed.translation = { text: 'Another line', language: 'en', final: true };
    m.add(changed);
    const block = m.visible(5.2)[0];
    expect(block?.lines.some((l) => l.rows.join(' ').includes('Another line'))).toBe(true);
  });

  it('drops a live cue that repeats kept speech; a lookahead cue replaces live ones', () => {
    const m = new MediaCues();
    m.add(cue('la', 10, 12));
    expect(m.addLive(cue('live1', 0, 0, 'live'), { timeline: 'v', start: 10.2, end: 12.1 })).toBe(
      false,
    );
    expect(m.addLive(cue('live2', 0, 0, 'live'), { timeline: 'v', start: 20, end: 22 })).toBe(true);
    expect(m.size).toBe(2);
    m.add(cue('la2', 19.8, 22.2));
    expect(m.size).toBe(2);
    // A kept live cue shows again when its stretch plays again.
    expect(m.addLive(cue('live3', 0, 0, 'live'), { timeline: 'v', start: 30, end: 31 })).toBe(true);
    expect(ids(m, 30.5)).toEqual(['live3']);
  });

  it('shows only lookahead cues where lookahead has finished subtitles', () => {
    const m = new MediaCues();
    m.add(cue('la', 10, 12));
    m.addLive(cue('live', 0, 0, 'live'), { timeline: 'v', start: 13, end: 14 });
    m.setCoverage('v', [[0, 20]]);
    expect(m.covered('v', 13.5)).toBe(true);
    expect(ids(m, 13.5)).toEqual([]);
    expect(m.covered('v', 25)).toBe(false);
  });

  it('forgets lookahead cues whose audio was replaced', () => {
    const m = new MediaCues();
    m.add(cue('a', 2, 3));
    m.add(cue('b', 8, 9));
    m.setCoverage('v', [[0, 20]]);
    expect(ids(m, 8.5)).toEqual(['b']);
    m.drop('v', 5, 20);
    expect(ids(m, 8.5)).toEqual([]);
    expect(m.covered('v', 8.5)).toBe(false);
    expect(ids(m, 2.5)).toEqual(['a']);
  });

  it('lets live lines show in a finished stretch that holds no lookahead cue', () => {
    const m = new MediaCues();
    m.addLive(cue('live', 0, 0, 'live'), { timeline: 'v', start: 13, end: 14 });
    // Finished per the session, but none of its cues are here (an overlay that came back).
    m.setCoverage('v', [[0, 20]]);
    expect(m.covered('v', 13.5)).toBe(false);
    expect(ids(m, 13.5)).toEqual(['live']);
    m.add(cue('la', 2, 3));
    expect(m.covered('v', 13.5)).toBe(true);
  });

  it('keeps cues whose audio may come back until new ones replace them', () => {
    const m = new MediaCues();
    m.add(cue('a', 2, 3));
    m.add(cue('b', 8, 9));
    m.add(cue('c', 12, 13));
    m.setCoverage('v', [[0, 20]]);
    // The player cleared its buffer on a seek: kept, and shown on a seek back.
    m.drop('v', 5, 20, true);
    expect(ids(m, 8.5)).toEqual(['b']);
    // Made again: the new cue replaces the old one over the same speech.
    m.add(cue('b2', 8.1, 9));
    expect(ids(m, 8.5)).toEqual(['b2']);
    expect(m.size).toBe(3);
    // The stretch is finished again with nothing new over `c`: it goes.
    m.setCoverage('v', [[0, 20]]);
    expect(ids(m, 12.5)).toEqual([]);
    expect(m.size).toBe(2);
  });

  it('says when the picture changes next', () => {
    const m = new MediaCues();
    m.add(cue('a', 2, 3));
    m.setCoverage('v', [[0, 10]]);
    m.advance('v', 1);
    expect(m.nextEvent('v', 1)).toBe(2);
    m.advance('v', 2.1);
    const next = m.nextEvent('v', 2.1) ?? 0;
    expect(next).toBeGreaterThan(2.1);
    expect(next).toBeLessThanOrEqual(10);
  });

  it('keeps a bounded number of cues, dropping those far from the playhead', () => {
    const m = new MediaCues();
    m.advance('v', 0);
    m.setCoverage('v', [[0, MAX_MEDIA_CUES + 50]]);
    for (let i = 0; i < MAX_MEDIA_CUES + 50; i++) m.add(cue(`c${i}`, i, i + 0.5));
    expect(m.size).toBeLessThanOrEqual(MAX_MEDIA_CUES);
    expect(ids(m, 0.2)).toEqual(['c0']);
    // The stretches of cues let go are no longer counted as finished: live lines may show there.
    expect(m.covered('v', MAX_MEDIA_CUES - 200 + 0.2)).toBe(false);
    expect(m.covered('v', 10.2)).toBe(true);
  });
});

describe('MediaClock', () => {
  it('maps when something was heard to where the video was', () => {
    const clock = new MediaClock();
    clock.record(1000, 10, 1, false, 'v');
    clock.record(3000, 12, 1, false, 'v');
    expect(clock.toMedia(2500, 'v')).toBeCloseTo(11.5);
    clock.record(4000, 13, 1, true, 'v');
    expect(clock.toMedia(9000, 'v')).toBe(13);
    // Another video, or before the record: unknown.
    expect(clock.toMedia(2500, 'w')).toBeNull();
    expect(clock.toMedia(500, 'v')).toBeNull();
    // At 2×.
    clock.record(10_000, 20, 2, false, 'v');
    expect(clock.toMedia(10_500, 'v')).toBeCloseTo(21);
  });

  it('measures overlap as a share of the first span', () => {
    expect(share({ start: 0, end: 2 }, { start: 1, end: 5 })).toBe(0.5);
    expect(share({ start: 0, end: 2 }, { start: 3, end: 5 })).toBe(0);
  });
});
