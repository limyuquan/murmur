import { describe, expect, it, vi } from 'vitest';
import { Qwen3AsrEngine } from '@/engines/qwen3asr/engine';
import { QWEN3_ASR_INFO, QWEN3_MODELS } from '@/engines/qwen3asr/info';
import type { DecodeOutput } from '@/engines/qwen3asr/messages';
import { languageIds } from '@/engines/qwen3asr/prompt';
import type { AsrResult } from '@/engines/types';
import { burst } from './helpers';

const S = 16_000;

const answer = (text: string, language: string, avgLogprob: number): DecodeOutput => ({
  id: 0,
  text,
  language,
  languageProb: 0.9,
  noSpeechProb: 0.01,
  avgLogprob,
  ids: [],
  tokens: 8,
  looped: false,
  ms: 50,
});

/**
 * A session over an engine whose decodes answer `auto` (the model's own language choice), or
 * `forced[tag]` when the decode forces that language.
 */
function setup(
  auto: (n: number) => DecodeOutput,
  forced: Record<string, DecodeOutput>,
  options: { spokenLanguages?: string[]; targetLanguage?: string } = {},
) {
  const engine = new Qwen3AsrEngine(QWEN3_ASR_INFO, QWEN3_MODELS['qwen3-asr-0.6b'], {
    scheduler: { firstPartialMs: 60_000, partialIntervalMs: 60_000 },
  });
  const calls: (number[] | null)[] = [];
  let n = 0;
  vi.spyOn(engine, 'decode').mockImplementation(async (_samples, _languages, prefix) => {
    calls.push(prefix);
    if (prefix) {
      const tag = Object.keys(forced).find(
        (t) => JSON.stringify(languageIds(t)) === JSON.stringify(prefix),
      );
      if (tag) return forced[tag] as DecodeOutput;
    }
    return auto(n++);
  });
  const results: AsrResult[] = [];
  const session = engine.createSession({
    sampleRate: S,
    languageHint: null,
    spokenLanguages: options.spokenLanguages ?? ['ko'],
    targetLanguage: options.targetLanguage ?? 'en',
    onResult: (r) => results.push(r),
    onError: () => {},
  });
  let at = 0;
  const line = () => {
    const id = `s${at}`;
    session.startSegment(id, at * S * 2);
    session.pushAudio(id, burst(1.5, 0.3), at * S * 2);
    session.endSegment(id, at * S * 2 + 1.5 * S);
    at++;
  };
  const finals = () => results.filter((r) => r.final);
  return { session, calls, line, finals };
}

const MIXED_EN = answer('Get a bright future, but.', 'en', -0.32);
const MIXED_KO = answer('깨끗한 브라이트 퓨처, but.', 'ko', -0.19);

describe('Qwen3-ASR session: a final heard as the target language', () => {
  it('is decoded again in the spoken language, and that answer kept when the model is surer', async () => {
    const t = setup(() => MIXED_EN, { ko: MIXED_KO });
    t.line();
    await t.session.close();
    expect(t.calls).toEqual([null, languageIds('ko')]);
    expect(t.finals().map((r) => [r.text, r.language?.tag])).toEqual([
      ['깨끗한 브라이트 퓨처, but.', 'ko'],
    ]);
  });

  it('keeps the first answer when the model is less sure of the second', async () => {
    const t = setup(() => MIXED_EN, { ko: answer('깨끗한 브라이트 퓨처, but.', 'ko', -0.6) });
    t.line();
    await t.session.close();
    expect(t.calls).toHaveLength(2);
    expect(t.finals().map((r) => r.language?.tag)).toEqual(['en']);
  });

  it('is not decoded again with no other language to try, nor when heard as another one', async () => {
    const english = setup(() => MIXED_EN, { ko: MIXED_KO }, { spokenLanguages: ['en'] });
    english.line();
    await english.session.close();
    expect(english.calls).toEqual([null]);

    const korean = setup(() => answer('어제 이거 먹고 싶었거든요.', 'ko', -0.1), {});
    korean.line();
    await korean.session.close();
    expect(korean.calls).toEqual([null]);
  });

  it('tries the language most heard so far when the person named none', async () => {
    const t = setup(
      (n) => (n < 4 ? answer('어제 이거 먹고 싶었거든요.', 'ko', -0.1) : MIXED_EN),
      { ko: MIXED_KO },
      { spokenLanguages: [] },
    );
    for (let i = 0; i < 5; i++) t.line();
    await t.session.close();
    expect(t.calls.filter((c) => c !== null)).toEqual([languageIds('ko')]);
    expect(t.finals().at(-1)?.text).toBe('깨끗한 브라이트 퓨처, but.');
  });

  it('in a video plainly in the target language, decodes only every fifth line again', async () => {
    // Spoken languages named, but the video is in the target: every line heard as it, surely.
    const t = setup(() => ({ ...answer('A plain line.', 'en', -0.2), languageProb: 0.99 }), {
      ko: answer('어', 'ko', -0.9),
    });
    for (let i = 0; i < 26; i++) t.line();
    await t.session.close();
    // Each line decoded (n), and again (A): the first 6 to tell, then one line in 5.
    const pattern = t.calls.map((c) => (c ? 'A' : 'n')).join('');
    const lines = pattern.replaceAll('A', '').length;
    expect(lines).toBeGreaterThan(11);
    const expected = Array.from({ length: lines }, (_, i) =>
      i < 6 || (i - 5) % 5 === 0 ? 'nA' : 'n',
    ).join('');
    expect(pattern).toBe(expected);
  });
});
