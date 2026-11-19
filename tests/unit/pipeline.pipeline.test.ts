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

/** An ASR engine whose session the test drives by hand (`say`). */
function handAsr() {
  const sessions: AsrSessionOptions[] = [];
  const asr: AsrEngine = {
    info: new EchoAsrEngine().info,
    state: 'ready',
    load: async () => {},
    unload: async () => {},
    createSession(options) {
      sessions.push(options);
      return {
        startSegment: () => {},
        pushAudio: () => {},
        endSegment: () => {},
        close: async () => {},
      };
    },
  };
  let n = 0;
  const say = (text: string, tag: string, segmentId = `s${++n}`) =>
    sessions[0]?.onResult({
      segmentId,
      final: true,
      text,
      language: { tag, confidence: 1 },
      startSample: n * 1000,
      endSample: n * 1000 + 800,
    });
  return { asr, say };
}

describe('Pipeline with lines that mix languages', () => {
  it('translates a line heard as the target language when part of it is in another script', async () => {
    const requests: TranslationRequest[] = [];
    const { asr, say } = handAsr();
    const { pipeline, cues } = setup({ asr, translator: recordingTranslator(requests) });
    say('That is so 귀여워 honestly', 'en');
    say('Hello there, how are you?', 'en');
    await pipeline.close();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.source).toEqual({
      kind: 'text',
      text: 'That is so 귀여워 honestly',
      language: 'ko',
      mixed: ['ko', 'en'],
    });
    const [mixed, plain] = latest(cues);
    expect(mixed?.source.language).toBe('en');
    expect(mixed?.untranslated).toBeNull();
    expect(mixed?.translation?.final).toBe(true);
    expect(plain?.untranslated).toBe('same-language');
  });

  it('keeps a mixed line translated even when the translator hears the target language', async () => {
    const { asr, say } = handAsr();
    const translator: TranslationEngine = {
      info: new PassthroughTranslationEngine().info,
      state: 'ready',
      load: async () => {},
      unload: async () => {},
      async *translate() {
        yield { text: 'That is so cute honestly', final: true, sourceLanguage: 'en' };
      },
    };
    const { pipeline, cues } = setup({ asr, translator });
    say('That is so 귀여워 honestly', 'en');
    await pipeline.close();
    expect(latest(cues)[0]?.translation?.text).toBe('That is so cute honestly');
    expect(latest(cues)[0]?.untranslated).toBeNull();
  });

  it('marks a mixed line given back unchanged as the target language, not translated', async () => {
    const { asr, say } = handAsr();
    const translator: TranslationEngine = {
      info: new PassthroughTranslationEngine().info,
      state: 'ready',
      load: async () => {},
      unload: async () => {},
      async *translate(request) {
        const text = request.source.kind === 'text' ? request.source.text : '';
        yield { text, final: true, sourceLanguage: 'en' };
      },
    };
    const { pipeline, cues } = setup({ asr, translator });
    say('That is so 귀여워 honestly', 'en');
    await pipeline.close();
    expect(latest(cues)[0]?.translation).toBeNull();
    expect(latest(cues)[0]?.untranslated).toBe('same-language');
  });

  it('asks the detector about a finished line in the target’s own script', async () => {
    const requests: TranslationRequest[] = [];
    const { asr, say } = handAsr();
    const detected: string[] = [];
    const { pipeline, cues } = setup({
      asr,
      translator: recordingTranslator(requests),
      detectLanguages: async (text) => {
        detected.push(text);
        return text.includes('mangé')
          ? [
              { language: 'fr', confidence: 0.6 },
              { language: 'en', confidence: 0.4 },
            ]
          : [{ language: 'en', confidence: 0.98 }];
      },
    });
    say('We went to the market et puis on a mangé ensemble', 'en');
    say('We went to the market and then ate together', 'en');
    await pipeline.close();
    expect(detected).toHaveLength(2);
    expect(requests.map((r) => r.source)).toEqual([
      {
        kind: 'text',
        text: 'We went to the market et puis on a mangé ensemble',
        language: 'fr',
        mixed: ['fr', 'en'],
      },
    ]);
    const forFirst = cues.filter((c) => c.id === 's1').map((c) => c.untranslated);
    expect(forFirst[0]).toBe('same-language');
    expect(forFirst.at(-1)).toBeNull();
    expect(latest(cues)[1]?.untranslated).toBe('same-language');
  });
});

describe('Pipeline revisions', () => {
  /**
   * A translator that revises: each line's translation is `<text> (en)`; a request with the line
   * before gets `revision` (or nothing, when null) as that line's new translation.
   */
  function revisingTranslator(requests: TranslationRequest[], revision: string | null) {
    const inner = new PassthroughTranslationEngine();
    const translator: TranslationEngine = {
      info: { ...inner.info, revises: true },
      state: 'ready',
      load: async () => {},
      unload: async () => {},
      async *translate(req): AsyncIterable<TranslationChunk> {
        requests.push(req);
        const text = req.source.kind === 'text' ? req.source.text : '';
        yield { text: `${text} (en)`, final: true };
        if (req.previous && revision !== null) {
          yield { text: revision, final: true, revises: { segmentId: req.previous.segmentId } };
        }
      },
    };
    return translator;
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('revises the line before when the new one finishes its sentence', async () => {
    const requests: TranslationRequest[] = [];
    const { asr, say } = handAsr();
    const { pipeline, cues } = setup({
      asr,
      translator: revisingTranslator(requests, 'Yesterday I went to'),
    });
    say('Hier je suis allé au', 'fr');
    say('magasin avec ma sœur.', 'fr');
    await settle();
    say('Bonjour', 'fr');
    await pipeline.close();
    expect(requests[0]?.previous).toBeUndefined();
    expect(requests[1]?.previous).toEqual({
      segmentId: 's1',
      source: 'Hier je suis allé au',
      translation: 'Hier je suis allé au (en)',
      language: 'fr',
    });
    const [first, second] = latest(cues);
    expect(first?.translation).toEqual({
      text: 'Yesterday I went to',
      language: 'en',
      final: true,
    });
    expect(second?.translation?.text).toBe('magasin avec ma sœur. (en)');
    // Later lines have the revised translation as context.
    expect(requests[2]?.context[0]?.translation).toBe('Yesterday I went to');
  });

  it('leaves a line alone that ended its own sentence, or a sentence still going on', async () => {
    const requests: TranslationRequest[] = [];
    const { asr, say } = handAsr();
    const { pipeline } = setup({ asr, translator: revisingTranslator(requests, 'Revised') });
    say('Bonjour à tous.', 'fr');
    say('Aujourd’hui on va', 'fr');
    say('cuisiner une', 'fr');
    await pipeline.close();
    expect(requests.map((r) => r.previous)).toEqual([undefined, undefined, undefined]);
  });

  it('only revises a line still on screen, and not a line in the target language', async () => {
    const requests: TranslationRequest[] = [];
    const { asr, say } = handAsr();
    let now = 0;
    const { pipeline } = setup({
      asr,
      translator: revisingTranslator(requests, 'Revised'),
      now: () => now,
    });
    say('Hier je suis allé au', 'fr');
    await settle();
    now += 60_000;
    say('magasin.', 'fr');
    await settle();
    say('I went to the', 'en');
    say('magasin.', 'fr');
    await pipeline.close();
    expect(requests.map((r) => r.previous)).toEqual([undefined, undefined, undefined]);
  });

  it('keeps the translation when the revision says the same, or comes too late', async () => {
    const requests: TranslationRequest[] = [];
    const { asr, say } = handAsr();
    const { pipeline, cues } = setup({
      asr,
      translator: revisingTranslator(requests, 'Hier je suis allé au (en)'),
    });
    say('Hier je suis allé au', 'fr');
    say('magasin.', 'fr');
    await settle();
    await pipeline.close();
    expect(cues.filter((c) => c.id === 's1' && c.translation?.final)).toHaveLength(1);
  });

  it('doesn’t hold up the next line while a revision is under way', async () => {
    const order: string[] = [];
    const { asr, say } = handAsr();
    const inner = new PassthroughTranslationEngine();
    const translator: TranslationEngine = {
      info: { ...inner.info, revises: true },
      state: 'ready',
      load: async () => {},
      unload: async () => {},
      async *translate(req): AsyncIterable<TranslationChunk> {
        const text = req.source.kind === 'text' ? req.source.text : '';
        order.push(text);
        yield { text: `${text} (en)`, final: true };
        if (req.previous) {
          // A revision that never comes, until the session closes.
          await new Promise((resolve) => req.signal.addEventListener('abort', resolve));
        }
      },
    };
    const { pipeline, cues } = setup({ asr, translator });
    say('Hier je suis allé au', 'fr');
    say('magasin.', 'fr');
    say('Et voilà.', 'fr');
    await pipeline.close();
    expect(order).toEqual(['Hier je suis allé au', 'magasin.', 'Et voilà.']);
    expect(latest(cues).every((c) => c.translation?.final)).toBe(true);
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
