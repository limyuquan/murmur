import { describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from '@/engines/builtin';
import { checkEngine, type HardwareInfo, NO_HARDWARE } from '@/engines/hardware';
import { resolveEngines } from '@/engines/profiles';
import { QWEN3_ASR_INFO, QWEN3_ASR_SOURCE, qwen3Unavailable } from '@/engines/qwen3asr/info';
import { audioTokens, logMel } from '@/engines/qwen3asr/mel';
import {
  ASR_TEXT,
  endsInLoop,
  LANGUAGE,
  LANGUAGE_NAMES,
  LANGUAGE_TOKENS,
  languageIds,
  maxAnswerTokens,
  modelLanguages,
  NONE,
  parseAnswer,
  promptIds,
  rollbackPrefix,
} from '@/engines/qwen3asr/prompt';
import { TokenDecoder } from '@/engines/qwen3asr/tokenizer';
import { cacheKey, HUGGING_FACE, isPublished, MURMUR_MODELS } from '@/models/hub';
import MEL from './fixtures/qwen3-mel.json';
import TOKENS from './fixtures/qwen3-tokens.json';

/** The fixture's signal (tests/unit/fixtures/qwen3-mel.json, made with the Python processor). */
function signal(n: number): Float32Array {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / 16_000;
    x[i] =
      0.3 * Math.sin(2 * Math.PI * 440 * t) +
      0.2 * Math.sin(2 * Math.PI * (200 * t + 1500 * t * t)) * (t >= 0.3 ? 1 : 0) +
      0.05 * Math.sin(2 * Math.PI * 5000 * t);
  }
  return x;
}

const tokenizer = new TokenDecoder(TOKENS.vocab, TOKENS.added);

describe('Qwen3-ASR log-mel', () => {
  it('matches the Python feature extractor', () => {
    for (const clip of MEL.clips) {
      const { data, frames } = logMel(signal(clip.samples));
      expect(frames).toBe(clip.frames);
      let max = -Infinity;
      let min = Infinity;
      let sum = 0;
      for (const v of data) {
        max = Math.max(max, v);
        min = Math.min(min, v);
        sum += v;
      }
      expect(max).toBeCloseTo(clip.max, 4);
      expect(min).toBeCloseTo(clip.min, 4);
      expect(sum / data.length).toBeCloseTo(clip.mean, 4);
      for (const [frame, column] of Object.entries(clip.columns)) {
        column.forEach((expected, bin) => {
          const got = data[bin * frames + Number(frame)] as number;
          expect(Math.abs(got - expected)).toBeLessThan(1e-4);
        });
      }
    }
  });

  it('counts the encoder’s audio rows (13 per 100 frames)', () => {
    expect(audioTokens(100)).toBe(13);
    expect(audioTokens(50)).toBe(7);
    expect(audioTokens(107)).toBe(14);
    expect(audioTokens(1000)).toBe(130);
    expect(audioTokens(1001)).toBe(131);
  });
});

describe('Qwen3-ASR prompt', () => {
  it('builds the chat prompt around the audio rows', () => {
    const ids = promptIds(3);
    expect(ids).toEqual([
      151644, 9125, 198, 151645, 198, 151644, 882, 198, 151669, 151676, 151676, 151676, 151670,
      151645, 198, 151644, 77091, 198,
    ]);
    expect(promptIds(2, languageIds('ko')).slice(-3)).toEqual([LANGUAGE, 16134, ASR_TEXT]);
    expect(languageIds('yue')).toEqual([LANGUAGE, 72366, 2367, ASR_TEXT]);
    expect(() => languageIds('xx')).toThrow();
  });

  it('knows each language’s name tokens, all with different first tokens', () => {
    for (const [name, tag] of Object.entries(LANGUAGE_NAMES)) {
      const ids = LANGUAGE_TOKENS[tag] as readonly number[];
      expect(tokenizer.decode([...ids])).toBe(` ${name}`);
    }
    const firsts = Object.values(LANGUAGE_TOKENS).map((ids) => ids[0]);
    expect(new Set(firsts).size).toBe(30);
    expect(QWEN3_ASR_INFO.languages).toEqual(Object.keys(LANGUAGE_TOKENS));
    expect(tokenizer.decode([NONE])).toBe(' None');
  });

  it('maps spoken-language tags to the model’s', () => {
    expect(modelLanguages(['ko-KR', 'ja', 'en-US', 'zh-TW', 'xx', 'tl', 'ko'])).toEqual([
      'ko',
      'ja',
      'en',
      'zh',
      'fil',
    ]);
    expect(modelLanguages([])).toEqual([]);
  });

  it('reads the language and the text of an answer', () => {
    const [ko, ja, en, none] = TOKENS.cases.map((c) => c.ids);
    expect(parseAnswer(ko as number[], tokenizer)).toEqual({
      language: 'ko',
      languageName: 'Korean',
      text: '안녕하세요, 반갑습니다.',
      textStart: 3,
    });
    expect(parseAnswer(ja as number[], tokenizer).text).toBe('こんにちは世界');
    expect(parseAnswer(en as number[], tokenizer)).toMatchObject({
      language: 'en',
      text: 'Hello there 😀!',
    });
    expect(parseAnswer(none as number[], tokenizer)).toMatchObject({
      language: null,
      languageName: 'None',
      text: '',
    });
  });

  it('rolls back the last tokens of an answer, never its language', () => {
    const ko = TOKENS.cases[0]?.ids as number[];
    expect(rollbackPrefix(ko, 5)).toEqual(ko.slice(0, ko.length - 5));
    expect(rollbackPrefix(ko, 50)).toEqual(ko.slice(0, 3));
    expect(rollbackPrefix([LANGUAGE, NONE], 5)).toBeNull();
    expect(rollbackPrefix([9707, 1052], 1)).toBeNull();
  });

  it('caps the answer length by the audio length', () => {
    // The 4 header tokens, then 8 text tokens a second plus 16.
    expect(maxAnswerTokens(1)).toBe(28);
    expect(maxAnswerTokens(5)).toBe(60);
    expect(maxAnswerTokens(10)).toBe(100);
    expect(maxAnswerTokens(60)).toBe(256);
  });

  it('spots a decoding loop at the end of the text', () => {
    const head = [LANGUAGE, 16134, ASR_TEXT];
    const text = (ids: number[]) => [...head, ...ids];
    const rep = (unit: number[], n: number) => Array.from({ length: n }, () => unit).flat();
    // One token 8 times; 2–4 tokens 6 times; 5–16 tokens 4 times.
    expect(endsInLoop(text([5, ...rep([7], 8)]), 3)).toBe(true);
    expect(endsInLoop(text([5, ...rep([7], 7)]), 3)).toBe(false);
    expect(endsInLoop(text(rep([7, 8, 9], 6)), 3)).toBe(true);
    expect(endsInLoop(text(rep([7, 8, 9], 5)), 3)).toBe(false);
    const long = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
    expect(endsInLoop(text([1, 2, ...rep(long, 4)]), 3)).toBe(true);
    expect(endsInLoop(text([1, 2, ...rep(long, 3)]), 3)).toBe(false);
    // Repeats people say ("네 네 네") and ordinary text are not loops.
    expect(endsInLoop(text([1, 2, 3, ...rep([30], 3), 4]), 3)).toBe(false);
    expect(endsInLoop(text(Array.from({ length: 80 }, (_, i) => 100 + i)), 3)).toBe(false);
    // Only the text counts, not the header.
    expect(endsInLoop([...rep([LANGUAGE], 8)], 8)).toBe(false);
  });
});

describe('Qwen3-ASR tokenizer', () => {
  it('joins bytes split across tokens and skips special tokens', () => {
    // GPT-2's byte → character table: printable bytes map to themselves, others above 255.
    const byteChar = (b: number) => {
      const printable = (b >= 33 && b <= 126) || (b >= 161 && b <= 172) || (b >= 174 && b <= 255);
      if (printable) return String.fromCodePoint(b);
      let n = 0;
      for (let x = 0; x < b; x++) {
        if (!((x >= 33 && x <= 126) || (x >= 161 && x <= 172) || (x >= 174 && x <= 255))) n++;
      }
      return String.fromCodePoint(256 + n);
    };
    const piece = (bytes: number[]) => bytes.map(byteChar).join('');
    const smile = [...new TextEncoder().encode('😀')];
    const dec = new TokenDecoder(
      { [piece(smile.slice(0, 2))]: 1, [piece(smile.slice(2))]: 2, [piece([32, 104, 105])]: 3 },
      { '<asr_text>': 4 },
    );
    expect(dec.decode([3, 1, 2])).toBe(' hi😀');
    expect(dec.decode([4, 3])).toBe(' hi');
    expect(dec.decode([4, 3], false)).toBe('<asr_text> hi');
    // An answer cut in the middle of a character (a partial) leaves no replacement character.
    expect(dec.decode([3, 1])).toBe(' hi');
  });
});

describe('Qwen3-ASR engine info', () => {
  const GPU: HardwareInfo = {
    webgpu: { available: true, shaderF16: true, maxBufferMB: 4096 },
    deviceMemoryGB: 8,
    cores: 12,
    companion: false,
  };

  it('needs WebGPU with 16-bit float shaders', () => {
    const info = { requirements: QWEN3_ASR_INFO.requirements };
    expect(checkEngine(info, GPU)).toEqual({ ok: true });
    expect(checkEngine(info, NO_HARDWARE).ok).toBe(false);
    expect(checkEngine(info, { ...GPU, webgpu: { ...GPU.webgpu, shaderF16: false } })).toEqual({
      ok: false,
      reasons: ['Needs a GPU with 16-bit float shaders.'],
    });
  });

  it('is unavailable while its files aren’t published, where models come from Hugging Face', () => {
    expect(isPublished(MURMUR_MODELS)).toBe(false);
    expect(qwen3Unavailable(HUGGING_FACE)).toBe('model files not published yet');
    expect(qwen3Unavailable('http://127.0.0.1:4392/hf')).toBeUndefined();
    // Unit tests build like production: Balanced skips it for turbo.
    expect(QWEN3_ASR_INFO.unavailable).toBe('model files not published yet');
    const registry = createBuiltinRegistry();
    const custom = { asr: 'qwen3-asr-0.6b', translation: 'chrome-translator' };
    expect(resolveEngines('balanced', custom, registry, GPU)).toMatchObject({
      asr: 'whisper-large-v3-turbo',
      notes: ['Qwen3-ASR 0.6B: model files not published yet'],
    });
    expect(resolveEngines('custom', custom, registry, GPU).asr).toBe('whisper-base');
  });

  it('takes the encoder from the upstream export and the rest from Murmur’s repo', () => {
    const keys = QWEN3_ASR_SOURCE.files.map((f) => cacheKey(QWEN3_ASR_SOURCE, f));
    expect(keys[0]).toBe(
      'https://huggingface.co/subtitleking/qwen3-asr-0.6b-onnx/resolve/29a54e5c3dd0a68dcc7b35eea95946d1cde6c36d/onnx/audio_encoder_fp16.onnx',
    );
    expect(keys.slice(2).every((k) => k.startsWith(`${HUGGING_FACE}/${MURMUR_MODELS.repo}/`))).toBe(
      true,
    );
    expect(QWEN3_ASR_SOURCE.files.reduce((n, f) => n + f.bytes, 0)).toBe(1_054_929_591);
    expect(QWEN3_ASR_INFO.requirements.downloadMB).toBe(1055);
    for (const f of QWEN3_ASR_SOURCE.files) expect(f.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
