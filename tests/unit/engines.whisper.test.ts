import { describe, expect, it } from 'vitest';
import {
  collapseRepeats,
  type DecodeStats,
  filterDecode,
  isStockPhrase,
  peakDb,
} from '@/engines/whisper/filters';
import { DecodeScheduler } from '@/engines/whisper/scheduler';
import { burst } from './helpers';

const speech = (text: string, extra: Partial<DecodeStats> = {}): DecodeStats => ({
  text,
  language: 'ko',
  noSpeechProb: 0.02,
  avgLogprob: -0.3,
  peakDb: -20,
  ...extra,
});

describe('Whisper hallucination guards', () => {
  it('keeps ordinary speech', () => {
    expect(filterDecode(speech('15위로 끝마쳤습니다.'))).toEqual({
      text: '15위로 끝마쳤습니다.',
      dropped: null,
    });
  });

  it('drops silence and music the model itself doubts', () => {
    expect(filterDecode(speech('음악', { noSpeechProb: 0.7, avgLogprob: -1.2 })).dropped).toBe(
      'no-speech',
    );
    expect(filterDecode(speech('Hmm.', { noSpeechProb: 0.95 })).dropped).toBe('no-speech');
    expect(filterDecode(speech('네', { peakDb: -70 })).dropped).toBe('quiet');
    expect(filterDecode(speech('...', { avgLogprob: -2 })).dropped).toBe('low-confidence');
  });

  it('drops stock subtitle-credit lines, but only as the whole line', () => {
    expect(filterDecode(speech('시청해주셔서 감사합니다.')).dropped).toBe('stock-phrase');
    expect(filterDecode(speech('ご視聴ありがとうございました', { language: 'ja' })).dropped).toBe(
      'stock-phrase',
    );
    expect(filterDecode(speech('Thanks for watching!', { language: 'en' })).dropped).toBe(
      'stock-phrase',
    );
    expect(filterDecode(speech('字幕by索兰娅', { language: 'zh' })).dropped).toBe('stock-phrase');
    expect(
      filterDecode(speech('오늘 시청해주셔서 감사합니다 다음 주에 또 만나요')).dropped,
    ).toBeNull();
    expect(isStockPhrase('Subtitles by the Amara.org community', 'en')).toBe(true);
  });

  it('keeps short lines people really say unless the model was unsure', () => {
    expect(filterDecode(speech('감사합니다.')).dropped).toBeNull();
    expect(filterDecode(speech('감사합니다.', { noSpeechProb: 0.4 })).dropped).toBe('stock-phrase');
    expect(filterDecode(speech('Thank you.', { language: 'en', avgLogprob: -0.9 })).dropped).toBe(
      'stock-phrase',
    );
  });

  it('cuts repetition loops back to two copies', () => {
    expect(collapseRepeats('네 네 네 네 네 네')).toBe('네 네');
    expect(collapseRepeats('ありがとうありがとうありがとうありがとう')).toBe(
      'ありがとうありがとう',
    );
    expect(collapseRepeats('I said no, no, no, no, no.')).toBe('I said no no.');
    expect(collapseRepeats('a normal sentence with no loops')).toBe(
      'a normal sentence with no loops',
    );
    expect(filterDecode(speech('좋아요 좋아요 좋아요 좋아요')).text).toBe('좋아요 좋아요');
  });

  it('measures peak loudness', () => {
    expect(peakDb(new Float32Array(16_000))).toBe(-Infinity);
    expect(peakDb(burst(1, 0.5))).toBeCloseTo(20 * Math.log10(0.5 / Math.SQRT2), 0);
  });
});

describe('DecodeScheduler', () => {
  const S = 16_000;
  const sec = (s: number) => Math.round(s * S);

  it('decodes a partial each second of new audio and a final at the end', () => {
    const q = new DecodeScheduler();
    q.startSegment('a', 0);
    q.audio('a', sec(0.5));
    expect(q.next()).toBeNull();
    q.audio('a', sec(1));
    expect(q.next()).toMatchObject({ kind: 'partial', segmentId: 'a', endSample: sec(1) });
    q.done();
    q.audio('a', sec(1.6));
    expect(q.next()).toBeNull();
    q.audio('a', sec(2));
    expect(q.next()).toMatchObject({ kind: 'partial', endSample: sec(2) });
    q.done();
    q.endSegment('a', sec(2.3));
    expect(q.next()).toMatchObject({ kind: 'final', segmentId: 'a', endSample: sec(2.3) });
    q.done();
    expect(q.next()).toBeNull();
    expect(q.health()).toMatchObject({ behind: false, droppedPartials: 0, droppedSegments: 0 });
  });

  it('runs finals before partials, and skips partials while busy', () => {
    const q = new DecodeScheduler();
    q.startSegment('a', 0);
    q.audio('a', sec(1));
    expect(q.next()?.kind).toBe('partial'); // a slow partial is running...
    q.audio('a', sec(4));
    expect(q.next()).toBeNull(); // ...the worker is busy: nothing queues up
    q.endSegment('a', sec(4));
    q.startSegment('b', sec(4.5));
    q.audio('b', sec(6));
    q.done();
    // a's final comes before b's partial.
    expect(q.next()).toMatchObject({ kind: 'final', segmentId: 'a' });
    q.done();
    expect(q.next()).toMatchObject({ kind: 'partial', segmentId: 'b', endSample: sec(6) });
    expect(q.health().droppedPartials).toBeGreaterThanOrEqual(1);
  });

  it('counts the cadence ticks a slow worker skipped', () => {
    const q = new DecodeScheduler();
    q.startSegment('a', 0);
    q.audio('a', sec(1));
    q.next();
    q.done();
    q.audio('a', sec(4.2)); // 3.2 s of new audio: three ticks, one decode
    expect(q.next()?.endSample).toBe(sec(4.2));
    expect(q.health().droppedPartials).toBe(2);
  });

  it('reports falling behind and gives up the oldest finals past the cap', () => {
    const q = new DecodeScheduler({ behindMs: 4000, maxBacklogMs: 10_000 });
    q.startSegment('x', 0);
    q.audio('x', sec(1));
    q.next(); // a partial the worker is stuck on
    const dropped: string[] = [];
    let at = 0;
    for (const id of ['a', 'b', 'c', 'd']) {
      q.startSegment(id, sec(at));
      q.audio(id, sec(at + 4));
      dropped.push(...q.endSegment(id, sec(at + 4)));
      at += 4.5;
    }
    expect(q.health().behind).toBe(true);
    // x (1 s, ended by a's start) + four 4 s finals: over 10 s, oldest go first, newest kept.
    expect(dropped).toEqual(['x', 'a', 'b']);
    expect(q.health().droppedSegments).toBe(3);
    q.done();
    expect(q.next()).toMatchObject({ kind: 'final', segmentId: 'c' });
  });
});
