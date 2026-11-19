import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineUnavailableError } from '@/engines/errors';
import {
  type GenerationRecord,
  LlmOutputError,
  LlmTranslationEngine,
  type WorkerLike,
} from '@/engines/llm/engine';
import { GEMMA_E2B_ID, GEMMA_E2B_INFO } from '@/engines/llm/info';
import type { FromWorker, ToWorker } from '@/engines/llm/messages';
import { changeShare, checkOutput, cleanOutput, worthRevising } from '@/engines/llm/output';
import type { TranslationChunk, TranslationRequest } from '@/engines/types';

describe('LLM revisions', () => {
  it('counts how much a text changed, by its letters and digits', () => {
    expect(changeShare('Yesterday I went.', 'yesterday, I went')).toBe(0);
    expect(changeShare('abcd', 'abce')).toBe(0.25);
    expect(changeShare('', '')).toBe(0);
  });

  it('shows a revision that changes the line, alone', () => {
    expect(worthRevising('Yesterday I went', 'Yesterday I am gone', 'to the shop.')).toBe(true);
    expect(worthRevising('Yesterday, I went.', 'Yesterday I went', 'to the shop.')).toBe(false);
    expect(worthRevising('Yesterday I went to the shop.', 'I went', 'to the shop.')).toBe(false);
    expect(worthRevising('', 'I went', 'to the shop.')).toBe(false);
    expect(worthRevising('a'.repeat(60), 'I went', 'there')).toBe(false);
  });
});

describe('LLM output', () => {
  const labels = ['English'];

  it('keeps the subtitle: no labels, quotes, notes or echoed context', () => {
    expect(cleanOutput('Hello there')).toBe('Hello there');
    expect(cleanOutput('Translation: Hello there', { labels })).toBe('Hello there');
    expect(cleanOutput('English: "Hello there"', { labels })).toBe('Hello there');
    expect(cleanOutput('“Hello there”')).toBe('Hello there');
    expect(cleanOutput('Hello there\n(Note: a greeting)')).toBe('Hello there');
    expect(cleanOutput('[fr] Bonjour => Hello there')).toBe('Hello there');
    expect(cleanOutput('<think>hmm</think>Hello there')).toBe('Hello there');
    // A word before a colon that isn't a label stays.
    expect(cleanOutput('Mom: come here')).toBe('Mom: come here');
    expect(cleanOutput('"Hello," she said')).toBe('"Hello," she said');
    expect(cleanOutput("'Cause I can")).toBe("'Cause I can");
    // Nothing: the prompt's "unintelligible".
    expect(cleanOutput('  ')).toBe('…');
  });

  it('cleans a growing draft without waiting for the closing quote', () => {
    expect(cleanOutput('"Hello th', { labels }, true)).toBe('Hello th');
    expect(cleanOutput('Translation: Hel', { labels }, true)).toBe('Hel');
    expect(cleanOutput('', {}, true)).toBe('');
    expect(cleanOutput('<think>still thinking', {}, true)).toBe('');
  });

  it('rejects an answer that repeats an earlier line or runs away', () => {
    const context = [{ source: 'Bonjour à tous', translation: 'Hello, everyone' }];
    expect(
      checkOutput('Nice to see you', { source: 'Ravi de vous voir', context, hitLimit: false }),
    ).toEqual({ ok: true });
    expect(
      checkOutput('Hello, everyone.', { source: 'Ravi de vous voir', context, hitLimit: false }),
    ).toMatchObject({ ok: false, reason: 'echo' });
    expect(
      checkOutput('Hello, everyone. Nice to see you', {
        source: 'Ravi de vous voir',
        context,
        hitLimit: false,
      }),
    ).toMatchObject({ ok: false, reason: 'echo' });
    // The same words said again translate the same.
    expect(
      checkOutput('Hello, everyone', { source: 'Bonjour à tous !', context, hitLimit: false }),
    ).toEqual({ ok: true });
    // Short answers can't be told from a real repeat.
    expect(
      checkOutput('Yes.', {
        source: 'Oui.',
        context: [{ source: 'Ouais', translation: 'Yes' }],
        hitLimit: false,
      }),
    ).toEqual({ ok: true });
    expect(checkOutput('Ok', { source: 'Oui', context: [], hitLimit: true })).toMatchObject({
      ok: false,
      reason: 'length',
    });
    expect(
      checkOutput('blah '.repeat(30), { source: 'Oui', context: [], hitLimit: false }),
    ).toMatchObject({ ok: false, reason: 'length' });
  });
});

// ---------------------------------------------------------------------------------------------

/** A worker that answers like the real one, a token per word, when told to. */
class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: ToWorker[] = [];
  terminated = false;
  /** What the next generations answer, in order. */
  answers: string[] = [];
  /** Answer generations at once (else `step()` releases them). */
  auto = true;
  private running: { id: number; tokens: string[]; text: string } | null = null;

  postMessage(message: ToWorker): void {
    this.sent.push(message);
    if (message.type === 'load')
      queueMicrotask(() => this.emit({ type: 'ready', loadMs: 1, warmupMs: 1 }));
    if (message.type === 'generate') {
      const answer = this.answers.shift() ?? 'ok';
      this.running = { id: message.id, tokens: answer.split(/(?<= )/), text: '' };
      if (this.auto) queueMicrotask(() => this.finish());
    }
    if (message.type === 'cancel' && this.running?.id === message.id) {
      const { id, text } = this.running;
      this.running = null;
      queueMicrotask(() => this.emit({ type: 'done', id, text, cancelled: true, stats: stats() }));
    }
  }

  /** Sends one token of the running generation. */
  step(): void {
    const r = this.running;
    const token = r?.tokens.shift();
    if (!r || token === undefined) return;
    r.text += token;
    this.emit({ type: 'token', id: r.id, text: token });
  }

  /** Sends the rest of the running generation and ends it. */
  finish(): void {
    const r = this.running;
    if (!r) return;
    while (r.tokens.length > 0) this.step();
    this.running = null;
    this.emit({ type: 'done', id: r.id, text: r.text, cancelled: false, stats: stats() });
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: FromWorker): void {
    this.onmessage?.({ data: message } as MessageEvent<FromWorker>);
  }

  get generations() {
    return this.sent.filter(
      (m): m is Extract<ToWorker, { type: 'generate' }> => m.type === 'generate',
    );
  }
}

function stats() {
  return { firstTokenMs: 1, totalMs: 2, promptTokens: 10, outputTokens: 3 };
}

function request(text: string, overrides: Partial<TranslationRequest> = {}): TranslationRequest {
  return {
    segmentId: 's1',
    source: { kind: 'text', text, language: 'fr' },
    target: 'en',
    sourceFinal: true,
    context: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<TranslationChunk>): Promise<TranslationChunk[]> {
  const out: TranslationChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('LLM translation engine', () => {
  let worker: FakeWorker;
  let engine: LlmTranslationEngine;

  beforeEach(async () => {
    worker = new FakeWorker();
    engine = new LlmTranslationEngine(GEMMA_E2B_INFO, GEMMA_E2B_ID, {
      createWorker: () => worker,
      isDownloaded: async () => true,
      wasmBase: 'chrome-extension://x/litert/',
      draftIntervalMs: 0,
    });
    await engine.load({
      session: { targetLanguage: 'en', sourceLanguage: null, spokenLanguages: ['fr', 'de'] },
    });
  });

  it('loads in its worker, from the model cache, with a warm-up', async () => {
    expect(engine.state).toBe('ready');
    const load = worker.sent[0];
    expect(load).toMatchObject({
      type: 'load',
      file: 'gemma-4-E2B-it-web.litertlm',
      wasmBase: 'chrome-extension://x/litert/',
      maxNumTokens: 1024,
    });
    expect(load?.type === 'load' && load.warmup.user).toContain('CURRENT');
  });

  it('says when the model isn’t downloaded, and never starts a worker then', async () => {
    let started = false;
    const missing = new LlmTranslationEngine(GEMMA_E2B_INFO, GEMMA_E2B_ID, {
      createWorker: () => {
        started = true;
        return new FakeWorker();
      },
      isDownloaded: async () => false,
    });
    await expect(missing.load()).rejects.toMatchObject({
      name: 'ModelError',
      missing: true,
      models: ['gemma4-e2b-webgpu'],
    });
    expect(started).toBe(false);
  });

  it('can’t run here: an unavailable load hands over to the fallback', async () => {
    const w = new FakeWorker();
    w.postMessage = (m) => {
      if (m.type === 'load') {
        queueMicrotask(() =>
          w.emit({ type: 'error', id: null, message: 'no WebGPU', unavailable: true }),
        );
      }
    };
    const e = new LlmTranslationEngine(GEMMA_E2B_INFO, GEMMA_E2B_ID, {
      createWorker: () => w,
      isDownloaded: async () => true,
      wasmBase: 'chrome-extension://x/litert/',
    });
    await expect(e.load()).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(w.terminated).toBe(true);
  });

  it('streams drafts, then the cleaned final, with the line’s prompt', async () => {
    worker.answers = ['Translation: "Good morning, Camille"'];
    const records: GenerationRecord[] = [];
    engine.onGeneration = (r) => records.push(r);
    const chunks = await collect(
      engine.translate(
        request('Bonjour Camille', {
          context: [{ source: 'Salut', translation: 'Hi', language: 'fr' }],
          glossary: [{ source: 'Camille', target: 'Camille' }],
        }),
      ),
    );
    expect(chunks.at(-1)).toEqual({ text: 'Good morning, Camille', final: true });
    expect(chunks.slice(0, -1).every((c) => !c.final)).toBe(true);
    // Drafts are cleaned too (no label, no opening quote).
    expect(chunks.every((c) => !c.text.startsWith('Translation') && !c.text.startsWith('"'))).toBe(
      true,
    );
    const [gen] = worker.generations;
    expect(gen?.user).toBe(
      'GLOSSARY: Camille = Camille\nCONTEXT (earlier lines, already translated; do not translate again):\n[fr] Salut => Hi\nCURRENT (French, auto-detected): Bonjour Camille',
    );
    expect(gen?.system).toContain('The source may mix French, German and English');
    expect(records[0]).toMatchObject({
      segmentId: 's1',
      final: true,
      text: 'Good morning, Camille',
    });
  });

  it('translates a line in any language, and one whose language isn’t known', async () => {
    worker.answers = ['Hello', 'Thanks'];
    await collect(
      engine.translate(
        request('Hallo', { source: { kind: 'text', text: 'Hallo', language: 'de' } }),
      ),
    );
    await collect(
      engine.translate(
        request('Danke', { source: { kind: 'text', text: 'Danke', language: 'und' } }),
      ),
    );
    expect(worker.generations.map((g) => g.user)).toEqual([
      'CURRENT (German, auto-detected): Hallo',
      'CURRENT: Danke',
    ]);
  });

  it('gives the model number words as digits, and the line itself to the checks', async () => {
    worker.answers = ['At 85 points, it was 15th place'];
    const chunks = await collect(
      engine.translate(
        request('팔십오 점으로 십오 위', {
          source: { kind: 'text', text: '팔십오 점으로 십오 위', language: 'ko' },
          context: [{ source: '백오십 명이 왔어', translation: '150 people came', language: 'ko' }],
        }),
      ),
    );
    expect(chunks.at(-1)).toEqual({ text: 'At 85 points, it was 15th place', final: true });
    expect(worker.generations[0]?.user).toBe(
      'CONTEXT (earlier lines, already translated; do not translate again):\n[ko] 150 명이 왔어 => 150 people came\nCURRENT (Korean, auto-detected): 85 점으로 15 위',
    );
  });

  it('revises the line before with this one after it, once this line is done', async () => {
    worker.auto = false;
    worker.answers = ['to the shop with my sister.', 'Yesterday I went'];
    const previous = {
      segmentId: 's0',
      source: 'Hier je suis allé',
      translation: 'Yesterday I am gone',
      language: 'fr',
    };
    const records: GenerationRecord[] = [];
    engine.onGeneration = (r) => records.push(r);
    const out = collect(
      engine.translate(
        request('au magasin avec ma sœur.', {
          context: [
            { source: 'Bonjour', translation: 'Hello there', language: 'fr' },
            { source: previous.source, translation: previous.translation, language: 'fr' },
          ],
          previous,
        }),
      ),
    );
    await tick();
    worker.finish();
    await tick();
    worker.finish();
    expect((await out).filter((c) => c.final)).toEqual([
      { text: 'to the shop with my sister.', final: true },
      { text: 'Yesterday I went', final: true, revises: { segmentId: 's0' } },
    ]);
    const revision = worker.generations[1];
    expect(revision?.user).toBe(
      'CONTEXT (earlier lines, already translated; do not translate again):\n[fr] Bonjour => Hello there\nCURRENT (French, auto-detected): Hier je suis allé\nNEXT (the line right after CURRENT, which finishes its sentence; only for context, do not translate it): au magasin avec ma sœur.',
    );
    expect(records.map((r) => [r.segmentId, r.revision ?? false])).toEqual([
      ['s1', false],
      ['s0', true],
    ]);
  });

  it('sends no revision that changes nothing, or that takes in the next line', async () => {
    const previous = {
      segmentId: 's0',
      source: 'Hier je suis allé',
      translation: 'Yesterday I went',
    };
    worker.answers = ['to the shop.', 'Yesterday, I went.'];
    const finals = async () =>
      (await collect(engine.translate(request('au magasin.', { previous })))).filter(
        (c) => c.final,
      );
    expect(await finals()).toEqual([{ text: 'to the shop.', final: true }]);
    worker.answers = ['to the shop.', 'Yesterday I went to the shop.'];
    expect(await finals()).toEqual([{ text: 'to the shop.', final: true }]);
  });

  it('lets the next finished line go before a revision, which it stops', async () => {
    worker.auto = false;
    worker.answers = ['to the shop.', 'never sent', 'Thanks'];
    const previous = { segmentId: 's0', source: 'Hier je suis allé', translation: 'I am gone' };
    const first = collect(engine.translate(request('au magasin.', { previous })));
    await tick();
    worker.finish();
    await tick();
    // The revision runs; a finished line arrives.
    const second = collect(engine.translate(request('Merci', { segmentId: 's2' })));
    await tick();
    expect(worker.sent.some((m) => m.type === 'cancel')).toBe(true);
    await tick();
    worker.finish();
    expect((await first).filter((c) => c.final)).toEqual([{ text: 'to the shop.', final: true }]);
    expect((await second).at(-1)).toEqual({ text: 'Thanks', final: true });
  });

  it('rejects an answer that repeats the context', async () => {
    worker.answers = ['Hello, everyone'];
    const stream = engine.translate(
      request('Ravi de vous voir', {
        context: [{ source: 'Bonjour à tous', translation: 'Hello, everyone', language: 'fr' }],
      }),
    );
    await expect(collect(stream)).rejects.toBeInstanceOf(LlmOutputError);
  });

  it('runs one line at a time; a finished line goes first and stops a preview', async () => {
    worker.auto = false;
    worker.answers = ['preview text', 'first final', 'second final'];
    const preview = collect(
      engine.translate(request('Bonjour', { segmentId: 'p', sourceFinal: false })),
    );
    await tick();
    worker.step();
    const first = collect(engine.translate(request('Bonjour à tous', { segmentId: 'a' })));
    const second = collect(engine.translate(request('Merci', { segmentId: 'b' })));
    await tick();
    // The preview was cancelled; it ends without a final.
    expect(worker.sent.some((m) => m.type === 'cancel')).toBe(true);
    expect((await preview).every((c) => !c.final)).toBe(true);
    await tick();
    worker.finish();
    await tick();
    worker.finish();
    expect((await first).at(-1)).toEqual({ text: 'first final', final: true });
    expect((await second).at(-1)).toEqual({ text: 'second final', final: true });
    expect(worker.generations.map((g) => g.id)).toHaveLength(3);
  });

  it('takes the finished line due first: a live line before lines made ahead of time', async () => {
    worker.auto = false;
    worker.answers = ['running', 'live line', 'later line', 'sooner line'];
    const running = collect(engine.translate(request('Un', { segmentId: 'r', budgetMs: 15_000 })));
    await tick();
    const later = collect(
      engine.translate(request('Plus tard', { segmentId: 'later', budgetMs: 18_000 })),
    );
    const sooner = collect(
      engine.translate(request('Bientôt', { segmentId: 'sooner', budgetMs: 8_000 })),
    );
    const live = collect(engine.translate(request('En direct', { segmentId: 'live' })));
    await tick();
    for (let i = 0; i < 4; i++) {
      worker.finish();
      await tick();
    }
    await Promise.all([running, later, sooner, live]);
    const order = worker.sent.flatMap((m) => (m.type === 'generate' ? [m.user] : []));
    // The running line isn't stopped; then by when each is due.
    expect(order.map((u) => /Un|En direct|Bientôt|Plus tard/.exec(u)?.[0])).toEqual([
      'Un',
      'En direct',
      'Bientôt',
      'Plus tard',
    ]);
  });

  it('stops the generation when the request is aborted', async () => {
    worker.auto = false;
    const controller = new AbortController();
    const out = collect(engine.translate(request('Bonjour', { signal: controller.signal })));
    await tick();
    controller.abort();
    expect(await out).toEqual([]);
    expect(worker.sent.at(-1)).toMatchObject({ type: 'cancel' });
  });

  it('gives up on a worker that doesn’t answer a cancel', async () => {
    vi.useFakeTimers();
    try {
      worker.auto = false;
      worker.postMessage = function (m: ToWorker) {
        if (m.type !== 'cancel') FakeWorker.prototype.postMessage.call(this, m);
      };
      const controller = new AbortController();
      const out = collect(engine.translate(request('Bonjour', { signal: controller.signal })));
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await out;
      await vi.advanceTimersByTimeAsync(6000);
      expect(worker.terminated).toBe(true);
      await expect(collect(engine.translate(request('Encore')))).rejects.toBeInstanceOf(
        EngineUnavailableError,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails every line when the worker crashes, and frees it on unload', async () => {
    worker.auto = false;
    const out = collect(engine.translate(request('Bonjour')));
    await tick();
    worker.onerror?.({ message: 'out of memory' } as ErrorEvent);
    await expect(out).rejects.toBeInstanceOf(EngineUnavailableError);
    await engine.unload();
    expect(worker.terminated).toBe(true);
    expect(engine.state).toBe('unloaded');
  });
});
