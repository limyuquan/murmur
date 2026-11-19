/**
 * The Chrome speech arbiter, on transcripts measured from Chrome 157's on-device recognizers
 * (ko/ja/en/zh run together on mixed-language clips).
 */
import { describe, expect, it } from 'vitest';
import {
  type Candidate,
  cleanTranscript,
  isSwitch,
  pickCandidate,
  scriptShare,
  speechUnits,
  textSpan,
  unusedFrom,
} from '@/engines/chrome/arbiter';

const c = (language: string, text: string, updates: number): Candidate => ({
  language,
  text,
  updates,
});

describe('pickCandidate', () => {
  it('keeps the recognizer whose language was spoken (Korean speech)', () => {
    const { winner } = pickCandidate(
      [
        c('ko-KR', '자신의 의견이 아닌 정부의 의견을 듣고 싶을 수도 있지만', 14),
        c('ja-JP', 'に', 1),
        c('en-US', '', 0),
        c('zh-CN', 'johnny johnny good good study', 7),
      ],
      4080,
    );
    expect(winner?.language).toBe('ko-KR');
  });

  it('does not drop Japanese for Korean written over it', () => {
    // Japanese speech; the Korean recognizer wrote its sounds in Hangul (외側が → 소토가와가).
    const candidates = [
      c('ko-KR', '음모와 소토가와가 그리 이로데 지가와가', 18),
      c('ja-JP', '羽毛は外側がグ色で内側が', 18),
      c('zh-CN', '哇哇', 5),
      c('en-US', '', 0),
    ];
    // Counted in morae, the Japanese line covers the speech; with the previous line Japanese the
    // continuity edge settles it.
    expect(pickCandidate(candidates, 4000, 'ja-JP').winner?.language).toBe('ja-JP');
  });

  it('prefers kanji-dense Japanese over katakana guesses of Korean speech', () => {
    const { winner } = pickCandidate(
      [
        c('ko-KR', '멕시코 선수 알리 벨라스케스는 남자 슈퍼 대회전 좌식에서', 21),
        c('ja-JP', 'メキシコアリペラスポ', 26),
        c('en-US', 'Mexico', 1),
      ],
      5680,
    );
    expect(winner?.language).toBe('ko-KR');
  });

  it('rejects other-script output and empty text', () => {
    const { winner, scored } = pickCandidate(
      [c('zh-CN', 'anniversary startuing warrior', 20), c('en-US', '', 0)],
      9400,
    );
    expect(winner).toBeNull();
    expect(scored.find((s) => s.language === 'zh-CN')?.script).toBe(0);
  });

  it('uses the language detector when it disagrees', () => {
    const zh = { ...c('zh-CN', '西部', 4), detected: { language: 'ja', confidence: 0.9 } };
    const ko = c('ko-KR', '15위로 끝마쳤습니다', 7);
    expect(pickCandidate([zh, ko], 1560).winner?.language).toBe('ko-KR');
  });
});

describe('transcript helpers', () => {
  it('removes the spaces Chrome puts between Japanese and Chinese words', () => {
    expect(cleanTranscript('イラン で は 航空 事故 は 珍しく', 'ja-JP')).toBe(
      'イランでは航空事故は珍しく',
    );
    expect(cleanTranscript('藏 传 佛 教 以 佛 陀', 'zh-CN')).toBe('藏传佛教以佛陀');
    expect(cleanTranscript('日本 製 の cep です', 'ja-JP')).toBe('日本製のcepです');
    expect(cleanTranscript(' It warns  no one ', 'en-US')).toBe('It warns no one');
  });

  it('counts speech units per language', () => {
    expect(speechUnits('15위로 끝마쳤습니다', 'ko')).toBe(8);
    // Kanji 2 morae, hiragana 1, katakana 0.75.
    expect(speechUnits('暖色系の色でした', 'ja')).toBe(4 * 2 + 4);
    expect(speechUnits('メキシコ', 'ja')).toBe(3);
    expect(speechUnits('It warns', 'en')).toBe(7);
    expect(scriptShare('nhk와 니가다', 'ko')).toBeCloseTo(4 / 7);
  });
});

describe('unusedFrom (cutting a recognizer result between segments)', () => {
  it('continues after the part already used', () => {
    const used = '15위로 끝나쳤습니';
    const now = '15위로 끝나쳤습니다 뉴질랜드 선수 아담 홀은';
    // The late "다" belongs to the word shown with the earlier line: skipped, not repeated.
    expect(now.slice(unusedFrom(now, used))).toBe(' 뉴질랜드 선수 아담 홀은');
  });

  it('ignores spacing, case and punctuation changes in revisions', () => {
    const used = 'イラン で は';
    const now = 'イランでは 航空 事故 は';
    expect(now.slice(unusedFrom(now, used)).trim()).toBe('航空 事故 は');
    expect('it Warns, no one'.slice(unusedFrom('it Warns, no one', 'It warns'))).toBe(', no one');
  });

  it('gives the whole result to the new segment when its start was rewritten', () => {
    // A wrong-language guess ("Iran") the recognizer replaced once real English started.
    expect(unusedFrom('It warns no one can guarantee', 'Iran')).toBe(0);
  });

  it('handles nothing used', () => {
    expect(unusedFrom('abc', '')).toBe(0);
  });
});

describe('isSwitch (a second language inside one segment)', () => {
  it('needs the second text to be written at another time', () => {
    const history = (from: number, to: number) => [
      { sample: from, length: 2 },
      { sample: (from + to) / 2, length: 10 },
      { sample: to, length: 20 },
    ];
    const en = textSpan(history(16_000, 160_000));
    const ko = textSpan(history(176_000, 290_000));
    const echo = textSpan(history(20_000, 150_000));
    expect(isSwitch(en, ko, 0.61)).toBe(true);
    // Written alongside the winner: a wrong recognizer echoing the same speech.
    expect(isSwitch(en, echo, 0.61)).toBe(false);
    // Too weak to keep.
    expect(isSwitch(en, ko, 0.2)).toBe(false);
  });

  it('textSpan is null without text', () => {
    expect(textSpan([])).toBeNull();
    expect(textSpan([{ sample: 5, length: 0 }])).toBeNull();
  });
});
