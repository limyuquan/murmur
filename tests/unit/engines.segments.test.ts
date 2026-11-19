import { describe, expect, it } from 'vitest';
import { type SegmentDecode, type SegmentDecoder, SegmentSession } from '@/engines/segments';
import type { AsrResult } from '@/engines/types';
import { type DecodeJob, DecodeScheduler } from '@/engines/whisper/scheduler';
import { burst } from './helpers';

const S = 16_000;
const sec = (s: number) => Math.round(s * S);

const decoded = (text: string): SegmentDecode => ({
  text,
  language: 'en',
  languageProb: 0.9,
  noSpeechProb: 0.01,
  avgLogprob: -0.2,
  ms: 100,
});

/** A decoder whose decodes finish when the test says (`finish()`), oldest first. */
function manualDecoder(text: (job: DecodeJob) => string) {
  const jobs: DecodeJob[] = [];
  const waiting: (() => void)[] = [];
  const decoder: SegmentDecoder = {
    decode(job) {
      jobs.push(job);
      return new Promise((resolve) => waiting.push(() => resolve(decoded(text(job)))));
    },
  };
  const finish = async () => {
    waiting.shift()?.();
    // Let the result and the next pump run.
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { decoder, jobs, finish };
}

function session(decoder: SegmentDecoder) {
  const results: AsrResult[] = [];
  const s = new SegmentSession(
    decoder,
    { sampleRate: S, languageHint: null, onResult: (r) => results.push(r), onError: () => {} },
    { firstPartialMs: 1000, partialIntervalMs: 1500 },
  );
  return { s, results };
}

describe('DecodeScheduler probes', () => {
  it('runs a probe after finals and before partials, up to the asked sample', () => {
    const q = new DecodeScheduler({ firstPartialMs: 1000 });
    q.startSegment('a', 0);
    q.audio('a', sec(2));
    q.probe('a', sec(1.8));
    expect(q.next()).toEqual({
      kind: 'probe',
      segmentId: 'a',
      startSample: 0,
      endSample: sec(1.8),
    });
    q.done();
    // The probe counts as the latest partial.
    q.audio('a', sec(2.5));
    expect(q.next()).toBeNull();
  });

  it('ignores probes of other segments, and drops a queued one when its segment ends', () => {
    const q = new DecodeScheduler({ firstPartialMs: 5000 });
    q.startSegment('a', 0);
    q.audio('a', sec(2));
    q.probe('b', sec(1));
    expect(q.next()).toBeNull();
    q.probe('a', sec(1.8));
    q.endSegment('a', sec(2));
    expect(q.next()).toMatchObject({ kind: 'final', segmentId: 'a', endSample: sec(2) });
  });

  it('queues no final for a segment its probe already decoded', () => {
    const q = new DecodeScheduler();
    q.startSegment('a', 0);
    q.audio('a', sec(2));
    expect(q.endSegment('a', sec(1.8), true)).toEqual([]);
    expect(q.next()).toBeNull();
    expect(q.backlogSamples()).toBe(0);
  });
});

describe('SegmentSession probes', () => {
  it('sends a probe as a partial covering exactly the asked span', async () => {
    const d = manualDecoder(() => 'So that is it.');
    const { s, results } = session(d.decoder);
    s.startSegment('a', 0);
    s.pushAudio('a', burst(0.8, 0.3), 0);
    s.requestPartial('a', sec(0.7));
    expect(d.jobs).toEqual([
      { kind: 'probe', segmentId: 'a', startSample: 0, endSample: sec(0.7) },
    ]);
    await d.finish();
    expect(results).toEqual([
      expect.objectContaining({ segmentId: 'a', final: false, endSample: sec(0.7) }),
    ]);
  });

  it('uses a finished probe as the final when the segment ends right there', async () => {
    const d = manualDecoder(() => 'So that is it.');
    const { s, results } = session(d.decoder);
    s.startSegment('a', 0);
    s.pushAudio('a', burst(0.8, 0.3), 0);
    s.requestPartial('a', sec(0.7));
    await d.finish();
    s.endSegment('a', sec(0.7));
    // No second decode of the same audio.
    expect(d.jobs.map((j) => j.kind)).toEqual(['probe']);
    expect(results.at(-1)).toMatchObject({
      final: true,
      text: 'So that is it.',
      startSample: 0,
      endSample: sec(0.7),
    });
  });

  it('waits for a running probe when the segment ends where it does', async () => {
    const d = manualDecoder(() => 'Right.');
    const { s, results } = session(d.decoder);
    s.startSegment('a', 0);
    s.pushAudio('a', burst(0.8, 0.3), 0);
    s.requestPartial('a', sec(0.7));
    s.endSegment('a', sec(0.7));
    expect(results).toEqual([]);
    await d.finish();
    expect(d.jobs.map((j) => j.kind)).toEqual(['probe']);
    expect(results).toEqual([
      expect.objectContaining({ final: true, text: 'Right.', endSample: sec(0.7) }),
    ]);
  });

  it('decodes a final as usual when the segment ends elsewhere', async () => {
    const d = manualDecoder((job) => (job.kind === 'final' ? 'Right, and more.' : 'Right'));
    const { s, results } = session(d.decoder);
    s.startSegment('a', 0);
    s.pushAudio('a', burst(0.8, 0.3), 0);
    s.requestPartial('a', sec(0.7));
    s.pushAudio('a', burst(0.4, 0.3), sec(0.8));
    await d.finish();
    s.endSegment('a', sec(1.1));
    await d.finish();
    expect(d.jobs.map((j) => [j.kind, j.endSample])).toEqual([
      ['probe', sec(0.7)],
      ['final', sec(1.1)],
    ]);
    expect(results.filter((r) => r.final)).toEqual([
      expect.objectContaining({ text: 'Right, and more.', endSample: sec(1.1) }),
    ]);
  });
});
