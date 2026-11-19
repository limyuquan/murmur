import { describe, expect, it } from 'vitest';
import { isSentenceEnd } from '@/pipeline/sentence';

const punct = (text: string, language: string | null = null) =>
  isSentenceEnd(text, { rule: 'punct', language });
const ending = (text: string, language: string | null = null) =>
  isSentenceEnd(text, { rule: 'ending', language });

describe('isSentenceEnd, punctuation', () => {
  it('takes final punctuation in any script', () => {
    for (const t of [
      'That was great.',
      'Is it ready?',
      'Wow!',
      'Wait…',
      'Wait...',
      'それは本当です。',
      '真的吗？',
      '정말요?',
      'هل أنت بخير؟',
      'यह अच्छा है।',
      'That was great.  ',
    ]) {
      expect(punct(t), t).toBe(true);
    }
  });

  it('looks through closing quotes and brackets', () => {
    expect(punct('He said "yes."')).toBe(true);
    expect(punct('「はい。」')).toBe(true);
    expect(punct('(laughs).')).toBe(true);
  });

  it('does not take a full stop that belongs to a word or number', () => {
    for (const t of [
      'It costs 3.',
      'The price went up 2.',
      'in the U.S.',
      'for example, e.g.',
      'talk to Mr.',
      'ask Dr.',
      'Peter J.',
      '.',
    ]) {
      expect(punct(t), t).toBe(false);
    }
  });

  it('needs punctuation at the very end', () => {
    for (const t of [
      '',
      '   ',
      'and then we',
      'Hello, and',
      'one: two',
      '그래서 우리는',
      'あの、',
    ]) {
      expect(punct(t), t).toBe(false);
    }
  });

  it('knows the Greek question mark only for Greek', () => {
    expect(punct('Τι κάνεις;', 'el')).toBe(true);
    expect(punct('first; second;', 'en')).toBe(false);
    expect(punct('first; second;')).toBe(false);
  });

  it('ignores endings under the punctuation rule, takes both under either', () => {
    expect(punct('진짜 맛있어요', 'ko')).toBe(false);
    expect(isSentenceEnd('진짜 맛있어요', { rule: 'either', language: 'ko' })).toBe(true);
    expect(isSentenceEnd('Right.', { rule: 'either' })).toBe(true);
    expect(isSentenceEnd('Right', { rule: 'either' })).toBe(false);
  });

  it('defaults to the punctuation rule', () => {
    expect(isSentenceEnd('Okay.')).toBe(true);
    expect(isSentenceEnd('진짜 맛있어요')).toBe(false);
  });
});

describe('isSentenceEnd, Korean endings', () => {
  it('takes sentence-final endings', () => {
    for (const t of [
      '진짜 맛있어요',
      '그건 내가 했다',
      '지금 간다',
      '감사합니다',
      '저는 학생이다',
      '어디 갑니까',
      '정말 그렇습니까',
      '같이 할까',
      '그렇죠',
      '너무 좋잖아',
      '날씨 좋네',
      '뭐 먹을래',
      '그게 뭐냐',
      '진짜 맛있어요.',
    ]) {
      expect(ending(t, 'ko'), t).toBe(true);
    }
  });

  it('does not take words that only end in the same syllable', () => {
    for (const t of [
      '바다', // sea
      '우리 바다',
      '나보다', // than
      '하루마다',
      '아까',
      '그러니까', // because: joins clauses
      '비가 오니까',
      '정말 필요',
      '제일중요',
      '언니네',
      '네', // a single syllable
      '먹고',
      '그래서',
      '맛있', // cut off inside the word
    ]) {
      expect(ending(t, 'ko'), t).toBe(false);
    }
  });

  it('uses the script when the language is unknown, never against a known one', () => {
    expect(ending('진짜 맛있어요')).toBe(true);
    expect(ending('진짜 맛있어요', 'und')).toBe(true);
    expect(ending('진짜 맛있어요', 'ja')).toBe(false);
  });
});

describe('isSentenceEnd, Japanese and Chinese endings', () => {
  it('takes Japanese sentence-final forms', () => {
    for (const t of [
      'そうですね',
      '行きます',
      '行きました',
      'なんですか',
      'いいね',
      'そうだよ',
      '見てください',
      'そうなんだ',
    ]) {
      expect(ending(t, 'ja'), t).toBe(true);
    }
  });

  it('does not take particles that also sit inside a sentence', () => {
    for (const t of ['あのね', 'それでね', '私の', '東京か', 'まだ', 'あなた', 'それで']) {
      expect(ending(t, 'ja'), t).toBe(false);
    }
  });

  it('takes Chinese question and mood particles only when the language is Chinese', () => {
    expect(ending('你好吗', 'zh')).toBe(true);
    expect(ending('走吧', 'zh-CN')).toBe(true);
    expect(ending('我们走了', 'zh')).toBe(false);
    expect(ending('你好吗')).toBe(false);
  });

  it('has no ending rule for other languages', () => {
    for (const [t, lang] of [
      ['we are done', 'en'],
      ['nous avons fini', 'fr'],
      ['ok', null],
      ['xin chào', 'vi'],
    ] as const) {
      expect(ending(t, lang), t).toBe(false);
    }
  });
});
