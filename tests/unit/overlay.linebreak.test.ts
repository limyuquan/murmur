import { describe, expect, it } from 'vitest';
import {
  balancedLines,
  FULLWIDTH_UNITS,
  greedyLines,
  MAX_DISPLAY_MS,
  MAX_LINE_UNITS,
  MIN_DISPLAY_MS,
  paginate,
  readingMs,
  tailLines,
  textUnits,
  unitsForWidth,
} from '@/overlay/linebreak';

const fit = { maxUnits: MAX_LINE_UNITS, lang: 'en' };
const units = (lines: readonly string[]) => lines.map(textUnits);

describe('textUnits', () => {
  it('counts narrow characters as one and full-width ones as 16 per line', () => {
    expect(textUnits('hello')).toBe(5);
    expect(textUnits('東京')).toBeCloseTo(2 * FULLWIDTH_UNITS);
    expect(16 * FULLWIDTH_UNITS).toBe(MAX_LINE_UNITS);
  });
});

describe('balancedLines', () => {
  it('keeps text that fits on one line', () => {
    expect(balancedLines('Where are you going tonight?', fit)).toEqual([
      'Where are you going tonight?',
    ]);
  });

  it('splits longer text into two lines within the budget, roughly balanced', () => {
    const text = 'I told you we should have left the house before the rain started';
    const lines = balancedLines(text, fit);
    expect(lines).toHaveLength(2);
    expect(lines?.join(' ')).toBe(text);
    for (const u of units(lines ?? [])) expect(u).toBeLessThanOrEqual(MAX_LINE_UNITS);
    const [top = 0, bottom = 0] = units(lines ?? []);
    expect(Math.abs(top - bottom)).toBeLessThan(16);
  });

  it('prefers breaking after punctuation', () => {
    const comma = balancedLines('We waited for hours at the station, but nobody came', fit);
    expect(comma?.[0]).toBe('We waited for hours at the station,');
  });

  it('never separates a word from the punctuation after it', () => {
    const lines = balancedLines('Yes! Absolutely, that is exactly what I meant to say.', {
      ...fit,
      maxUnits: 30,
    });
    for (const line of lines ?? []) expect(line).not.toMatch(/^[,.!?]/);
  });

  it('returns null when two lines are not enough', () => {
    expect(balancedLines('word '.repeat(30), fit)).toBeNull();
  });

  it('breaks text written without spaces between words', () => {
    const text = '今日はとても良い天気なので、公園まで散歩に行きませんか。';
    const lines = balancedLines(text, { maxUnits: MAX_LINE_UNITS, lang: 'ja' });
    expect(lines).toHaveLength(2);
    expect(lines?.join('')).toBe(text);
    for (const u of units(lines ?? [])) expect(u).toBeLessThanOrEqual(MAX_LINE_UNITS);
    // After the comma, not before it; no line starts with closing punctuation.
    expect(lines?.[0]?.endsWith('、')).toBe(true);
    for (const line of lines ?? []) expect(line).not.toMatch(/^[、。」）]/u);
  });

  it('keeps CJK brackets with what they enclose', () => {
    const text = '彼は「明日の朝早くに出発する予定です」と言いました。';
    const lines = balancedLines(text, { maxUnits: MAX_LINE_UNITS, lang: 'zh' }) ?? [];
    expect(lines.join('')).toBe(text);
    for (const line of lines) {
      expect(line).not.toMatch(/「$/u);
      expect(line).not.toMatch(/^[」。]/u);
    }
  });

  it('honours a rendered-width limit as well as the character budget', () => {
    const measure = (s: string) => s.length * 10;
    const lines = balancedLines('one two three four five six', {
      ...fit,
      measure,
      maxWidth: 150,
    });
    expect(lines).toHaveLength(2);
    for (const line of lines ?? []) expect(measure(line)).toBeLessThanOrEqual(150);
  });

  it('splits a single word that is wider than a line', () => {
    const lines = balancedLines('x'.repeat(60), fit);
    expect(lines?.map((l) => l.length)).toEqual([42, 18]);
  });
});

describe('greedyLines / tailLines', () => {
  it('keeps earlier lines in place as text grows', () => {
    const base = 'and then we walked along the river until the sun went down behind';
    const more = `${base} the hills and the lights came on in the town`;
    const a = greedyLines(base, fit);
    const b = greedyLines(more, fit);
    expect(b.slice(0, a.length - 1)).toEqual(a.slice(0, -1));
  });

  it('shows only the last two lines of a long growing line', () => {
    const text = 'one two three four five six seven eight nine ten '.repeat(4);
    const tail = tailLines(text, fit);
    expect(tail).toHaveLength(2);
    expect(text.trim().endsWith(tail[1] ?? '?')).toBe(true);
  });
});

describe('paginate', () => {
  it('keeps short text on one page', () => {
    expect(paginate('Hello there.', fit)).toEqual([['Hello there.']]);
  });

  it('pages long text, two lines each, ending pages at sentences where it can', () => {
    const text =
      'We should go now. The last train leaves at midnight and I really do not want to miss it again, ' +
      'because the night bus takes almost two hours and stops everywhere.';
    const pages = paginate(text, fit);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.length).toBeLessThanOrEqual(2);
      for (const u of units(page)) expect(u).toBeLessThanOrEqual(MAX_LINE_UNITS);
    }
    expect(pages.flat().join(' ')).toBe(text);
    for (const page of pages) expect(page.at(-1)).toMatch(/[.,]$/);
  });
});

describe('readingMs', () => {
  it('scales with length, within 1 s and 7 s', () => {
    expect(readingMs('Hi.')).toBe(MIN_DISPLAY_MS);
    const mid = readingMs('This is a sentence of moderate length for reading.');
    expect(mid).toBeGreaterThan(MIN_DISPLAY_MS);
    expect(mid).toBeLessThan(MAX_DISPLAY_MS);
    expect(readingMs('word '.repeat(100))).toBe(MAX_DISPLAY_MS);
  });

  it('gives dense scripts more time per character', () => {
    expect(readingMs('今日はとても良い天気ですね')).toBeGreaterThan(readingMs('abcdefghijklm'));
  });
});

describe('unitsForWidth', () => {
  it('uses the guideline on wide players and fewer units on narrow ones', () => {
    expect(unitsForWidth(1280, 32)).toBe(MAX_LINE_UNITS);
    expect(unitsForWidth(300, 16)).toBeLessThan(MAX_LINE_UNITS);
    expect(unitsForWidth(10, 16)).toBe(8);
  });
});
