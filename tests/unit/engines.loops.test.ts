import { describe, expect, it } from 'vitest';
import { compressionRatio, MAX_COMPRESSION_RATIO, maxTextTokens } from '@/engines/loops';

/** A decode stuck in a loop, the way Qwen3-ASR writes one (from the segmentation benchmark). */
const LOOPED = `됐습니다. ${'좋아요. '.repeat(40)}`;

describe('decoding loop guards', () => {
  it('caps the text at 8 tokens a second plus 16', () => {
    expect(maxTextTokens(0)).toBe(16);
    expect(maxTextTokens(1)).toBe(24);
    expect(maxTextTokens(4)).toBe(48);
    expect(maxTextTokens(5)).toBe(56);
    expect(maxTextTokens(2.25)).toBe(34);
    // A fast line of real speech, about 9 Qwen3-ASR tokens a second over 5 s, still fits.
    expect(maxTextTokens(5)).toBeGreaterThanOrEqual(45);
  });

  it("estimates zlib's compression ratio", () => {
    // `len(b) / len(zlib.compress(b))` in Python, for comparison.
    const cases: [string, number][] = [
      ['', 0],
      ['좋아요 좋아요', 0.905],
      ['The quick brown fox jumps over the lazy dog.', 0.863],
      ['오늘 경기는 정말 재미있었고 다음 주에도 꼭 다시 오고 싶어요.', 0.934],
      ['今日はとても楽しかったです。また来週も来たいです。', 1.027],
      [LOOPED, 12.27],
    ];
    for (const [text, zlib] of cases) {
      expect(Math.abs(compressionRatio(text) - zlib)).toBeLessThanOrEqual(zlib * 0.1);
    }
  });

  it('scores loops above 2.4 and speech below', () => {
    expect(MAX_COMPRESSION_RATIO).toBe(2.4);
    expect(compressionRatio(LOOPED)).toBeGreaterThan(MAX_COMPRESSION_RATIO);
    expect(compressionRatio('네 '.repeat(30))).toBeGreaterThan(MAX_COMPRESSION_RATIO);
    expect(compressionRatio('ありがとう'.repeat(20))).toBeGreaterThan(MAX_COMPRESSION_RATIO);
    // Real lines, with the repeats people do say.
    for (const line of [
      '아 진짜 아 진짜 너무 웃기다',
      'No, no, no. I said the other one.',
      '오늘 경기는 정말 재미있었고 다음 주에도 꼭 다시 오고 싶어요. 다들 고생 많으셨습니다.',
      'ㅋㅋㅋㅋ 아니 그게 아니라',
    ]) {
      expect(compressionRatio(line)).toBeLessThan(MAX_COMPRESSION_RATIO);
    }
  });

  it('is fast', () => {
    const lines = Array.from({ length: 200 }, (_, i) =>
      i % 2
        ? LOOPED
        : `오늘 경기는 정말 재미있었고 ${i}번째 줄입니다. 다음 주에도 꼭 다시 오고 싶어요.`,
    );
    const start = performance.now();
    for (const line of lines) compressionRatio(line);
    // Well under a millisecond a line (about 50 µs), even on a slow test machine.
    expect((performance.now() - start) / lines.length).toBeLessThan(2);
  });
});
