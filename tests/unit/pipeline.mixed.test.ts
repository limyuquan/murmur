import { describe, expect, it } from 'vitest';
import { detectForeign, foreignPart, scriptOf } from '@/pipeline/mixed';

describe('scriptOf', () => {
  it('names the script of letters and nothing for the rest', () => {
    expect(scriptOf('a')).toBe('latin');
    expect(scriptOf('é')).toBe('latin');
    expect(scriptOf('한')).toBe('hangul');
    expect(scriptOf('か')).toBe('kana');
    expect(scriptOf('カ')).toBe('kana');
    expect(scriptOf('字')).toBe('han');
    expect(scriptOf('ж')).toBe('cyrillic');
    expect(scriptOf('3')).toBeNull();
    expect(scriptOf('.')).toBeNull();
    expect(scriptOf(' ')).toBeNull();
  });
});

describe('foreignPart', () => {
  it('finds another script in a line heard as the target language', () => {
    expect(foreignPart('That is so 귀여워 honestly', 'en')).toEqual({
      language: 'ko',
      share: expect.closeTo(6 / 22, 3),
    });
    expect(foreignPart('I went there and 本当に楽しかった', 'en')?.language).toBe('ja');
    expect(foreignPart('We ate 火锅 yesterday', 'en')?.language).toBe('zh');
  });

  it('leaves a line wholly in the target language alone', () => {
    expect(foreignPart('Hello there, how are you?', 'en')).toBeNull();
    expect(foreignPart('오늘 날씨 정말 좋다', 'ko')).toBeNull();
    expect(foreignPart('今日は本当に楽しかった', 'ja')).toBeNull();
    expect(foreignPart('', 'en')).toBeNull();
    expect(foreignPart('123 … !', 'en')).toBeNull();
  });

  it('ignores a stray word that is only a small part of the line', () => {
    // One Hangul syllable (weight 2) in a long English line.
    expect(foreignPart('She said 네 and then went on talking for a while', 'en')).toBeNull();
    // A short brand name in a long Korean line.
    expect(
      foreignPart('어제 새로 산 노트북이 정말 마음에 들어서 계속 쓰고 있어 OK', 'ko'),
    ).toBeNull();
  });

  it('treats Latin in a Korean line as foreign, named from the spoken languages', () => {
    expect(foreignPart('이거 진짜 good idea 같아', 'ko', ['ko', 'fr'])?.language).toBe('fr');
    expect(foreignPart('이거 진짜 good idea 같아', 'ko')?.language).toBe('und');
  });

  it('knows Han and kana belong to Japanese, but Hangul and kana don’t to Chinese', () => {
    expect(foreignPart('今日は東京に行きます', 'ja')).toBeNull();
    expect(foreignPart('我们今天去 カフェ 吧', 'zh')?.language).toBe('ja');
  });
});

describe('detectForeign', () => {
  const ranked =
    (...r: [string, number][]) =>
    async () =>
      r.map(([language, confidence]) => ({ language, confidence }));

  it('finds another language the detector hears with meaningful confidence', async () => {
    const text = 'We went to the market et puis on a mangé ensemble';
    await expect(detectForeign(text, 'en', ranked(['fr', 0.55], ['en', 0.45]))).resolves.toBe('fr');
    await expect(detectForeign(text, 'en', ranked(['en', 0.6], ['fr', 0.38]))).resolves.toBe('fr');
  });

  it('says nothing for a line in the target language, or too short to tell', async () => {
    const text = 'We went to the market and then ate together';
    await expect(
      detectForeign(text, 'en-US', ranked(['en', 0.97], ['fr', 0.02])),
    ).resolves.toBeNull();
    await expect(detectForeign(text, 'en', ranked(['und', 0.9]))).resolves.toBeNull();
    await expect(detectForeign('Oui, ok', 'en', ranked(['fr', 0.9]))).resolves.toBeNull();
  });
});
