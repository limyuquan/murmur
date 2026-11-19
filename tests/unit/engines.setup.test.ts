import { describe, expect, it } from 'vitest';
import { packsFor } from '@/engines/chrome/setup';
import {
  CompanionError,
  EngineActionRequiredError,
  EngineUnavailableError,
  ModelError,
} from '@/engines/errors';
import type { SetupAction } from '@/engines/types';
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
    expect(describeError(new EngineActionRequiredError([action]))).toMatchObject({ code: 'setup' });
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
