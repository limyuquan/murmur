/** Telling a session whose models keep falling behind the speech. */
import { describe, expect, it } from 'vitest';
import { describeSlowness, SlownessWatch } from '@/engines/slowness';

/** One line every 5 s. */
const at = (i: number) => i * 5000;

describe('slowness watch', () => {
  it('finds a translator over its budget on a fifth of a full window of 30 lines', () => {
    const watch = new SlownessWatch();
    // E4B on a MacBook Air M2: 15 of 63 lines too slow, spread out (every fourth line here).
    const seen = [];
    for (let i = 0; i < 63; i++) {
      const found = watch.onTranslated({ slow: i % 4 === 3 }, at(i));
      if (found) seen.push({ i, found });
    }
    // Not before the window is full (30 lines), and over at least two minutes.
    expect(seen).toEqual([{ i: 29, found: { engine: 'translator', slow: 7, lines: 30 } }]);
    expect(describeSlowness(seen[0]?.found as never, 3000)).toBe(
      'took longer than 3 s on 7 of the last 30 lines',
    );
  });

  it('needs the late lines spread over two minutes: one busy stretch isn’t enough', () => {
    // Another program takes the graphics card for 20 s: 7 lines in a row late, then fine.
    const watch = new SlownessWatch();
    for (let i = 0; i < 100; i++) {
      const stalled = i >= 40 && i < 47;
      expect(watch.onTranslated({ slow: stalled }, i * 3000)).toBeNull();
    }
    // 30 lines in a minute, all late, then on time.
    const burst = new SlownessWatch();
    for (let i = 0; i < 30; i++) expect(burst.onTranslated({ slow: true }, i * 2000)).toBeNull();
    for (let i = 30; i < 60; i++) expect(burst.onTranslated({ slow: false }, i * 5000)).toBeNull();
  });

  it('ignores late lines that mostly waited for the line before', () => {
    const watch = new SlownessWatch();
    for (let i = 0; i < 100; i++) {
      // Every line late, but each waited 2 s of its 3 s behind a stalled one.
      expect(watch.onTranslated({ slow: true, waitedMs: 2000 }, at(i))).toBeNull();
    }
    // Waiting a little doesn't excuse it.
    const other = new SlownessWatch();
    let found = null;
    for (let i = 0; i < 30 && !found; i++) {
      found = other.onTranslated({ slow: i % 2 === 0, waitedMs: 500 }, at(i));
    }
    expect(found).toMatchObject({ engine: 'translator', lines: 30 });
  });

  it('forgets slow lines older than the window', () => {
    const watch = new SlownessWatch();
    let i = 0;
    // Five slow lines, then 30 on time: the window holds none of them any more.
    for (; i < 5; i++) expect(watch.onTranslated({ slow: true }, at(i))).toBeNull();
    for (; i < 35; i++) expect(watch.onTranslated({ slow: false }, at(i))).toBeNull();
    for (; i < 40; i++) expect(watch.onTranslated({ slow: true }, at(i))).toBeNull();
    // One in 10 (RTX 3070 with E4B: none over the budget) never adds up.
    const fast = new SlownessWatch();
    for (let j = 0; j < 300; j++) {
      expect(fast.onTranslated({ slow: j % 10 === 0 }, at(j))).toBeNull();
    }
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
    expect(watch.onTranslated({ slow: true })).toBeNull();
  });

  it('takes its thresholds as options', () => {
    const watch = new SlownessWatch({
      lines: 10,
      maxSlowShare: 0.5,
      maxRtf: 1,
      rtfLines: 2,
      minSpanMs: 0,
    });
    for (let i = 0; i < 9; i++) expect(watch.onTranslated({ slow: i < 5 }, i)).toBeNull();
    expect(watch.onTranslated({ slow: true }, 9)).toMatchObject({ engine: 'translator', slow: 6 });
    const asr = new SlownessWatch({ maxRtf: 1, rtfLines: 2 });
    expect(asr.onRecognized(0.9)).toBeNull();
    expect(asr.onRecognized(1.1)).toBeNull();
    expect(asr.onRecognized(1.2)).toMatchObject({ engine: 'asr', lines: 2 });
  });
});
