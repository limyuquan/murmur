import { describe, expect, it } from 'vitest';
import {
  compileGlossary,
  glossaryHits,
  glossaryMatch,
  MAX_GLOSSARY_HITS,
  partialSimilarity,
  similarity,
} from '@/engines/glossary';
import { cleanGlossary, DEFAULT_SETTINGS, MAX_GLOSSARY, mergeSettings } from '@/settings/settings';

describe('glossary matching', () => {
  it('matches whole words in spaced scripts, in any case', () => {
    expect(glossaryMatch('Rue Cler', 'on va rue cler demain')).toBe(true);
    expect(glossaryMatch('Ana', 'Ana arrive')).toBe(true);
    expect(glossaryMatch('Ana', 'Banana bread')).toBe(false);
    expect(glossaryMatch('Ana', 'Anaïs arrive', false)).toBe(false);
    expect(glossaryMatch('C++', 'I write C++ daily')).toBe(true);
  });

  it('matches unspaced scripts anywhere, short Korean names only on their own', () => {
    expect(glossaryMatch('東京', '明日は東京駅へ')).toBe(true);
    // A two-syllable name: alone, or followed by a particle.
    expect(glossaryMatch('하늘', '하늘이 왔어', false)).toBe(true);
    expect(glossaryMatch('하늘', '하늘 왔어', false)).toBe(true);
    expect(glossaryMatch('하늘', '하늘색 옷', false)).toBe(false);
    expect(glossaryMatch('하늘', '밤하늘 봐', false)).toBe(false);
  });

  it('matches names speech recognition nearly got right', () => {
    // One vowel apart in Korean is one letter of the decomposed text.
    expect(glossaryMatch('바다루', '어제 바도루 만났어')).toBe(true);
    expect(glossaryMatch('바다루', '어제 바다 만났어', true)).toBe(false);
    // Latin names: same start, one letter off.
    expect(glossaryMatch('Kowalski', 'ask kovalski about it')).toBe(true);
    expect(glossaryMatch('Kowalski', 'ask kovalski about it', false)).toBe(false);
    expect(glossaryMatch('Martin', 'Marvin said so')).toBe(false);
    // Short sources never match loosely.
    expect(glossaryMatch('Lea', 'Leo said so')).toBe(false);
  });

  it('measures similarity letter by letter', () => {
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('abcd', 'abxd')).toBe(0.75);
    expect(partialSimilarity('cat', 'the cat sat')).toBe(1);
  });

  it('gives a line only the entries it or its context uses, one per target', () => {
    const entries = [
      { source: 'Camille', target: 'Camille' },
      { source: 'Kamille', target: 'Camille' },
      { source: 'tarte Tatin', target: 'tarte Tatin' },
      { source: 'Bordeaux', target: 'Bordeaux' },
      { source: ' ', target: 'nothing' },
    ];
    expect(glossaryHits(entries, ['Kamille et Camille', 'une tarte tatin'])).toEqual([
      { source: 'Camille', target: 'Camille' },
      { source: 'tarte Tatin', target: 'tarte Tatin' },
    ]);
    expect(glossaryHits(entries, ['Rien ici'])).toEqual([]);
    expect(glossaryHits(entries, [''])).toEqual([]);
    const many = Array.from({ length: 40 }, (_, i) => ({ source: `w${i}`, target: `W${i}` }));
    const text = many.map((e) => e.source).join(' ');
    expect(glossaryHits(many, [text])).toHaveLength(MAX_GLOSSARY_HITS);
  });

  it('matches loosely exactly where the plain letter-by-letter comparison would', () => {
    // A small alphabet, so near misses are common.
    const syllables = [...'가나다라마바사아자하각난달람밥'];
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const word = (n: number) => Array.from({ length: n }, () => syllables[rand(15)]).join('');
    let agreed = 0;
    for (let t = 0; t < 1000; t++) {
      const source = word(3 + rand(3));
      const words = Array.from({ length: 1 + rand(6) }, () => word(1 + rand(5)));
      if (rand(2)) {
        // The source again, with a syllable changed (often only one letter of it).
        const near = [...source];
        near[rand(near.length)] = syllables[rand(15)] as string;
        words.splice(rand(words.length + 1), 0, near.join(''));
      }
      const text = words.join(rand(2) ? ' ' : '');
      const reference =
        text.includes(source) ||
        partialSimilarity(source.normalize('NFD'), text.replace(/\s+/g, '').normalize('NFD')) >=
          0.8;
      expect(glossaryMatch(source, text), `${source} in ${text}`).toBe(reference);
      if (reference) agreed++;
    }
    expect(agreed).toBeGreaterThan(10);
  });

  it('matches a full glossary against a request in about a millisecond', () => {
    const syllables = [...'가나다라마바사아자차카타파하각난달람밥상열정혁훈'];
    let seed = 11;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const word = (n: number) =>
      Array.from({ length: n }, () => syllables[rand(syllables.length)]).join('');
    const entries = Array.from({ length: 500 }, (_, i) => ({ source: word(4), target: `T${i}` }));
    const lines = Array.from({ length: 4 }, () =>
      Array.from({ length: 8 }, () => word(2 + rand(3))).join(' '),
    );
    const matcher = compileGlossary(entries);
    matcher.hits(lines);
    const runs = 20;
    const start = performance.now();
    for (let i = 0; i < runs; i++) matcher.hits(lines);
    const perRequest = (performance.now() - start) / runs;
    // Target < 2 ms; generous here for slow CI machines.
    expect(perRequest).toBeLessThan(10);
  });

  it('keeps valid glossary settings only', () => {
    expect(DEFAULT_SETTINGS.glossary).toEqual([]);
    expect(
      cleanGlossary([
        { source: ' Camille ', target: ' Camille ' },
        { source: 'Camille', target: 'other' },
        { source: '', target: 'x' },
        { source: 'x', target: 1 },
        'nope',
        { source: 'a'.repeat(101), target: 'b' },
      ]),
    ).toEqual([{ source: 'Camille', target: 'Camille' }]);
    const big = Array.from({ length: MAX_GLOSSARY + 5 }, (_, i) => ({
      source: `s${i}`,
      target: `t${i}`,
    }));
    expect(cleanGlossary(big)).toHaveLength(MAX_GLOSSARY);
    expect(mergeSettings({ glossary: 'bad' }).glossary).toEqual([]);
    expect(mergeSettings({ glossary: [{ source: 'a', target: 'b' }] }).glossary).toEqual([
      { source: 'a', target: 'b' },
    ]);
  });
});
