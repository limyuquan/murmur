import { describe, expect, it } from 'vitest';
import { EchoAsrEngine } from '@/engines/demo/echoAsr';
import { PassthroughTranslationEngine } from '@/engines/demo/passthroughTranslator';
import type {
  AsrEngine,
  AsrSession,
  AsrSessionOptions,
  TranslationChunk,
  TranslationEngine,
  TranslationRequest,
} from '@/engines/types';
import { sameLanguage } from '@/pipeline/language';
import { Pipeline, type PipelineOptions } from '@/pipeline/pipeline';
import type { Cue } from '@/pipeline/types';
import { burst, concat } from './helpers';

const RATE = 16_000;
const T0 = 1_700_000_000_000;

/** Pushes `audio` as 20 ms frames heard from T0 on. */
function feed(pipeline: Pipeline, audio: Float32Array): void {
  for (let i = 0; i < audio.length; i += 320) {
    pipeline.push({
      samples: audio.slice(i, i + 320),
      startSample: i,
      startEpochMs: T0 + (i / RATE) * 1000,
    });
  }
}

function setup(overrides: Partial<PipelineOptions> = {}) {
  const cues: Cue[] = [];
  const errors: Error[] = [];
  const pipeline = new Pipeline({
    asr: new EchoAsrEngine(),
    translator: new PassthroughTranslationEngine(),
    targetLanguage: 'en',
    sourceLanguage: null,
    onCue: (cue) => cues.push(cue),
    onError: (err) => errors.push(err),
    ...overrides,
  });
  return { pipeline, cues, errors };
}

const latest = (cues: Cue[]) => {
  const byId = new Map<string, Cue>();
  for (const c of cues) byId.set(c.id, c);
  return [...byId.values()];
};

describe('Pipeline with the demo engines', () => {
  it('turns two bursts into two translated, timed cues', async () => {
    const { pipeline, cues, errors } = setup();
    feed(
      pipeline,
      concat([burst(0.5, 0), burst(1, 0.3), burst(1, 0), burst(0.6, 0.3), burst(1, 0)]),
    );
    await pipeline.close();
    expect(errors).toEqual([]);
    const done = latest(cues);
    expect(done.map((c) => c.seq)).toEqual([1, 2]);
    const [first, second] = done;
    expect(first?.source.final).toBe(true);
    expect(first?.source.text).toMatch(/^Sound 1 · 0:00\.\d–0:01\.5 · -\d+ dB$/);
    expect(first?.translation).toEqual({
      text: `[en] ${first?.source.text}`,
      language: 'en',
      final: true,
    });
    expect(first?.untranslated).toBeNull();
    // Segment 1: pre-roll from 0.3 s, speech ends at 1.5 s.
    expect(first?.startEpochMs).toBe(T0 + 300);
    expect(first?.endEpochMs).toBe(T0 + 1500);
    expect(second?.endEpochMs).toBe(T0 + 3100);
  });

  it('streams partials before the final, dimmed until final', async () => {
    const { pipeline, cues } = setup();
    feed(pipeline, concat([burst(1.2, 0.3), burst(1, 0)]));
    await pipeline.close();
    const forSeg = cues.filter((c) => c.id === 's1');
    const firstFinal = forSeg.findIndex((c) => c.source.final);
    expect(firstFinal).toBeGreaterThan(2);
    expect(forSeg.slice(0, firstFinal).every((c) => c.source.text.endsWith('…'))).toBe(true);
    // The translation streamed: a partial chunk, then the final one.
    const translations = forSeg.map((c) => c.translation).filter((t) => t !== null);
    expect(translations.some((t) => !t.final)).toBe(true);
    expect(translations.at(-1)?.final).toBe(true);
  });

  it('leaves a segment untranslated when it is already in the target language', async () => {
    const { pipeline, cues } = setup({ sourceLanguage: 'en-GB' });
    feed(pipeline, concat([burst(0.6, 0.3), burst(1, 0)]));
    await pipeline.close();
    const [cue] = latest(cues);
    expect(cue?.source.language).toBe('en-GB');
    expect(cue?.translation).toBeNull();
    expect(cue?.untranslated).toBe('same-language');
  });

  it('decides per segment from the language the engine detected', async () => {
    const languages = ['ja', 'en', 'ko'];
    const { pipeline, cues } = setup({ asr: scriptedAsr(languages) });
    feed(
      pipeline,
      concat([
        burst(0.5, 0.3),
        burst(1, 0),
        burst(0.5, 0.3),
        burst(1, 0),
        burst(0.5, 0.3),
        burst(1, 0),
      ]),
    );
    await pipeline.close();
    const done = latest(cues);
    expect(done.map((c) => [c.source.language, c.untranslated])).toEqual([
      ['ja', null],
      ['en', 'same-language'],
      ['ko', null],
    ]);
  });

  it('passes earlier final lines as context, in order', async () => {
    const requests: TranslationRequest[] = [];
    const translator = recordingTranslator(requests);
    const { pipeline } = setup({ translator, contextLines: 2, sourceLanguage: 'fr' });
    feed(
      pipeline,
      concat([
        burst(0.5, 0.3),
        burst(1, 0),
        burst(0.5, 0.3),
        burst(1, 0),
        burst(0.5, 0.3),
        burst(1, 0),
      ]),
    );
    await pipeline.close();
    expect(requests.map((r) => r.context.length)).toEqual([0, 1, 2]);
    expect(requests[2]?.context[0]?.source).toMatch(/^Sound 1/);
  });

  it('marks a cue failed when translation throws, and reports the error', async () => {
    const translator = new PassthroughTranslationEngine();
    translator.translate = async function* () {
      yield* [];
      throw new Error('model crashed');
    };
    const { pipeline, cues, errors } = setup({ translator });
    feed(pipeline, concat([burst(0.5, 0.3), burst(1, 0)]));
    await pipeline.close();
    expect(latest(cues)[0]?.untranslated).toBe('failed');
    expect(errors.map((e) => e.message)).toEqual(['model crashed']);
  });
});

describe('sameLanguage', () => {
  it('compares primary subtags and never matches unknown', () => {
    expect(sameLanguage('en-US', 'en')).toBe(true);
    expect(sameLanguage('pt-BR', 'pt-PT')).toBe(true);
    expect(sameLanguage('zh', 'ja')).toBe(false);
    expect(sameLanguage('und', 'und')).toBe(false);
    expect(sameLanguage(null, 'en')).toBe(false);
  });
});

/** An ASR engine that reports one language per segment, in order. */
function scriptedAsr(languages: string[]): AsrEngine {
  const echo = new EchoAsrEngine();
  return {
    info: echo.info,
    state: 'ready',
    load: async () => {},
    unload: async () => {},
    createSession(options: AsrSessionOptions): AsrSession {
      let n = 0;
      return echo.createSession({
        ...options,
        onResult: (r) => {
          const tag = languages[n] ?? 'und';
          if (r.final) n++;
          options.onResult({ ...r, language: { tag, confidence: 0.9 } });
        },
      });
    },
  };
}

function recordingTranslator(requests: TranslationRequest[]): TranslationEngine {
  const inner = new PassthroughTranslationEngine();
  return {
    info: inner.info,
    state: 'ready',
    load: async () => {},
    unload: async () => {},
    async *translate(req): AsyncIterable<TranslationChunk> {
      requests.push(req);
      yield* inner.translate(req);
    },
  };
}
