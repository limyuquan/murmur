import { describe, expect, it } from 'vitest';
import { CaptionStore, isDone, linesFor } from '@/overlay/captions';
import type { Cue } from '@/pipeline/types';

function cue(id: string, seq: number, patch: Partial<Cue> = {}): Cue {
  return {
    id,
    seq,
    startEpochMs: 0,
    endEpochMs: 1000,
    source: { text: `said ${id}`, language: 'fr', final: true },
    translation: { text: `meant ${id}`, language: 'en', final: true },
    untranslated: null,
    ...patch,
  };
}

const texts = (
  store: CaptionStore,
  now: number,
  display: 'both' | 'translation' | 'original' = 'both',
  partials = true,
) =>
  store
    .visible(now, display, partials)
    .map((b) => b.lines.map((l) => `${l.role}:${l.text}:${l.final}`));

describe('linesFor', () => {
  it('shows original over translation in both mode', () => {
    expect(linesFor(cue('a', 1), 'both').map((l) => l.role)).toEqual(['original', 'main']);
  });

  it('shows the original as the main line when no translation is needed', () => {
    const c = cue('a', 1, { translation: null, untranslated: 'same-language' });
    expect(linesFor(c, 'both')).toEqual([
      { role: 'main', text: 'said a', lang: 'fr', final: true },
    ]);
  });

  it('stands the original in, dimmed, until the translation arrives (translation mode)', () => {
    const c = cue('a', 1, { translation: null, untranslated: 'pending' });
    expect(linesFor(c, 'translation')).toEqual([
      { role: 'main', text: 'said a', lang: 'fr', final: false },
    ]);
  });

  it('original mode shows only what was said', () => {
    expect(linesFor(cue('a', 1), 'original').map((l) => l.text)).toEqual(['said a']);
  });
});

describe('isDone', () => {
  it('waits for the final source and the final translation', () => {
    expect(isDone(cue('a', 1))).toBe(true);
    expect(isDone(cue('a', 1, { source: { text: 'x', language: 'fr', final: false } }))).toBe(
      false,
    );
    expect(isDone(cue('a', 1, { untranslated: 'pending', translation: null }))).toBe(false);
    expect(isDone(cue('a', 1, { untranslated: 'failed', translation: null }))).toBe(true);
    expect(isDone(cue('a', 1, { translation: { text: 'm', language: 'en', final: false } }))).toBe(
      false,
    );
  });
});

describe('CaptionStore', () => {
  it('replaces a cue in place by id', () => {
    const s = new CaptionStore();
    s.apply(
      cue('a', 1, {
        source: { text: 'sa', language: 'fr', final: false },
        translation: null,
        untranslated: 'pending',
      }),
      0,
    );
    s.apply(cue('a', 1), 10);
    expect(texts(s, 20)).toEqual([['original:said a:true', 'main:meant a:true']]);
    expect(s.size).toBe(1);
  });

  it('keeps the newest two cues, oldest on top', () => {
    const s = new CaptionStore();
    for (const [i, id] of ['a', 'b', 'c'].entries()) s.apply(cue(id, i + 1), 0);
    expect(s.visible(0, 'both', true).map((b) => b.id)).toEqual(['b', 'c']);
  });

  it('holds a finished cue for its reading time, then drops it', () => {
    const s = new CaptionStore({
      maxCues: 2,
      minHoldMs: 1500,
      maxHoldMs: 8000,
      charsPerSecond: 15,
    });
    const long = cue('a', 1, {
      translation: { text: 'x'.repeat(60), language: 'en', final: true },
    });
    s.apply(long, 1000);
    expect(s.nextExpiry()).toBe(1000 + 4000);
    expect(texts(s, 4999)).toHaveLength(1);
    expect(texts(s, 5000)).toEqual([]);
    expect(s.size).toBe(0);
  });

  it('keeps a cue that is still changing however old it is', () => {
    const s = new CaptionStore();
    s.apply(cue('a', 1, { untranslated: 'pending', translation: null }), 0);
    expect(s.nextExpiry()).toBeNull();
    expect(texts(s, 60_000)).toHaveLength(1);
  });

  it('counts the hold from when the cue became done, not from later re-sends', () => {
    const s = new CaptionStore();
    s.apply(cue('a', 1), 0);
    s.apply(cue('a', 1), 1000);
    expect(s.nextExpiry()).toBe(1500);
  });

  it('hides partial lines when partials are off', () => {
    const s = new CaptionStore();
    s.apply(cue('a', 1, { translation: { text: 'half', language: 'en', final: false } }), 0);
    expect(texts(s, 0, 'both', false)).toEqual([['original:said a:true']]);
    s.apply(
      cue('b', 2, {
        source: { text: 'wip', language: 'fr', final: false },
        translation: null,
        untranslated: 'pending',
      }),
      0,
    );
    expect(texts(s, 0, 'both', false)).toEqual([['original:said a:true']]);
  });

  it('drops empty lines and empty blocks', () => {
    const s = new CaptionStore();
    s.apply(
      cue('a', 1, {
        source: { text: ' ', language: 'fr', final: true },
        translation: null,
        untranslated: 'pending',
      }),
      0,
    );
    expect(texts(s, 0)).toEqual([]);
  });
});
