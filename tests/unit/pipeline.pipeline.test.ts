import { describe, expect, it } from 'vitest';
import { EchoAsrEngine } from '@/engines/demo/echoAsr';
import { PassthroughTranslationEngine } from '@/engines/demo/passthroughTranslator';
import { SegmentSession } from '@/engines/segments';
import type {
  AsrEngine,
  AsrSession,
  AsrSessionOptions,
  TranslationChunk,
  TranslationEngine,
  TranslationRequest,
} from '@/engines/types';
import type { DecodeJob } from '@/engines/whisper/scheduler';
import { sameLanguage } from '@/pipeline/language';
import { Pipeline, type PipelineOptions } from '@/pipeline/pipeline';
import type { Segmenter } from '@/pipeline/segmenter';
import type { Cue } from '@/pipeline/types';
import type { AsyncVoiceActivityDetector } from '@/pipeline/vad';
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
    expect(first?.source.text).toMatch(/^Sound 1 · 0:00\.\d–0:01\.6 · -\d+ dB$/);
    expect(first?.translation).toEqual({
      text: `[en] ${first?.source.text}`,
      language: 'en',
      final: true,
    });
    expect(first?.untranslated).toBeNull();
    // Segment 1: 100 ms pre-roll from 0.4 s, speech ends at 1.5 s, plus 100 ms.
    expect(first?.startEpochMs).toBe(T0 + 400);
    expect(first?.endEpochMs).toBe(T0 + 1600);
    expect(second?.endEpochMs).toBe(T0 + 3200);
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

describe('Pipeline hardening', () => {
  it('gives up on a translation that hangs, and goes on with the next line', async () => {
    let calls = 0;
    const translator = new PassthroughTranslationEngine();
    const passthrough = translator.translate.bind(translator);
    translator.translate = (request) => {
      calls++;
      // The first line's translation never settles and ignores its signal.
      return calls === 1
        ? {
            [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
          }
        : passthrough(request);
    };
    const { pipeline, cues, errors } = setup({ translator, translationTimeoutMs: 50 });
    feed(pipeline, concat([burst(0.5, 0.3), burst(1, 0), burst(0.5, 0.3), burst(1, 0)]));
    await pipeline.close();
    const [first, second] = latest(cues);
    expect(first?.untranslated).toBe('failed');
    expect(second?.untranslated).toBeNull();
    expect(second?.translation?.final).toBe(true);
    expect(errors.map((e) => e.message)).toEqual(['The translation took too long.']);
  });

  it('orders the second line of a split segment right after its segment', async () => {
    const results: AsrSessionOptions[] = [];
    const asr: AsrEngine = {
      info: new EchoAsrEngine().info,
      state: 'ready',
      load: async () => {},
      unload: async () => {},
      createSession(options) {
        results.push(options);
        return {
          startSegment: () => {},
          pushAudio: () => {},
          endSegment: () => {},
          close: async () => {},
        };
      },
    };
    const { pipeline, cues } = setup({ asr, sourceLanguage: 'fr' });
    const session = results[0] as AsrSessionOptions;
    const say = (segmentId: string, text: string) =>
      session.onResult({
        segmentId,
        final: true,
        text,
        language: { tag: 'fr', confidence: 1 },
        startSample: 0,
        endSample: 100,
      });
    say('s1', 'un');
    // The next segment starts before the first one's second line is decided.
    session.onResult({
      segmentId: 's2',
      final: false,
      text: 'trois',
      language: null,
      startSample: 200,
      endSample: 300,
    });
    say('s1.2', 'deux');
    await pipeline.close();
    const order = latest(cues)
      .sort((a, b) => a.seq - b.seq)
      .map((c) => c.id);
    expect(order).toEqual(['s1', 's1.2', 's2']);
  });
});

describe('Pipeline with the sentence segmenter', () => {
  /**
   * A segment engine whose words end a sentence at 2.0 s ("Hello there.") and go on after that
   * ("Hello there. And more"): a stand-in for a model that writes punctuation.
   */
  function sentenceEngine(decodes: DecodeJob[]): AsrEngine {
    return {
      info: { ...new EchoAsrEngine().info, id: 'test-segments' },
      state: 'ready',
      load: async () => {},
      unload: async () => {},
      createSession: (options) =>
        new SegmentSession(
          {
            decode: async (job) => {
              decodes.push(job);
              const words =
                job.startSample >= ms(2000)
                  ? 'And more words.'
                  : job.endSample <= ms(2100)
                    ? 'Hello there.'
                    : 'Hello there. And more';
              return {
                text: words,
                language: 'fr',
                languageProb: 0.9,
                noSpeechProb: 0.01,
                avgLogprob: -0.2,
                ms: 50,
              };
            },
          },
          options,
          {},
        ),
    };
  }

  /** Pushes 20 ms frames, letting the engine's decodes finish between them. */
  async function feedLive(pipeline: Pipeline, audio: Float32Array): Promise<void> {
    for (let i = 0; i < audio.length; i += 320) {
      pipeline.push({
        samples: audio.slice(i, i + 320),
        startSample: i,
        startEpochMs: T0 + (i / RATE) * 1000,
      });
      for (let k = 0; k < 4; k++) await Promise.resolve();
    }
  }

  const ms = (n: number) => (n / 1000) * RATE;

  it('ends a line at a short pause after a sentence, reusing the probe as its final', async () => {
    const decodes: DecodeJob[] = [];
    const { pipeline, cues, errors } = setup({ asr: sentenceEngine(decodes) });
    // 1.5 s of speech, a 200 ms pause (shorter than the 250 ms that ends a line), 1.5 s more.
    await feedLive(
      pipeline,
      concat([burst(0.5, 0), burst(1.5, 0.3), burst(0.2, 0), burst(1.5, 0.3), burst(1, 0)]),
    );
    await pipeline.close();
    expect(errors).toEqual([]);
    const done = latest(cues);
    expect(done.map((c) => [c.source.text, c.source.final])).toEqual([
      ['Hello there.', true],
      ['And more words.', true],
    ]);
    expect(done[0]?.endEpochMs).toBe(T0 + 2100);
    expect(done[1]?.startEpochMs).toBe(T0 + 2100);
    // The first line's final is its probe: no final decode for s1.
    expect(decodes.filter((d) => d.segmentId === 's1').map((d) => d.kind)).toEqual([
      'partial',
      'probe',
    ]);
  });

  it('keeps Chrome-style track engines on the pause strategy', () => {
    const echo = new EchoAsrEngine();
    const asr: AsrEngine = {
      info: { ...echo.info, audioInput: 'track' },
      state: 'ready',
      load: async () => {},
      unload: async () => {},
      createSession: (options) => echo.createSession(options),
    };
    const { pipeline } = setup({ asr });
    expect((pipeline as unknown as { segmenter: Segmenter }).segmenter.config).toMatchObject({
      strategy: 'pause',
      maxSegmentMs: 20_000,
    });
  });
});

describe('Pipeline with a model speech detector', () => {
  /** Says "speech" where a frame is loud, after a delay, like a model would; can be made to fail. */
  class FakeModel implements AsyncVoiceActivityDetector {
    readonly frameSamples = 512;
    calls = 0;
    constructor(private readonly failAt = Infinity) {}
    process(frame: Float32Array): Promise<number> {
      if (this.calls++ >= this.failAt) return Promise.reject(new Error('model gone'));
      const loud = frame.some((v) => Math.abs(v) > 0.1);
      return new Promise((resolve) => setTimeout(() => resolve(loud ? 0.99 : 0.02), 1));
    }
    reset(): void {}
  }
  const audio = () =>
    concat([burst(0.5, 0), burst(1, 0.3), burst(1, 0), burst(0.6, 0.3), burst(1, 0)]);

  it('segments on the model probabilities, and close() waits for the frames in flight', async () => {
    const vad = new FakeModel();
    const { pipeline, cues, errors } = setup({ vad });
    feed(pipeline, audio());
    await pipeline.close();
    expect(errors).toEqual([]);
    expect(vad.calls).toBe(Math.floor(audio().length / 512));
    const done = latest(cues);
    expect(done.map((c) => c.source.final)).toEqual([true, true]);
    // Speech from 0.5 s to 1.5 s, in 32 ms frames: the line ends after 1.5 s, plus 100 ms.
    expect(done[0]?.endEpochMs).toBeGreaterThanOrEqual(T0 + 1600);
    expect(done[0]?.endEpochMs).toBeLessThan(T0 + 1650);
    expect((pipeline as unknown as { segmenter: Segmenter }).segmenter.config.minSpeechMs).toBe(32);
  });

  it('carries on with the energy gate when the model fails', async () => {
    const failures: Error[] = [];
    const { pipeline, cues } = setup({
      vad: new FakeModel(20),
      onVadFailure: (err) => failures.push(err),
    });
    feed(pipeline, audio());
    await pipeline.close();
    expect(failures.map((e) => e.message)).toEqual(['model gone']);
    expect(latest(cues).filter((c) => c.source.final)).toHaveLength(2);
  });

  it('is not used for engines that listen to the track', () => {
    const echo = new EchoAsrEngine();
    const asr: AsrEngine = {
      info: { ...echo.info, audioInput: 'track' },
      state: 'ready',
      load: async () => {},
      unload: async () => {},
      createSession: (options) => echo.createSession(options),
    };
    const vad = new FakeModel();
    const { pipeline } = setup({ asr, vad });
    feed(pipeline, audio());
    expect(vad.calls).toBe(0);
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
