import { describe, expect, it } from 'vitest';
import { LOOKAHEAD_CUT_AHEAD_MS } from '@/pipeline/pipeline';
import { type SegmentEvent, Segmenter } from '@/pipeline/segmenter';
import { EnergyVad, rmsDb } from '@/pipeline/vad';
import { burst, concat, sine } from './helpers';

const RATE = 16_000;
const ms = (n: number) => (n / 1000) * RATE;

function run(segmenter: Segmenter, audio: Float32Array, chunk = 320): SegmentEvent[] {
  const events: SegmentEvent[] = [];
  for (let i = 0; i < audio.length; i += chunk) {
    events.push(...segmenter.push(audio.subarray(i, i + chunk), i));
  }
  return events;
}

const boundaries = (events: SegmentEvent[]) =>
  events.filter((e) => e.type !== 'audio').map((e) => ({ ...e }));

describe('EnergyVad', () => {
  it('ramps from 0 to 1 around the threshold', () => {
    const vad = new EnergyVad({ thresholdDb: -40, rampDb: 10 });
    expect(vad.process(new Float32Array(320))).toBe(0);
    expect(vad.process(burst(0.02, 0.5))).toBe(1);
    // A sine's RMS is amplitude/√2: −40 dBFS RMS.
    expect(vad.process(burst(0.02, 0.01 * Math.SQRT2))).toBeCloseTo(0.5, 1);
  });

  it('measures RMS in dBFS', () => {
    expect(rmsDb(new Float32Array(10).fill(1))).toBeCloseTo(0, 6);
    expect(rmsDb(new Float32Array(10))).toBe(-Infinity);
  });
});

describe('Segmenter, pause strategy', () => {
  const options = {
    strategy: 'pause' as const,
    minSpeechMs: 100,
    hangoverMs: 300,
    preRollMs: 200,
    maxSegmentMs: 5000,
  };

  it('opens pre-roll before speech and ends at the end of speech', () => {
    const audio = concat([burst(1, 0), burst(1, 0.3), burst(1, 0)]);
    const events = boundaries(run(new Segmenter(new EnergyVad(), options), audio));
    expect(events).toEqual([
      { type: 'start', segmentId: 's1', startSample: ms(800) },
      { type: 'end', segmentId: 's1', endSample: ms(2000), reason: 'silence' },
    ]);
  });

  it('streams contiguous audio from the start sample on', () => {
    const audio = concat([burst(1, 0), burst(1, 0.3), burst(1, 0)]);
    const events = run(new Segmenter(new EnergyVad(), options), audio);
    const chunks = events.filter((e) => e.type === 'audio');
    let expected = ms(800);
    for (const c of chunks) {
      expect(c.startSample).toBe(expected);
      expected += c.samples.length;
    }
    // Audio runs through the hangover: speech end + 300 ms.
    expect(expected).toBe(ms(2300));
  });

  it('ignores blips shorter than minSpeechMs', () => {
    const audio = concat([burst(0.5, 0), burst(0.06, 0.3), burst(1, 0)]);
    expect(boundaries(run(new Segmenter(new EnergyVad(), options), audio))).toEqual([]);
  });

  it('keeps a short pause inside one segment', () => {
    const audio = concat([burst(0.5, 0.3), burst(0.2, 0), burst(0.5, 0.3), burst(1, 0)]);
    const events = boundaries(run(new Segmenter(new EnergyVad(), options), audio));
    expect(events.map((e) => e.type)).toEqual(['start', 'end']);
  });

  it('splits at a long pause, numbering segments', () => {
    const audio = concat([burst(0.5, 0.3), burst(0.6, 0), burst(0.5, 0.3), burst(1, 0)]);
    const events = boundaries(run(new Segmenter(new EnergyVad(), options), audio));
    expect(events.map((e) => `${e.type}:${e.segmentId}`)).toEqual([
      'start:s1',
      'end:s1',
      'start:s2',
      'end:s2',
    ]);
    expect(events[1]).toMatchObject({ endSample: ms(500) });
    expect(events[2]).toMatchObject({ startSample: ms(1100 - 200) });
  });

  it('cuts long speech at maxSegmentMs and carries on without losing audio', () => {
    const audio = concat([burst(12, 0.3), burst(1, 0)]);
    const events = boundaries(run(new Segmenter(new EnergyVad(), options), audio));
    expect(events).toEqual([
      { type: 'start', segmentId: 's1', startSample: 0 },
      { type: 'end', segmentId: 's1', endSample: ms(5000), reason: 'max-length' },
      { type: 'start', segmentId: 's2', startSample: ms(5000) },
      { type: 'end', segmentId: 's2', endSample: ms(10000), reason: 'max-length' },
      { type: 'start', segmentId: 's3', startSample: ms(10000) },
      { type: 'end', segmentId: 's3', endSample: ms(12000), reason: 'silence' },
    ]);
  });

  it('gives the same boundaries whatever the chunk size', () => {
    const audio = concat([
      burst(0.7, 0),
      burst(0.9, 0.3),
      burst(0.8, 0),
      burst(0.4, 0.3),
      burst(1, 0),
    ]);
    const a = boundaries(run(new Segmenter(new EnergyVad(), options), audio, 320));
    const b = boundaries(run(new Segmenter(new EnergyVad(), options), audio, 777));
    const c = boundaries(run(new Segmenter(new EnergyVad(), options), audio, 4096));
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('flush ends an open segment at the end of its speech', () => {
    const seg = new Segmenter(new EnergyVad(), options);
    run(seg, concat([burst(0.5, 0), burst(0.5, 0.3)]));
    expect(seg.inSegment).toBe(true);
    expect(seg.flush()).toEqual([
      { type: 'end', segmentId: 's1', endSample: ms(1000), reason: 'flush' },
    ]);
    expect(seg.inSegment).toBe(false);
  });

  it('flushes and restarts on a gap in the sample stream', () => {
    const seg = new Segmenter(new EnergyVad(), options);
    seg.push(burst(0.5, 0.3), 0);
    const events = seg.push(burst(0.02, 0.3), ms(2000));
    expect(events[0]).toMatchObject({ type: 'end', reason: 'flush' });
  });
});

describe('Segmenter, sentence strategy (default)', () => {
  type Probe = Extract<SegmentEvent, { type: 'probe' }>;

  /**
   * Pushes `audio` in chunks. Each probe is answered with `answer(probe)` (null: never) once
   * `delayMs` more audio has been pushed.
   */
  function drive(
    segmenter: Segmenter,
    audio: Float32Array,
    answer: (probe: Probe) => string | null = () => null,
    delayMs = 0,
    chunk = 320,
  ): SegmentEvent[] {
    const events: SegmentEvent[] = [];
    const due: { at: number; probe: Probe }[] = [];
    const answerDue = (upTo: number) => {
      while (due.length > 0 && (due[0] as { at: number }).at <= upTo) {
        const { probe } = due.shift() as { probe: Probe };
        const text = answer(probe);
        if (text !== null) {
          events.push(...segmenter.transcript(probe.segmentId, probe.endSample, text));
        }
      }
    };
    for (let i = 0; i < audio.length; i += chunk) {
      const out = segmenter.push(audio.subarray(i, i + chunk), i);
      events.push(...out);
      for (const e of out)
        if (e.type === 'probe') due.push({ at: i + chunk + ms(delayMs), probe: e });
      answerDue(i + chunk);
    }
    answerDue(Infinity);
    return events;
  }

  const ends = (events: SegmentEvent[]) =>
    events.filter((e) => e.type === 'end') as Extract<SegmentEvent, { type: 'end' }>[];
  const starts = (events: SegmentEvent[]) =>
    events.filter((e) => e.type === 'start') as Extract<SegmentEvent, { type: 'start' }>[];

  /** Each segment's audio events are contiguous from its start; returns [start, end) per id. */
  function audioSpans(events: SegmentEvent[]): Map<string, [number, number]> {
    const spans = new Map<string, [number, number]>();
    for (const e of events) {
      if (e.type === 'start') spans.set(e.segmentId, [e.startSample, e.startSample]);
      if (e.type !== 'audio') continue;
      const span = spans.get(e.segmentId);
      expect(span, `audio before start of ${e.segmentId}`).toBeDefined();
      if (!span) continue;
      expect(e.startSample).toBe(span[1]);
      span[1] = e.startSample + e.samples.length;
    }
    return spans;
  }

  it('uses the benchmark winner as its defaults', () => {
    const c = new Segmenter(new EnergyVad()).config;
    expect(c).toMatchObject({
      strategy: 'sentence',
      threshold: 0.5,
      negThreshold: 0.35,
      preRollMs: 100,
      tailPadMs: 100,
      hangoverMs: 250,
      minSegmentMs: 1000,
      longHangoverMs: 1000,
      maxSegmentMs: 5000,
      cutSearchMs: 1000,
      cutMinHeadMs: 1000,
      cutAheadMs: 0,
      sentenceHangMs: 150,
      sentenceMinSegmentMs: 1000,
      sentenceRule: 'punct',
      minSpeechSpanMs: 250,
    });
    expect(new Segmenter(new EnergyVad(), { strategy: 'pause' }).config.hangoverMs).toBe(500);
    expect(new Segmenter(new EnergyVad(), { maxSegmentMs: 4000 }).config).toMatchObject({
      strategy: 'sentence',
      maxSegmentMs: 4000,
      hangoverMs: 250,
    });
  });

  it('ends a segment of a second or more at a 250 ms pause, plus a 100 ms tail', () => {
    const audio = concat([burst(1, 0), burst(1.5, 0.3), burst(0.3, 0), burst(1, 0.3), burst(1, 0)]);
    const events = drive(new Segmenter(new EnergyVad()), audio);
    expect(starts(events).map((e) => e.startSample)).toEqual([ms(900), ms(2700)]);
    expect(ends(events)).toEqual([
      { type: 'end', segmentId: 's1', endSample: ms(2600), reason: 'silence' },
      { type: 'end', segmentId: 's2', endSample: ms(3900), reason: 'silence' },
    ]);
  });

  it('keeps a segment under a second open through a pause under a second', () => {
    // The pause starts 0.4 s into the segment; the segment is 0.8 s long when speech resumes.
    const audio = concat([
      burst(0.5, 0),
      burst(0.3, 0.3),
      burst(0.4, 0),
      burst(0.5, 0.3),
      burst(1.2, 0),
    ]);
    const events = drive(new Segmenter(new EnergyVad()), audio);
    expect(ends(events)).toEqual([
      { type: 'end', segmentId: 's1', endSample: ms(1800), reason: 'silence' },
    ]);
  });

  it('drops tiny fragments without a trace', () => {
    // 160 ms is enough to open a segment but under the 250 ms of speech one needs.
    const audio = concat([
      burst(0.5, 0),
      burst(0.16, 0.3),
      burst(1.5, 0),
      burst(0.4, 0.3),
      burst(1.5, 0),
    ]);
    const events = drive(new Segmenter(new EnergyVad()), audio);
    expect(events.filter((e) => e.type !== 'audio')).toEqual([
      { type: 'start', segmentId: 's2', startSample: ms(2060) },
      { type: 'end', segmentId: 's2', endSample: ms(2660), reason: 'silence' },
    ]);
    audioSpans(events);
    const seg = new Segmenter(new EnergyVad());
    drive(seg, concat([burst(0.5, 0), burst(0.2, 0.3)]));
    expect(seg.inSegment).toBe(true);
    expect(seg.flush()).toEqual([]);
  });

  it('cuts continuous speech at 5 s at the quietest moment of the last second', () => {
    // 20 s of talk with no pause; a 100 ms dip at 4.40 s and at 8.70 s.
    const audio = concat([
      burst(4.4, 0.3),
      burst(0.1, 0.004),
      burst(4.2, 0.3),
      burst(0.1, 0.004),
      burst(11.2, 0.3),
      burst(1, 0),
    ]);
    const events = drive(new Segmenter(new EnergyVad()), audio);
    const e = ends(events);
    expect(e.map((x) => x.reason)).toEqual([
      'max-length',
      'max-length',
      'max-length',
      'max-length',
      'silence',
    ]);
    expect(e[4]?.endSample).toBe(ms(20_100));
    // In the dips, not at 5 s.
    expect(e[0]?.endSample).toBeGreaterThanOrEqual(ms(4400));
    expect(e[0]?.endSample).toBeLessThan(ms(4500));
    expect(e[1]?.endSample).toBeGreaterThanOrEqual(ms(8700));
    expect(e[1]?.endSample).toBeLessThan(ms(8800));
    // Every segment at most 5 s, each starting where the last one was cut.
    const s = starts(events);
    for (let i = 0; i < e.length; i++) {
      const start = s[i]?.startSample ?? 0;
      expect((e[i]?.endSample ?? 0) - start).toBeLessThanOrEqual(ms(5000));
      if (i > 0) expect(start).toBe(e[i - 1]?.endSample);
    }
    // No audio lost: each segment's audio runs from its start, through the carried-over part.
    const spans = audioSpans(events);
    for (let i = 0; i < e.length; i++) {
      const span = spans.get(e[i]?.segmentId ?? '');
      expect(span?.[1]).toBeGreaterThanOrEqual(e[i]?.endSample ?? 0);
    }
  });

  it('with the audio ahead at hand (lookahead), cuts at a gap just past the maximum', () => {
    // Talk from 0.5 s, a 100 ms gap at 5.6 s (too short to end the segment), more talk.
    const audio = concat([
      burst(0.5, 0),
      burst(5.1, 0.3),
      burst(0.1, 0),
      burst(3, 0.3),
      burst(1, 0),
    ]);
    const live = ends(drive(new Segmenter(new EnergyVad()), audio));
    const events = drive(new Segmenter(new EnergyVad(), { cutAheadMs: 1000 }), audio);
    const ahead = ends(events);
    // Live: the cut is in the last second before the maximum, in the middle of the talk.
    expect(live[0]?.endSample).toBeLessThan(ms(5500));
    // Ahead: at the gap.
    expect(ahead[0]?.endSample).toBeGreaterThanOrEqual(ms(5550));
    expect(ahead[0]?.endSample).toBeLessThanOrEqual(ms(5750));
    expect(ahead[0]?.reason).toBe('max-length');
    // Nothing lost: the next segment starts at the cut.
    expect(starts(events)[1]?.startSample).toBe(ahead[0]?.endSample);
    audioSpans(events);
  });

  it('with lookahead, decides the cut 1.5 s past the 5 s maximum', () => {
    // Talk from 0.5 s (the segment opens at 0.4 s, so its maximum is at 5.4 s and the cut is
    // decided at 6.9 s), then a 100 ms gap at 7.2 s: too late to be the cut.
    const audio = concat([
      burst(0.5, 0),
      burst(6.7, 0.3),
      burst(0.1, 0),
      burst(3, 0.3),
      burst(1, 0),
    ]);
    const events = drive(
      new Segmenter(new EnergyVad(), { cutAheadMs: LOOKAHEAD_CUT_AHEAD_MS }),
      audio,
    );
    const first = ends(events)[0];
    expect(first?.reason).toBe('max-length');
    expect(first?.endSample).toBeGreaterThanOrEqual(ms(4400));
    expect(first?.endSample).toBeLessThanOrEqual(ms(6900));
    // Nothing lost: the next segment starts at the cut.
    expect(starts(events)[1]?.startSample).toBe(first?.endSample);
    audioSpans(events);
  });

  it('never cuts in the first second, and cuts on the spot when the last second is even', () => {
    const audio = concat([burst(13, 0.3), burst(1, 0)]);
    const events = drive(new Segmenter(new EnergyVad(), { cutSearchMs: 0 }), audio);
    expect(ends(events).map((e) => e.endSample)).toEqual([ms(5000), ms(10000), ms(13100)]);
    const searched = ends(drive(new Segmenter(new EnergyVad()), audio));
    for (const e of searched.slice(0, -1)) {
      const prev = searched[searched.indexOf(e) - 1]?.endSample ?? 0;
      expect(e.endSample - prev).toBeGreaterThanOrEqual(ms(4000));
      expect(e.endSample - prev).toBeLessThanOrEqual(ms(5000));
    }
  });

  it('asks about the text at a 150 ms pause and ends the segment at a sentence end', () => {
    // Speech 1.5 s, a 200 ms pause (too short to end it), more speech.
    const audio = concat([
      burst(0.5, 0),
      burst(1.5, 0.3),
      burst(0.2, 0),
      burst(1.5, 0.3),
      burst(1, 0),
    ]);
    const probes: Probe[] = [];
    const events = drive(new Segmenter(new EnergyVad()), audio, (p) => {
      probes.push(p);
      return p.segmentId === 's1' ? 'That was the first one.' : 'and the second';
    });
    // The pause began at 2.0 s: the probe covers up to 2.1 s, asked at 2.15 s.
    expect(probes[0]).toEqual({ type: 'probe', segmentId: 's1', endSample: ms(2100) });
    expect(ends(events)).toEqual([
      { type: 'end', segmentId: 's1', endSample: ms(2100), reason: 'sentence' },
      { type: 'end', segmentId: 's2', endSample: ms(3800), reason: 'silence' },
    ]);
    // The next segment's pre-roll stops at the sentence end.
    expect(starts(events)[1]?.startSample).toBe(ms(2100));
    audioSpans(events);
  });

  it('carries on through the pause when the words so far do not end a sentence', () => {
    const audio = concat([
      burst(0.5, 0),
      burst(1.5, 0.3),
      burst(0.2, 0),
      burst(1.5, 0.3),
      burst(1, 0),
    ]);
    const events = drive(new Segmenter(new EnergyVad()), audio, () => 'and then we went to');
    expect(ends(events)).toEqual([
      { type: 'end', segmentId: 's1', endSample: ms(3800), reason: 'silence' },
    ]);
    // One probe per pause, and only one segment: the second pause ends it before any probe
    // could matter.
    expect(events.filter((e) => e.type === 'probe').length).toBe(2);
  });

  it('applies a sentence end that arrives after the speech went on', () => {
    const audio = concat([
      burst(0.5, 0),
      burst(1.5, 0.3),
      burst(0.2, 0),
      burst(1.5, 0.3),
      burst(1, 0),
    ]);
    // The answer comes 400 ms after the probe: speech resumed 50 ms after it was asked.
    const events = drive(new Segmenter(new EnergyVad()), audio, () => 'Done.', 400);
    expect(ends(events)[0]).toEqual({
      type: 'end',
      segmentId: 's1',
      endSample: ms(2100),
      reason: 'sentence',
    });
    expect(starts(events)[1]?.startSample).toBe(ms(2100));
    // The second segment gets the audio from the sentence end on, again.
    const spans = audioSpans(events);
    expect(spans.get('s2')?.[0]).toBe(ms(2100));
  });

  it('ignores transcripts that answer no probe of the open segment', () => {
    const seg = new Segmenter(new EnergyVad());
    drive(seg, concat([burst(0.5, 0), burst(1.5, 0.3)]));
    expect(seg.transcript('s1', ms(1800), 'A partial that ends.')).toEqual([]);
    expect(seg.transcript('s9', ms(2000), 'Wrong segment.')).toEqual([]);
    expect(seg.inSegment).toBe(true);
  });

  it('does not probe segments under a second, or with probes turned off', () => {
    // A 200 ms pause 0.5 s in: no probe; the final pause, 1.1 s in: one.
    const audio = concat([
      burst(0.5, 0),
      burst(0.4, 0.3),
      burst(0.2, 0),
      burst(0.3, 0.3),
      burst(1.2, 0),
    ]);
    const asked = drive(new Segmenter(new EnergyVad()), audio).filter((e) => e.type === 'probe');
    expect(asked).toEqual([{ type: 'probe', segmentId: 's1', endSample: ms(1500) }]);
    const long = concat([burst(1.5, 0.3), burst(0.2, 0), burst(1, 0.3), burst(1.2, 0)]);
    const off = drive(new Segmenter(new EnergyVad(), { sentenceHangMs: 0 }), long);
    expect(off.filter((e) => e.type === 'probe')).toEqual([]);
  });

  it('splits two languages at the short pause between them when the first sentence ends', () => {
    // 3 s in one voice, a 180 ms breath, 3 s in another: the 250 ms pause rule would keep them
    // together; the sentence end splits them.
    const audio = concat([burst(3, 0.3), burst(0.18, 0), sine(440, RATE, 3, 0.3), burst(1, 0)]);
    const answers: Record<string, string> = { s1: 'We are back with the team.' };
    const events = drive(new Segmenter(new EnergyVad()), audio, (p) => answers[p.segmentId] ?? '');
    const e = ends(events);
    expect(e.map((x) => [x.segmentId, x.reason])).toEqual([
      ['s1', 'sentence'],
      ['s2', 'silence'],
    ]);
    expect(e[0]?.endSample).toBe(ms(3100));
    expect(starts(events)[1]?.startSample).toBe(ms(3100));
  });

  it('gives the same boundaries whatever the chunk size', () => {
    const audio = concat([
      burst(0.7, 0),
      burst(1.9, 0.3),
      burst(0.2, 0),
      burst(7.4, 0.3),
      burst(0.8, 0),
      burst(0.4, 0.3),
      burst(1.2, 0),
    ]);
    const answer = (p: Probe) => (p.segmentId === 's1' ? 'Yes.' : 'no');
    const a = boundaries(drive(new Segmenter(new EnergyVad()), audio, answer, 0, 320));
    const b = boundaries(drive(new Segmenter(new EnergyVad()), audio, answer, 0, 777));
    const c = boundaries(drive(new Segmenter(new EnergyVad()), audio, answer, 0, 4096));
    expect(a.filter((e) => e.type === 'end').length).toBeGreaterThanOrEqual(3);
    expect(b.filter((e) => e.type !== 'probe')).toEqual(a.filter((e) => e.type !== 'probe'));
    expect(c.filter((e) => e.type !== 'probe')).toEqual(a.filter((e) => e.type !== 'probe'));
  });
});

describe('Segmenter on scored frames (a model detector)', () => {
  const FRAME = 512;
  const frameMs = (FRAME / RATE) * 1000;
  type Spec = { prob: number; amp: number };

  /** Scored 32 ms frames: `spec(t)` gives each frame's probability and level from its start, s. */
  function scored(seconds: number, spec: (t: number) => Spec) {
    const seg = new Segmenter(new EnergyVad({ frameSamples: FRAME }), { minSpeechMs: 32 });
    const events: SegmentEvent[] = [];
    for (let at = 0; at + FRAME <= seconds * RATE; at += FRAME) {
      const { prob, amp } = spec(at / RATE);
      events.push(...seg.pushScored(burst(FRAME / RATE, amp), at, prob));
    }
    return events;
  }
  const firstCut = (events: SegmentEvent[]) => {
    const end = events.find((e) => e.type === 'end');
    expect(end).toMatchObject({ reason: 'max-length' });
    return ((end as { endSample: number }).endSample / RATE) * 1000;
  };
  const near = (t: number, from: number) => t >= from && t < from + 0.1;

  it('cuts at the gap between words, even where the music is louder than a soft syllable', () => {
    const events = scored(6, (t) =>
      near(t, 4.4)
        ? { prob: 0.1, amp: 0.3 } // a beat of music between two words
        : near(t, 4.7)
          ? { prob: 0.92, amp: 0.004 } // a soft syllable
          : { prob: 0.99, amp: 0.3 },
    );
    const cut = firstCut(events);
    expect(cut).toBeGreaterThanOrEqual(4400 - frameMs);
    expect(cut).toBeLessThan(4500);
  });

  it('cuts at the quietest moment when every frame of the last second is speech', () => {
    const events = scored(6, (t) =>
      near(t, 4.2)
        ? { prob: 0.6, amp: 0.3 } // less sure, but still speech
        : near(t, 4.7)
          ? { prob: 0.9, amp: 0.004 }
          : { prob: 0.99, amp: 0.3 },
    );
    const cut = firstCut(events);
    expect(cut).toBeGreaterThanOrEqual(4700 - frameMs);
    expect(cut).toBeLessThan(4800);
  });

  it('ends at a pause in the probabilities, whatever the level', () => {
    // Loud all along (music under the talk); the talk stops for 0.4 s at 2 s.
    const events = scored(4, (t) => ({ prob: t >= 2 && t < 2.4 ? 0.05 : 0.98, amp: 0.3 }));
    expect(events.find((e) => e.type === 'end')).toMatchObject({ reason: 'silence' });
  });

  it('takes frames of its size only, and restarts at a gap', () => {
    const seg = new Segmenter(new EnergyVad({ frameSamples: FRAME }), { minSpeechMs: 32 });
    expect(() => seg.pushScored(new Float32Array(320), 0, 1)).toThrow(RangeError);
    for (let at = 0; at < RATE; at += FRAME) seg.pushScored(burst(FRAME / RATE, 0.3), at, 0.99);
    expect(seg.inSegment).toBe(true);
    const events = seg.pushScored(burst(FRAME / RATE, 0.3), 10 * RATE, 0.99);
    // The open segment ends; one frame opens the next (it starts once it has 250 ms of speech).
    expect(events.filter((e) => e.type !== 'audio').map((e) => e.type)).toEqual(['end']);
    expect(seg.inSegment).toBe(true);
  });
});
