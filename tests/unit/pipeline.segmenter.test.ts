import { describe, expect, it } from 'vitest';
import { type SegmentEvent, Segmenter } from '@/pipeline/segmenter';
import { EnergyVad, rmsDb } from '@/pipeline/vad';
import { burst, concat } from './helpers';

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

describe('Segmenter', () => {
  const options = { minSpeechMs: 100, hangoverMs: 300, preRollMs: 200, maxSegmentMs: 5000 };

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
