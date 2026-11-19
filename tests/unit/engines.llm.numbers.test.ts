import { describe, expect, it } from 'vitest';
import { numeralsToDigits, parseHanNumeral, parseSinoKorean } from '@/engines/llm/numbers';

describe('parseSinoKorean', () => {
  it('reads Sino-Korean numerals', () => {
    expect(parseSinoKorean('십오')).toBe(15);
    expect(parseSinoKorean('백오십')).toBe(150);
    expect(parseSinoKorean('이백')).toBe(200);
    expect(parseSinoKorean('팔십오')).toBe(85);
    expect(parseSinoKorean('천')).toBe(1000);
    expect(parseSinoKorean('만')).toBe(10_000);
    expect(parseSinoKorean('삼만오천')).toBe(35_000);
    expect(parseSinoKorean('이천이십사')).toBe(2024);
    expect(parseSinoKorean('천이백만')).toBe(12_000_000);
    expect(parseSinoKorean('삼억')).toBe(300_000_000);
  });

  it('refuses what isn’t a numeral', () => {
    expect(parseSinoKorean('사이')).toBeNull();
    expect(parseSinoKorean('천천')).toBeNull();
    expect(parseSinoKorean('십백')).toBeNull();
    expect(parseSinoKorean('오늘')).toBeNull();
  });
});

describe('parseHanNumeral', () => {
  it('reads Japanese and Chinese numerals', () => {
    expect(parseHanNumeral('三百')).toBe(300);
    expect(parseHanNumeral('八十五')).toBe(85);
    expect(parseHanNumeral('十五')).toBe(15);
    expect(parseHanNumeral('二十')).toBe(20);
    expect(parseHanNumeral('一万二千三百四十五')).toBe(12_345);
    expect(parseHanNumeral('一百零五')).toBe(105);
    expect(parseHanNumeral('两千')).toBe(2000);
    expect(parseHanNumeral('三億')).toBe(300_000_000);
  });

  it('leaves a colloquial abbreviation alone, it reads two ways', () => {
    expect(parseHanNumeral('一百五')).toBeNull();
    expect(parseHanNumeral('三万五')).toBeNull();
    expect(parseHanNumeral('十十')).toBeNull();
  });
});

describe('numeralsToDigits: Korean', () => {
  it('converts Sino-Korean numbers standing alone or before a counter', () => {
    expect(numeralsToDigits('백오십에서 이백 장 사이')).toBe('150에서 200 장 사이');
    expect(numeralsToDigits('이번에 십오 위를 했어요')).toBe('이번에 15 위를 했어요');
    expect(numeralsToDigits('팔십오 점이야')).toBe('85 점이야');
    expect(numeralsToDigits('십오위')).toBe('15위');
    expect(numeralsToDigits('이천이십사 년에')).toBe('2024 년에');
    expect(numeralsToDigits('삼 위, 오 분, 십 분')).toBe('3 위, 5 분, 10 분');
    expect(numeralsToDigits('천 원이면 돼')).toBe('1000 원이면 돼');
    expect(numeralsToDigits('이만 원')).toBe('20000 원');
    expect(numeralsToDigits('이 개월 뒤에')).toBe('2 개월 뒤에');
  });

  it('converts native Korean numbers before a counter', () => {
    expect(numeralsToDigits('두 명이 왔어')).toBe('2 명이 왔어');
    expect(numeralsToDigits('스무 살 때')).toBe('20 살 때');
    expect(numeralsToDigits('열두 시에')).toBe('12 시에');
    expect(numeralsToDigits('세 개만 주세요')).toBe('3 개만 주세요');
    expect(numeralsToDigits('스물다섯 살')).toBe('25 살');
    expect(numeralsToDigits('한 시간 동안')).toBe('1 시간 동안');
  });

  it('leaves everyday words made of numeral syllables alone', () => {
    for (const text of [
      '일이 너무 많아',
      '이 분은 누구세요?',
      '이 사람 진짜 천사야',
      '오늘 만나서 반가워',
      '천천히 해',
      '우리 사이에',
      '오이 좀 줘',
      '이번에는 잘 해',
      '오만하지 마',
      '이만 갈게',
      '한 번 해봐',
      '네 번이야',
      '세상에',
      '한국 사람',
      '열 받아',
      '만두 먹자',
      '일 끝났어',
      '삼촌이 왔어',
      '오십견이 왔어',
      '구경하자',
      '이 위에 놓아',
      '이 분위기',
      '한 장면',
    ]) {
      expect(numeralsToDigits(text), text).toBe(text);
    }
  });
});

describe('numeralsToDigits: Japanese and Chinese', () => {
  it('converts numerals with a unit, and lone ones before a counter', () => {
    expect(numeralsToDigits('三百で買った')).toBe('300で買った');
    expect(numeralsToDigits('八十五歳です')).toBe('85歳です');
    expect(numeralsToDigits('三人で行った')).toBe('3人で行った');
    expect(numeralsToDigits('我有两个苹果')).toBe('我有2个苹果');
    expect(numeralsToDigits('一万円しかない')).toBe('10000円しかない');
    expect(numeralsToDigits('二〇二四年')).toBe('2024年');
    expect(numeralsToDigits('第十五位')).toBe('第15位');
    expect(numeralsToDigits('一月に')).toBe('1月に');
    expect(numeralsToDigits('他二十岁')).toBe('他20岁');
  });

  it('leaves words written with numerals alone', () => {
    for (const text of [
      '十分です',
      '十分好吃',
      '一緒に行こう',
      '一番好き',
      '一样',
      '唯一の方法',
      '统一',
      '千万不要',
      '万一のために',
      '八百屋さん',
      '五十嵐さん',
      '一点点',
      '一人で',
      '二度と来ない',
      '三日月',
      '千葉に行く',
      '一百五',
      '万人に愛される',
    ]) {
      expect(numeralsToDigits(text), text).toBe(text);
    }
  });

  it('leaves text without numerals as it is', () => {
    expect(numeralsToDigits('Hello there, 42 people.')).toBe('Hello there, 42 people.');
    expect(numeralsToDigits('')).toBe('');
  });
});
