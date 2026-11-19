import { describe, expect, it } from 'vitest';
import {
  CaptionStore,
  DEFAULT_VIEW,
  isDone,
  LINGER_MS,
  STALE_MS,
  type ViewOptions,
} from '@/overlay/captions';
import { MIN_DISPLAY_MS, readingMs } from '@/overlay/linebreak';
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

const partialSource = (text: string, language = 'fr'): Partial<Cue> => ({
  source: { text, language, final: false },
  translation: null,
  untranslated: 'pending',
});

const view = (patch: Partial<ViewOptions> = {}): ViewOptions => ({ ...DEFAULT_VIEW, ...patch });

const texts = (store: CaptionStore, now: number, patch: Partial<ViewOptions> = {}) =>
  store
    .visible(now, view(patch))
    .map((b) => b.lines.map((l) => `${l.role}:${l.rows.join('|')}:${l.final}`));

describe('isDone', () => {
  it('waits for the final source and the final translation', () => {
    expect(isDone(cue('a', 1))).toBe(true);
    expect(isDone(cue('a', 1, partialSource('x')))).toBe(false);
    expect(isDone(cue('a', 1, { untranslated: 'pending', translation: null }))).toBe(false);
    expect(isDone(cue('a', 1, { untranslated: 'failed', translation: null }))).toBe(true);
    expect(isDone(cue('a', 1, { translation: { text: 'm', language: 'en', final: false } }))).toBe(
      false,
    );
  });
});

describe('CaptionStore lines', () => {
  it('shows the original above the translation by default, and below when asked', () => {
    const s = new CaptionStore();
    s.apply(cue('a', 1), 0);
    expect(texts(s, 0)).toEqual([['original:said a:true', 'main:meant a:true']]);
    expect(texts(s, 0, { originalPlacement: 'below' })).toEqual([
      ['main:meant a:true', 'original:said a:true'],
    ]);
  });

  it('shows the original as the main line when no translation is needed', () => {
    const s = new CaptionStore();
    s.apply(cue('a', 1, { translation: null, untranslated: 'same-language' }), 0);
    expect(texts(s, 0)).toEqual([['main:said a:true']]);
  });

  it('stands the original in, dimmed, until the translation arrives (translation mode)', () => {
    const s = new CaptionStore();
    s.apply(cue('a', 1, { translation: null, untranslated: 'pending' }), 0);
    expect(texts(s, 0, { display: 'translation' })).toEqual([['main:said a:false']]);
  });

  it('original mode shows only what was said', () => {
    const s = new CaptionStore();
    s.apply(cue('a', 1), 0);
    expect(texts(s, 0, { display: 'original' })).toEqual([['main:said a:true']]);
  });

  it('leaves the original out on small players', () => {
    const s = new CaptionStore();
    s.apply(cue('a', 1), 0);
    expect(texts(s, 0, { showOriginal: false })).toEqual([['main:meant a:true']]);
  });

  it('replaces a cue in place by id', () => {
    const s = new CaptionStore();
    s.apply(cue('a', 1, partialSource('sa')), 0);
    s.apply(cue('a', 1), 10);
    expect(texts(s, 20)).toEqual([['original:said a:true', 'main:meant a:true']]);
    expect(s.size).toBe(1);
  });

  it('hides partial lines when partials are off', () => {
    const s = new CaptionStore();
    s.apply(cue('a', 1, { translation: { text: 'half', language: 'en', final: false } }), 0);
    expect(texts(s, 0, { showPartials: false })).toEqual([['original:said a:true']]);
    s.apply(cue('b', 2, partialSource('wip')), 0);
    expect(texts(s, 0, { showPartials: false })).toEqual([['original:said a:true']]);
  });

  it('drops empty lines and empty blocks', () => {
    const s = new CaptionStore();
    s.apply(
      cue('a', 1, { ...partialSource(' '), source: { text: ' ', language: 'fr', final: true } }),
      0,
    );
    expect(texts(s, 0)).toEqual([]);
  });
});

describe('CaptionStore rows', () => {
  const long =
    'We should go now. The last train leaves at midnight and I really do not want to miss it again, ' +
    'because the night bus takes almost two hours and stops everywhere.';

  it('shows the last two rows of a growing line, and earlier rows never move', () => {
    const s = new CaptionStore();
    const words = long.split(' ');
    let previous: string[] = [];
    for (let n = 4; n <= words.length; n += 3) {
      s.apply(cue('a', 1, partialSource(words.slice(0, n).join(' '))), 0);
      const rows = s.visible(0, view())[0]?.lines[0]?.rows ?? [];
      expect(rows.length).toBeLessThanOrEqual(2);
      // Rows only grow at the end, then scroll up: the first row continues an earlier one.
      if (previous.length > 0) {
        const first = rows[0] ?? '';
        expect(previous.some((p) => first.startsWith(p))).toBe(true);
      }
      previous = rows;
    }
  });

  it('pages long finished text, each page for its reading time', () => {
    const s = new CaptionStore();
    s.apply(cue('a', 1, { translation: { text: long, language: 'en', final: true } }), 1000);
    const main = (now: number) =>
      s.visible(now, view({ display: 'translation' }))[0]?.lines[0]?.rows.join(' ');
    const first = main(1000);
    expect(first).toBe('We should go now.');
    const flip = s.nextChange(1000);
    expect(flip).toBe(1000 + readingMs('We should go now.'));
    expect(main((flip ?? 0) - 1)).toBe(first);
    expect(main(flip ?? 0)).toMatch(/^The last train/);
  });
});

describe('CaptionStore timing', () => {
  it('holds a finished cue for its reading time and a linger, then drops it', () => {
    const s = new CaptionStore();
    const text = 'x '.repeat(30).trim();
    s.apply(cue('a', 1, { translation: { text, language: 'en', final: true } }), 1000);
    s.visible(1000, view());
    const until = 1000 + readingMs(text) + LINGER_MS;
    expect(s.nextChange(1000)).toBe(until);
    expect(texts(s, until - 1)).toHaveLength(1);
    expect(texts(s, until)).toEqual([]);
    expect(s.size).toBe(0);
  });

  it('keeps a cue that is still changing however old it is', () => {
    const s = new CaptionStore();
    for (let at = 0; at <= 50_000; at += 10_000) {
      s.apply(cue('a', 1, { ...partialSource(`said ${at}`) }), at);
    }
    expect(texts(s, 60_000)).toHaveLength(1);
  });

  it('counts the hold from when the text became final, not from later re-sends', () => {
    const s = new CaptionStore();
    s.apply(cue('a', 1), 0);
    s.apply(cue('a', 1), 500);
    s.visible(500, view());
    expect(s.nextChange(500)).toBe(Math.max(MIN_DISPLAY_MS, readingMs('meant a') + LINGER_MS));
  });

  it('counts a revision when finished text changes', () => {
    const s = new CaptionStore();
    s.apply(cue('a', 1), 0);
    s.apply(cue('a', 1, { translation: { text: 'meant a', language: 'en', final: false } }), 10);
    s.apply(cue('a', 1, { translation: { text: 'meant A!', language: 'en', final: true } }), 20);
    const main = s.visible(20, view())[0]?.lines.find((l) => l.role === 'main');
    expect(main).toMatchObject({ rows: ['meant A!'], revision: 1 });
  });
});

describe('CaptionStore roll-up', () => {
  it('keeps the newest two cues, oldest on top', () => {
    const s = new CaptionStore();
    for (const [i, id] of ['a', 'b', 'c'].entries()) s.apply(cue(id, i + 1), 0);
    expect(s.visible(0, view()).map((b) => b.id)).toEqual(['b', 'c']);
  });

  it('lets an older block go once it has been read, when space is short', () => {
    const s = new CaptionStore();
    const two = 'This translation is long enough that it needs two full rows to show';
    s.apply(cue('a', 1, { translation: { text: two, language: 'en', final: true } }), 0);
    s.apply(cue('b', 2, { translation: { text: two, language: 'en', final: true } }), 0);
    // Not read yet: both stay.
    expect(s.visible(500, view()).map((b) => b.id)).toEqual(['a', 'b']);
    // Read: the older one makes room.
    expect(s.visible(readingMs(two), view()).map((b) => b.id)).toEqual(['b']);
  });

  it("drops the older block's original first when rows run out", () => {
    const s = new CaptionStore();
    const two = 'This translation is long enough that it needs two full rows to show';
    s.apply(cue('a', 1), 0);
    s.apply(
      cue('b', 2, {
        source: { text: two, language: 'fr', final: true },
        translation: { text: 'short', language: 'en', final: true },
      }),
      0,
    );
    const [older] = s.visible(0, view());
    expect(older?.lines.map((l) => l.role)).toEqual(['main']);
  });
});

describe('CaptionStore language tags', () => {
  it('tags lines only when their language differs from the one mostly spoken', () => {
    const s = new CaptionStore();
    s.apply(cue('a', 1), 0);
    s.apply(cue('b', 2), 0);
    s.apply(cue('c', 3, { source: { text: 'gesagt', language: 'de', final: true } }), 0);
    const blocks = s.visible(0, view());
    const tags = blocks.flatMap((b) => b.lines.map((l) => l.tag));
    expect(tags).toEqual([null, null, 'de', null]);
    // On the original line when it's shown, else on the main line.
    const c = blocks.at(-1);
    expect(c?.lines.find((l) => l.tag)?.role).toBe('original');
    const only = s.visible(0, view({ display: 'translation' })).at(-1);
    expect(only?.lines[0]?.tag).toBe('de');
  });

  it('shows no tags until a mostly-spoken language is clear, or when tags are off', () => {
    const s = new CaptionStore();
    s.apply(cue('a', 1, { source: { text: 'gesagt', language: 'de', final: true } }), 0);
    expect(s.visible(0, view()).flatMap((b) => b.lines.map((l) => l.tag))).toEqual([null, null]);
    for (const [i, id] of ['b', 'c', 'd'].entries()) s.apply(cue(id, i + 2), 0);
    s.apply(cue('e', 5, { source: { text: 'gesagt', language: 'de', final: true } }), 0);
    expect(s.dominantLanguage()).toBe('fr');
    const off = s.visible(0, view({ languageTags: false }));
    expect(off.flatMap((b) => b.lines.map((l) => l.tag)).every((t) => t === null)).toBe(true);
  });

  it('never tags an unknown language', () => {
    const s = new CaptionStore();
    s.apply(cue('a', 1), 0);
    s.apply(cue('b', 2), 0);
    s.apply(cue('c', 3, partialSource('…', 'und')), 0);
    expect(
      s
        .visible(0, view())
        .at(-1)
        ?.lines.map((l) => l.tag),
    ).toEqual([null]);
  });
});

describe('CaptionStore costs and leftovers', () => {
  it('lays out a long finished original once, not on every refresh', () => {
    let measured = 0;
    const measure = (text: string) => {
      measured++;
      return text.length * 8;
    };
    const fit = { maxUnits: 42, maxWidth: 336, measure };
    const s = new CaptionStore();
    const long = 'une phrase assez longue pour plusieurs lignes, '.repeat(10);
    s.apply(cue('a', 1, { source: { text: long, language: 'fr', final: true } }), 0);
    const v = view({ fit: { main: fit, original: fit }, fitKey: 'k' });
    s.visible(0, v);
    const first = measured;
    expect(first).toBeGreaterThan(0);
    // Partial updates of the next line refresh the picture many times a second.
    for (let i = 0; i < 20; i++) {
      s.apply(cue('b', 2, partialSource(`suite ${i}`)), i);
      s.visible(i, v);
    }
    const perRefresh = (measured - first) / 20;
    expect(perRefresh).toBeLessThan(50);
    // A different fit lays it out again.
    s.visible(21, view({ fit: { main: fit, original: fit }, fitKey: 'k2' }));
    expect(measured - first).toBeGreaterThan(20 * perRefresh);
  });

  it('drops a cue that stopped changing before it finished', () => {
    const s = new CaptionStore();
    s.apply(cue('a', 1, { untranslated: 'pending', translation: null }), 0);
    expect(s.visible(STALE_MS - 1).length).toBe(1);
    expect(s.nextChange(0)).toBe(STALE_MS);
    expect(s.visible(STALE_MS).length).toBe(0);
  });
});
