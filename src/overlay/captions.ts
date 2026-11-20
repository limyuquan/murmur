/**
 * What the overlay shows, pure: cues in, caption blocks out.
 *
 * - One block per speech segment, at most two blocks, newest at the bottom (roll-up). The older
 *   block leaves when the two would need more than three translation rows, unless it hasn't been
 *   on screen long enough to read; its original line goes first when space is short.
 * - Each line is at most two rows (see linebreak.ts). Growing text fills rows greedily and shows
 *   its last two, so words never move as more arrive. Finished text is balanced into two rows, or
 *   paged, each page held for its reading time.
 * - A segment stays while anything in it may still change (up to `STALE_MS` without a change),
 *   then for the reading time of what's left to read, plus a short linger.
 * - Lines that may change are marked `final: false` (dimmed); `showPartials: false` hides them.
 * - A line's language is tagged when it differs from the language mostly spoken lately.
 */
import { primaryLanguage } from '@/pipeline/language';
import type { Cue, CueText } from '@/pipeline/types';
import type { CaptionDisplay, OriginalPlacement } from '@/settings/settings';
import {
  balancedLines,
  type FitOptions,
  MIN_DISPLAY_MS,
  normalizeSpace,
  paginate,
  readingMs,
  tailLines,
} from './linebreak';

export interface CaptionLine {
  /** `original`: what was said (smaller). `main`: the translation, or the original when it's
   * already in the target language or only originals are shown. */
  role: 'original' | 'main';
  /** Rows to draw, at most two. */
  rows: string[];
  lang: string;
  final: boolean;
  /** The language to mark this line with, or null. */
  tag: string | null;
  /** Bumped each time finished text is replaced by different finished text. */
  revision: number;
}

export interface CaptionBlock {
  id: string;
  lines: CaptionLine[];
}

/** How lines are fitted, per role, without the language (set per line). */
export type RoleFit = Omit<FitOptions, 'lang'>;

export interface ViewOptions {
  display: CaptionDisplay;
  showPartials: boolean;
  originalPlacement: OriginalPlacement;
  languageTags: boolean;
  /** Draw the original line in `both` mode (off on small players). */
  showOriginal: boolean;
  fit: { main: RoleFit; original: RoleFit };
  /** Changes whenever `fit` measures differently (font, size), so cached pages are redone. */
  fitKey?: string;
}

export interface CaptionOptions {
  maxCues: number;
  /** Translation rows the visible blocks may use together before the older one must go. */
  maxMainRows: number;
  /** Rows of any kind before the older block's original line is dropped. */
  maxRows: number;
}

export const DEFAULT_CAPTION_OPTIONS: CaptionOptions = { maxCues: 2, maxMainRows: 3, maxRows: 4 };

export const DEFAULT_VIEW: ViewOptions = {
  display: 'translation',
  showPartials: true,
  originalPlacement: 'above',
  languageTags: true,
  showOriginal: true,
  fit: { main: { maxUnits: 42 }, original: { maxUnits: 42 } },
};

/** One text of a cue (source or translation) as tracked over time. */
interface Track {
  text: string;
  lang: string;
  final: boolean;
  /** When the current text became final, or null while it may change. */
  finalAt: number | null;
  /** Last text shown as final, to notice revisions. */
  lastFinal: string | null;
  revision: number;
}

interface Entry {
  cue: Cue;
  source: Track;
  translation: Track | null;
  /** When nothing in the cue could change any more, or null. */
  doneAt: number | null;
  /** Pages of the main line for the last fit, with the reading time of each. */
  pages: { key: string; pages: string[][]; times: number[] } | null;
  /** Rows of the finished original line for the last fit (laying it out is costly). */
  original: { key: string; rows: string[] } | null;
  /** When the cue last changed. */
  updatedAt: number;
  /** Stays at least until then (a cue timed on the video: to the end of its speech). */
  holdUntil: number | null;
}

/**
 * Extra time a finished line stays when nothing replaces it. Under pressure (a newer block needs
 * the rows) a line gives way as soon as its reading time is up.
 */
export const LINGER_MS = 800;

/**
 * A cue that hasn't changed for this long goes, finished or not: its engine stopped sending
 * (a translation that never came back), and it shouldn't stay on the picture for good.
 */
export const STALE_MS = 30_000;

/** Languages of recent finished lines, for the "mostly spoken" language. */
const LANGUAGE_WINDOW = 12;
const MIN_LINES_FOR_DOMINANT = 2;

export class CaptionStore {
  private entries = new Map<string, Entry>();
  private recentLanguages = new Map<string, { lang: string; weight: number }>();
  private view: ViewOptions = DEFAULT_VIEW;

  constructor(private readonly options: CaptionOptions = DEFAULT_CAPTION_OPTIONS) {}

  /** Adds or updates `cue` at `now`. `holdUntil`: it stays on screen at least until then. */
  apply(cue: Cue, now: number, holdUntil?: number): void {
    const prev = this.entries.get(cue.id);
    const source = track(prev?.source ?? null, cue.source, now) as Track;
    const translation = track(prev?.translation ?? null, cue.translation, now);
    const done = isDone(cue);
    this.entries.set(cue.id, {
      cue,
      source,
      translation,
      doneAt: done ? (prev?.doneAt ?? now) : null,
      pages: prev?.pages ?? null,
      original: prev?.original ?? null,
      updatedAt: now,
      holdUntil: holdUntil ?? prev?.holdUntil ?? null,
    });
    if (cue.source.final && cue.source.text.trim()) {
      const lang = primaryLanguage(cue.source.language);
      if (lang && lang !== 'und') {
        this.recentLanguages.delete(cue.id);
        this.recentLanguages.set(cue.id, { lang, weight: cue.source.text.length });
        while (this.recentLanguages.size > LANGUAGE_WINDOW) {
          const oldest = this.recentLanguages.keys().next().value as string;
          this.recentLanguages.delete(oldest);
        }
      }
    }
  }

  reset(): void {
    this.entries.clear();
    this.recentLanguages.clear();
  }

  /** The language most of the recent finished lines were in, or null while unclear. */
  dominantLanguage(): string | null {
    if (this.recentLanguages.size < MIN_LINES_FOR_DOMINANT) return null;
    const totals = new Map<string, number>();
    for (const { lang, weight } of this.recentLanguages.values()) {
      totals.set(lang, (totals.get(lang) ?? 0) + weight);
    }
    let best: string | null = null;
    let bestWeight = 0;
    for (const [lang, weight] of totals) {
      if (weight > bestWeight) {
        best = lang;
        bestWeight = weight;
      }
    }
    return best;
  }

  /** Blocks to draw at `now`, oldest first. Also forgets cues that have expired. */
  visible(now: number, view: ViewOptions = this.view): CaptionBlock[] {
    this.view = view;
    for (const [id, e] of this.entries) {
      if (now >= this.expiresAt(e)) this.entries.delete(id);
    }
    const dominant = view.languageTags ? this.dominantLanguage() : null;
    const recent = [...this.entries.values()]
      .sort((a, b) => a.cue.seq - b.cue.seq)
      .slice(-this.options.maxCues);
    const built = recent
      .map((e) => ({ entry: e, lines: this.linesOf(e, now, view, dominant) }))
      .filter((b) => b.lines.length > 0);

    // Room for the older block? Newest is always shown.
    if (built.length === 2) {
      const [older, newer] = built as [(typeof built)[0], (typeof built)[0]];
      const mainRows = rowsOf(older.lines, 'main') + rowsOf(newer.lines, 'main');
      if (mainRows > this.options.maxMainRows && this.wasRead(older.entry, now)) {
        built.shift();
      } else if (
        rowsOf(older.lines) + rowsOf(newer.lines) > this.options.maxRows &&
        older.lines.some((l) => l.role === 'main')
      ) {
        older.lines = older.lines.filter((l) => l.role === 'main');
      }
    }
    return built.map((b) => ({ id: b.entry.cue.id, lines: b.lines }));
  }

  /** The next time (ms) the picture changes on its own (page turn or expiry), or null. */
  nextChange(now: number): number | null {
    let next: number | null = null;
    const consider = (t: number | null) => {
      if (t !== null && t > now && (next === null || t < next)) next = t;
    };
    for (const e of this.entries.values()) {
      consider(this.expiresAt(e));
      const main = this.mainTrack(e, this.view);
      if (main?.finalAt != null && e.pages) {
        let t = main.finalAt;
        for (const ms of e.pages.times.slice(0, -1)) {
          t += ms;
          consider(t);
        }
      }
    }
    return next;
  }

  get size(): number {
    return this.entries.size;
  }

  /** When `e` should leave the screen: once read when done, or once it has gone stale. */
  expiresAt(e: Entry): number {
    const hold = e.holdUntil ?? Number.NEGATIVE_INFINITY;
    if (e.doneAt === null) return Math.max(e.updatedAt + STALE_MS, hold);
    const main = this.mainTrack(e, this.view);
    const from = main?.finalAt ?? e.doneAt;
    const reading = e.pages ? sum(e.pages.times) : readingMs(main?.text ?? e.cue.source.text);
    return Math.max(e.doneAt + MIN_DISPLAY_MS, from + reading + LINGER_MS, hold);
  }

  /** The older block has been on screen long enough to read (or can't be read yet anyway). */
  private wasRead(e: Entry, now: number): boolean {
    const main = this.mainTrack(e, this.view);
    if (!main || main.finalAt === null) return true;
    const page = this.pageAt(e, main, now);
    return now >= main.finalAt + readingMs(page.flat().join(' '));
  }

  /** The track drawn as the main line for `view`. */
  private mainTrack(e: Entry, view: ViewOptions): Track | null {
    if (view.display === 'original' || e.cue.untranslated === 'same-language') return e.source;
    return e.translation;
  }

  private linesOf(
    e: Entry,
    now: number,
    view: ViewOptions,
    dominant: string | null,
  ): CaptionLine[] {
    const tagFor = (lang: string): string | null => {
      const p = primaryLanguage(lang);
      return dominant && p && p !== 'und' && p !== dominant ? lang : null;
    };
    const lines: CaptionLine[] = [];
    const sourceTag = tagFor(e.source.lang);
    const main = this.mainTrack(e, view);

    if (main === e.source) {
      lines.push(this.line('main', e.source, e, now, view, sourceTag));
    } else {
      const wantOriginal = view.display === 'both' && view.showOriginal;
      if (main) lines.push(this.line('main', main, e, now, view, wantOriginal ? null : sourceTag));
      if (wantOriginal) {
        lines.push(this.line('original', e.source, e, now, view, sourceTag));
      } else if (!main) {
        // Translation only, not here yet: the original stands in, dimmed.
        lines.push({ ...this.line('main', e.source, e, now, view, sourceTag), final: false });
      }
    }

    const shown = lines.filter((l) => l.rows.length > 0 && (view.showPartials || l.final));
    // A lone original whose translation was hidden as partial still carries the tag.
    if (!shown.some((l) => l.role === 'original') && sourceTag) {
      const first = shown[0];
      if (first && first.tag === null) first.tag = sourceTag;
    }
    const order = view.originalPlacement === 'above' ? ['original', 'main'] : ['main', 'original'];
    return shown.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
  }

  private line(
    role: CaptionLine['role'],
    t: Track,
    e: Entry,
    now: number,
    view: ViewOptions,
    tag: string | null,
  ): CaptionLine {
    const fit = { ...view.fit[role], lang: t.lang };
    let rows: string[];
    if (!t.final) {
      rows = tailLines(t.text, fit);
    } else if (role === 'main') {
      rows = this.pageAt(e, t, now);
    } else {
      rows = this.originalRows(e, t, fit);
    }
    return { role, rows, lang: t.lang, final: t.final, tag, revision: t.revision };
  }

  /** The finished original line's rows: laid out once per text and fit, then reused. */
  private originalRows(e: Entry, t: Track, fit: FitOptions): string[] {
    const key = this.fitCacheKey(t, fit);
    if (e.original?.key !== key) {
      const rows = balancedLines(t.text, fit) ?? paginate(t.text, fit).at(-1) ?? [];
      e.original = { key, rows };
    }
    return e.original.rows;
  }

  private fitCacheKey(t: Track, fit: FitOptions): string {
    return [t.text, fit.maxUnits, fit.maxWidth ?? '', t.lang, this.view.fitKey ?? ''].join(
      '\u0000',
    );
  }

  /** The page of the main line due at `now`, paging from when it became final. */
  private pageAt(e: Entry, t: Track, now: number): string[] {
    const fit = { ...this.view.fit.main, lang: t.lang };
    const key = this.fitCacheKey(t, fit);
    if (e.pages?.key !== key) {
      const pages = paginate(t.text, fit);
      e.pages = { key, pages, times: pages.map((p) => readingMs(p.join(' '))) };
    }
    const { pages, times } = e.pages;
    let at = t.finalAt ?? now;
    for (let i = 0; i < pages.length - 1; i++) {
      at += times[i] as number;
      if (now < at) return pages[i] as string[];
    }
    return pages.at(-1) ?? [];
  }
}

function track(prev: Track | null, t: CueText | null, now: number): Track | null {
  if (!t) return null;
  const text = normalizeSpace(t.text);
  const sameFinal = prev?.final && prev.text === text;
  const revised = t.final && prev?.lastFinal != null && prev.lastFinal !== text;
  return {
    text,
    lang: t.language,
    final: t.final,
    finalAt: t.final ? (sameFinal ? (prev?.finalAt ?? now) : now) : null,
    lastFinal: t.final ? text : (prev?.lastFinal ?? null),
    revision: (prev?.revision ?? 0) + (revised ? 1 : 0),
  };
}

function rowsOf(lines: readonly CaptionLine[], role?: CaptionLine['role']): number {
  return lines.reduce((n, l) => n + (role && l.role !== role ? 0 : l.rows.length), 0);
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** Nothing in the cue will change any more. */
export function isDone(cue: Cue): boolean {
  if (!cue.source.final) return false;
  switch (cue.untranslated) {
    case 'pending':
      // Empty finals are never translated.
      return cue.source.text.trim() === '';
    case 'same-language':
    case 'failed':
      return true;
    case null:
      return cue.translation === null || cue.translation.final;
  }
}
