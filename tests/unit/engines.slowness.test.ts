/** Telling a session whose models keep falling behind the speech. */
import { describe, expect, it } from 'vitest';
import { describeSlowness, SlownessWatch } from '@/engines/slowness';

describe('slowness watch', () => {
  it('finds a translator over its budget on a fifth of the last 30 lines', () => {
    const watch = new SlownessWatch();
    // E4B on a MacBook Air M2: 15 of 63 lines too slow, spread out (every fourth line here).
    const seen = [];
    for (let i = 0; i < 63; i++) {
      const found = watch.onTranslated(i % 4 === 3);
      if (found) seen.push({ i, found });
    }
    expect(seen).toEqual([{ i: 23, found: { engine: 'translator', slow: 6, lines: 24 } }]);
    expect(describeSlowness(seen[0]?.found as never, 3000)).toBe(
      'took longer than 3 s on 6 of the last 24 lines',
    );
  });

  it('forgets slow lines older than the window', () => {
    const watch = new SlownessWatch();
    // Five slow lines, then 30 on time: the window holds none of them any more.
    for (let i = 0; i < 5; i++) expect(watch.onTranslated(true)).toBeNull();
    for (let i = 0; i < 30; i++) expect(watch.onTranslated(false)).toBeNull();
    for (let i = 0; i < 5; i++) expect(watch.onTranslated(true)).toBeNull();
    // One in 10 (RTX 3070 with E4B: none over the budget) never adds up.
    const fast = new SlownessWatch();
    for (let i = 0; i < 300; i++) expect(fast.onTranslated(i % 10 === 0)).toBeNull();
  });

  it('finds speech recognition that stays slower than 0.6 s per second of speech', () => {
    const watch = new SlownessWatch();
    // Unmeasured lines don't count; a fast line starts the count again.
    for (let i = 0; i < 14; i++) expect(watch.onRecognized(0.7)).toBeNull();
    expect(watch.onRecognized(null)).toBeNull();
    expect(watch.onRecognized(0.5)).toBeNull();
    for (let i = 0; i < 14; i++) expect(watch.onRecognized(0.8)).toBeNull();
    const found = watch.onRecognized(0.9);
    expect(found).toEqual({ engine: 'asr', rtf: 0.9, lines: 15 });
    expect(describeSlowness(found as never, 3000)).toBe(
      'took 0.9 s per second of speech for 15 lines in a row',
    );
    // Once only.
    expect(watch.onRecognized(0.9)).toBeNull();
    expect(watch.onTranslated(true)).toBeNull();
  });

  it('takes its thresholds as options', () => {
    const watch = new SlownessWatch({ lines: 10, maxSlowShare: 0.5, maxRtf: 1, rtfLines: 2 });
    for (let i = 0; i < 4; i++) expect(watch.onTranslated(true)).toBeNull();
    expect(watch.onTranslated(true)).toMatchObject({ engine: 'translator', slow: 5 });
    const asr = new SlownessWatch({ maxRtf: 1, rtfLines: 2 });
    expect(asr.onRecognized(0.9)).toBeNull();
    expect(asr.onRecognized(1.1)).toBeNull();
    expect(asr.onRecognized(1.2)).toMatchObject({ engine: 'asr', lines: 2 });
  });
});
