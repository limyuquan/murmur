import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineUnavailableError } from '@/engines/errors';
import { LlmOutputError } from '@/engines/llm/engine';
import { GEMMA_E2B_INFO } from '@/engines/llm/info';
import { LineFallbackTranslator, sessionTranslator, withGlossary } from '@/engines/translators';
import type {
  TranslationChunk,
  TranslationEngine,
  TranslationEngineInfo,
  TranslationRequest,
} from '@/engines/types';

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

const INFO: TranslationEngineInfo = {
  ...GEMMA_E2B_INFO,
  id: 'test-llm',
  label: 'Test LLM',
};

/** A translator scripted per call. */
function scripted(
  info: TranslationEngineInfo,
  run: (request: TranslationRequest) => AsyncGenerator<TranslationChunk>,
): TranslationEngine & { requests: TranslationRequest[]; unloaded: boolean } {
  const requests: TranslationRequest[] = [];
  return {
    info,
    state: 'ready',
    requests,
    unloaded: false,
    async load() {},
    async unload() {
      this.unloaded = true;
    },
    translate(request) {
      requests.push(request);
      return run(request);
    },
  };
}

const BACKUP_INFO: TranslationEngineInfo = {
  ...INFO,
  id: 'backup',
  label: 'Backup',
  usesGlossary: false,
};

function backup() {
  return scripted(BACKUP_INFO, async function* (r) {
    yield { text: `backup: ${r.source.kind === 'text' ? r.source.text : ''}`, final: true };
  });
}

/** A translator run that fails at once with `make()`. */
function failing(make: () => Error) {
  return async function* (): AsyncGenerator<TranslationChunk> {
    yield* [];
    throw make();
  };
}

/** Resolves when `signal` aborts. */
const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));

describe('line fallback', () => {
  afterEach(() => vi.useRealTimers());

  it('passes a line the translator manages in time', async () => {
    const primary = scripted(INFO, async function* () {
      yield { text: 'Hel', final: false };
      yield { text: 'Hello', final: true };
    });
    const events: unknown[] = [];
    const t = new LineFallbackTranslator(primary, {
      backup: async () => backup(),
      onFallback: (e) => events.push(e),
    });
    expect(t.info).toBe(INFO);
    expect(await collect(t.translate(request('Bonjour')))).toEqual([
      { text: 'Hel', final: false },
      { text: 'Hello', final: true },
    ]);
    expect(events).toEqual([]);
  });

  it('has the backup translate a line that takes too long', async () => {
    vi.useFakeTimers();
    const primary = scripted(INFO, async function* (r) {
      yield { text: 'Hel', final: false };
      await aborted(r.signal);
    });
    const events: unknown[] = [];
    const t = new LineFallbackTranslator(primary, {
      backup: async () => backup(),
      budgetMs: 3000,
      onFallback: (e) => events.push(e),
    });
    const out = collect(t.translate(request('Bonjour')));
    await vi.advanceTimersByTimeAsync(3000);
    expect(await out).toEqual([
      { text: 'Hel', final: false },
      { text: 'backup: Bonjour', final: true },
    ]);
    expect(primary.requests[0]?.signal.aborted).toBe(true);
    expect(events).toEqual([{ segmentId: 's1', reason: 'took longer than 3 s', permanent: false }]);
  });

  it('has the backup translate a line the translator fails on or rejects', async () => {
    let call = 0;
    const primary = scripted(
      INFO,
      failing(() =>
        ++call === 1
          ? new Error('boom')
          : new LlmOutputError('echo', 'repeated an earlier line (“Hi”)'),
      ),
    );
    const events: { reason: string }[] = [];
    const t = new LineFallbackTranslator(primary, {
      backup: async () => backup(),
      onFallback: (e) => events.push(e),
    });
    expect((await collect(t.translate(request('Un'))))[0]?.text).toBe('backup: Un');
    expect((await collect(t.translate(request('Deux'))))[0]?.text).toBe('backup: Deux');
    expect(events.map((e) => e.reason)).toEqual([
      'failed (boom)',
      'repeated an earlier line (“Hi”)',
    ]);
    // It still gets the next line.
    await collect(t.translate(request('Trois'))).catch(() => {});
    expect(primary.requests).toHaveLength(3);
  });

  it('uses the backup for every later line once the translator stopped for good', async () => {
    const primary = scripted(
      INFO,
      failing(() => new EngineUnavailableError('Test LLM stopped answering.')),
    );
    const events: { permanent: boolean }[] = [];
    const t = new LineFallbackTranslator(primary, {
      backup: async () => backup(),
      onFallback: (e) => events.push(e),
    });
    await collect(t.translate(request('Un')));
    expect(await collect(t.translate(request('Deux', { sourceFinal: false })))).toEqual([
      { text: 'backup: Deux', final: true },
    ]);
    expect(primary.requests).toHaveLength(1);
    expect(events).toEqual([
      { segmentId: 's1', reason: 'stopped working (Test LLM stopped answering.)', permanent: true },
    ]);
  });

  it('passes a revision of the line before after the line, with no budget nor backup', async () => {
    vi.useFakeTimers();
    const primary = scripted(INFO, async function* (r) {
      yield { text: 'Hello', final: true };
      // The revision takes longer than the line's budget, then fails: neither matters.
      await new Promise((resolve) => setTimeout(resolve, 5000));
      yield { text: 'Better', final: true, revises: { segmentId: 's0' } };
      if (r.segmentId === 's2') throw new Error('worker crashed');
    });
    const events: unknown[] = [];
    const t = new LineFallbackTranslator(primary, {
      backup: async () => backup(),
      budgetMs: 3000,
      onFallback: (e) => events.push(e),
    });
    const previous = { segmentId: 's0', source: 'Je suis', translation: 'I am' };
    const first = collect(t.translate(request('allé.', { previous })));
    const second = collect(t.translate(request('allé.', { segmentId: 's2', previous })));
    await vi.advanceTimersByTimeAsync(5000);
    const revised = [
      { text: 'Hello', final: true },
      { text: 'Better', final: true, revises: { segmentId: 's0' } },
    ];
    expect(await first).toEqual(revised);
    expect(await second).toEqual(revised);
    expect(events).toEqual([]);
  });

  it('leaves previews and aborted lines alone', async () => {
    const primary = scripted(
      INFO,
      failing(() => new Error('boom')),
    );
    const make = vi.fn(async () => backup());
    const t = new LineFallbackTranslator(primary, { backup: make });
    await expect(collect(t.translate(request('Un', { sourceFinal: false })))).rejects.toThrow(
      'boom',
    );
    const controller = new AbortController();
    controller.abort();
    expect(await collect(t.translate(request('Deux', { signal: controller.signal })))).toEqual([]);
    expect(make).not.toHaveBeenCalled();
  });

  it('unloads the backup with the translator', async () => {
    const b = backup();
    const primary = scripted(
      INFO,
      failing(() => new Error('boom')),
    );
    const t = new LineFallbackTranslator(primary, { backup: async () => b });
    await collect(t.translate(request('Un')));
    await t.unload();
    expect(primary.unloaded).toBe(true);
    expect(b.unloaded).toBe(true);
  });
});

describe('session translator', () => {
  it('gives each line the glossary entries it uses', async () => {
    const primary = scripted(INFO, async function* () {
      yield { text: 'ok', final: true };
    });
    const t = withGlossary(primary, [
      { source: 'Camille', target: 'Camille' },
      { source: 'Bordeaux', target: 'Bordeaux' },
      { source: 'Lyon', target: 'Lyon' },
    ]);
    await collect(
      t.translate(
        request('Camille arrive', {
          context: [{ source: 'On part à Lyon', translation: 'We leave for Lyon' }],
        }),
      ),
    );
    expect(primary.requests[0]?.glossary).toEqual([
      { source: 'Camille', target: 'Camille' },
      { source: 'Lyon', target: 'Lyon' },
    ]);
    // A translator without glossary support, or no glossary: unchanged.
    const plain = scripted(BACKUP_INFO, async function* () {});
    expect(withGlossary(plain, [{ source: 'a', target: 'b' }])).toBe(plain);
    expect(withGlossary(primary, [])).toBe(primary);
  });

  it('adds the line fallback only for translators that have one', async () => {
    const primary = scripted(INFO, async function* () {
      yield { text: 'ok', final: true };
    });
    const make = vi.fn(async () => backup());
    expect(sessionTranslator(primary, { backup: null })).toBe(primary);
    const wrapped = sessionTranslator(primary, { backup: make });
    expect(wrapped).toBeInstanceOf(LineFallbackTranslator);
    // Its backup loads right away, so the first slow line doesn't wait for it.
    expect(make).toHaveBeenCalledTimes(1);
  });
});
