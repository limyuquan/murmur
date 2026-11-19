import { afterEach, describe, expect, it, vi } from 'vitest';
import { packsFor, translationAction, waitForDownloads } from '@/engines/chrome/setup';
import {
  CompanionError,
  EngineActionRequiredError,
  EngineUnavailableError,
  ModelError,
} from '@/engines/errors';
import { loadWithFallback } from '@/engines/loading';
import type { AsrEngine, SetupAction, TranslationEngine } from '@/engines/types';
import { describeError } from '@/offscreen/host';

describe('packsFor', () => {
  it('lists a speech pack per spoken language and a translation pack per pair', () => {
    const packs = packsFor({
      asr: 'chrome-webspeech',
      translation: 'chrome-translator',
      spoken: ['fr', 'en', 'de', 'it', 'nl'],
      target: 'en',
    });
    expect(packs.map((p) => p.id)).toEqual([
      'speech:fr-FR',
      'speech:en-US',
      'speech:de-DE',
      'speech:it-IT',
      'translation:fr>en',
      'translation:de>en',
      'translation:it>en',
      'translation:nl>en',
    ]);
    expect(packs[0]?.label).toBe('Download French speech recognition');
  });

  it('lists only translation packs with Whisper, and none with other engines', () => {
    expect(
      packsFor({
        asr: 'whisper-base',
        translation: 'chrome-translator',
        spoken: ['fr'],
        target: 'en',
      }).map((p) => p.kind),
    ).toEqual(['translation-pack']);
    expect(
      packsFor({
        asr: 'whisper-base',
        translation: 'demo-passthrough',
        spoken: ['fr'],
        target: 'en',
      }),
    ).toEqual([]);
  });
});

describe('describeError (session failures → popup codes)', () => {
  it('maps engine errors to codes', () => {
    const action: SetupAction = {
      id: 'detector',
      kind: 'language-detector',
      label: 'x',
      languages: [],
    };
    expect(describeError(new EngineActionRequiredError([action]))).toMatchObject({
      code: 'setup',
      setup: [action],
    });
    expect(
      describeError(new ModelError('Whisper base isn’t downloaded yet.', ['w'], true)),
    ).toEqual({
      code: 'model',
      message: 'Whisper base isn’t downloaded yet.',
      missingModels: ['w'],
    });
    expect(describeError(new ModelError('Couldn’t load it.'))).toEqual({
      code: 'model',
      message: 'Couldn’t load it.',
    });
    expect(describeError(new CompanionError('Not running.'))).toMatchObject({ code: 'companion' });
    expect(describeError(new EngineUnavailableError('No speech here.'))).toMatchObject({
      code: 'model',
    });
    expect(describeError(new DOMException('x', 'NotAllowedError'))).toMatchObject({
      code: 'access',
    });
    expect(describeError(new Error('odd'))).toEqual({ code: 'unknown', message: 'odd' });
  });

  it('recognizes errors that crossed a message boundary by name', () => {
    const err = Object.assign(new Error('gone'), {
      name: 'ModelError',
      models: [],
      missing: false,
    });
    expect(describeError(err).code).toBe('model');
  });
});

describe('waitForDownloads', () => {
  const g = globalThis as { Translator?: unknown };
  afterEach(() => {
    delete g.Translator;
    vi.useRealTimers();
  });
  const pack = translationAction('fr', 'en');

  it('gives up on a pack stuck downloading, offering it again', async () => {
    vi.useFakeTimers();
    g.Translator = { availability: async () => 'downloading' };
    const wait = waitForDownloads([pack], undefined, 1000, 5000);
    const result = expect(wait).rejects.toMatchObject({
      name: 'EngineActionRequiredError',
      actions: [pack],
    });
    await vi.advanceTimersByTimeAsync(6000);
    await result;
  });

  it('stops waiting at once when the session stops', async () => {
    g.Translator = { availability: async () => 'downloading' };
    const controller = new AbortController();
    const wait = waitForDownloads([pack], controller.signal, 60_000);
    setTimeout(() => controller.abort(new Error('stopped')), 10);
    await expect(wait).rejects.toThrow('stopped');
  });

  it('returns once the packs are in', async () => {
    let state = 'downloading';
    g.Translator = { availability: async () => state };
    const wait = waitForDownloads([pack], undefined, 5);
    setTimeout(() => {
      state = 'available';
    }, 20);
    await expect(wait).resolves.toBeUndefined();
  });
});

describe('loadWithFallback', () => {
  it('gives up on a load that never finishes when the signal aborts, and unloads it', async () => {
    let unloaded = false;
    const engine = {
      info: { label: 'Stuck' },
      load: () => new Promise<void>(() => {}),
      unload: async () => {
        unloaded = true;
      },
    } as unknown as AsrEngine;
    const controller = new AbortController();
    const loading = loadWithFallback(
      'stuck',
      async () => engine,
      (e) => e.load(),
      controller.signal,
    );
    controller.abort(new Error('stopped'));
    await expect(loading).rejects.toThrow('stopped');
    expect(unloaded).toBe(true);
  });
});

describe('loadWithFallback for translators', () => {
  /** Engines that fail to load as `failures` says, by id. */
  function engines(failures: Record<string, Error>) {
    const loaded: string[] = [];
    const create = async (id: string) =>
      ({
        info: { id, label: id },
        load: async () => {
          loaded.push(id);
          if (failures[id]) throw failures[id];
        },
        unload: async () => {},
      }) as unknown as TranslationEngine;
    return { loaded, create };
  }
  const missing = (id: string) => new ModelError(`${id} isn’t downloaded yet.`, [id], true);

  it('steps down to E2B, then Chrome’s translator, while models aren’t downloaded', async () => {
    const { loaded, create } = engines({
      'gemma4-e4b': missing('gemma4-e4b'),
      'gemma4-e2b': missing('gemma4-e2b'),
    });
    const fell: string[] = [];
    const engine = await loadWithFallback('gemma4-e4b', create, (e) => e.load(), undefined, {
      onModelError: true,
      onFallback: (id) => fell.push(id),
    });
    expect(engine.info.id).toBe('chrome-translator');
    expect(loaded).toEqual(['gemma4-e4b', 'gemma4-e2b', 'chrome-translator']);
    expect(fell).toEqual(['gemma4-e4b', 'gemma4-e2b']);
  });

  it('hands a model that doesn’t load over to Chrome’s translator', async () => {
    const { create } = engines({ 'gemma4-e2b': new ModelError('Couldn’t load Gemma 4 E2B.') });
    const engine = await loadWithFallback('gemma4-e2b', create, (e) => e.load(), undefined, {
      onModelError: true,
    });
    expect(engine.info.id).toBe('chrome-translator');
  });

  it('keeps the failure when asked not to, or with nothing to fall back to', async () => {
    const { create } = engines({
      'gemma4-e2b': missing('gemma4-e2b'),
      'whisper-base': missing('whisper-base'),
    });
    await expect(loadWithFallback('gemma4-e2b', create, (e) => e.load())).rejects.toThrow(
      'gemma4-e2b isn’t downloaded yet.',
    );
    await expect(
      loadWithFallback('whisper-base', create, (e) => e.load(), undefined, { onModelError: true }),
    ).rejects.toThrow('whisper-base isn’t downloaded yet.');
  });

  it('still asks for Chrome’s pack when the stand-in needs one', async () => {
    const pack = new EngineActionRequiredError([translationAction('fr', 'en')]);
    const { create } = engines({ 'gemma4-e2b': missing('gemma4-e2b'), 'chrome-translator': pack });
    await expect(
      loadWithFallback('gemma4-e2b', create, (e) => e.load(), undefined, { onModelError: true }),
    ).rejects.toBe(pack);
  });
});
