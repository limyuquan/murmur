/**
 * What the overlay shows, pure: cues in, caption blocks out.
 *
 * - The newest `maxCues` segments are shown, oldest on top.
 * - A segment stays while anything in it may still change, then for a reading time after it is
 *   done: max(minHoldMs, characters ÷ charsPerSecond), capped at maxHoldMs.
 * - Lines that may change are marked `final: false` (dimmed); `showPartials: false` hides them.
 */
import type { Cue } from '@/pipeline/types';
import type { CaptionDisplay } from '@/settings/settings';

export interface CaptionLine {
  /** `original`: what was said (smaller). `main`: the translation, or the original when it's
   * already in the target language or only originals are shown. */
  role: 'original' | 'main';
  text: string;
  lang: string;
  final: boolean;
}

export interface CaptionBlock {
  id: string;
  lines: CaptionLine[];
}

export interface CaptionOptions {
  maxCues: number;
  minHoldMs: number;
  maxHoldMs: number;
  charsPerSecond: number;
}

export const DEFAULT_CAPTION_OPTIONS: CaptionOptions = {
  maxCues: 2,
  minHoldMs: 1500,
  maxHoldMs: 8000,
  charsPerSecond: 15,
};

interface Entry {
  cue: Cue;
  /** When the cue stopped changing, or null while it may still change. */
  doneAt: number | null;
}

export class CaptionStore {
  private entries = new Map<string, Entry>();

  constructor(private readonly options: CaptionOptions = DEFAULT_CAPTION_OPTIONS) {}

  apply(cue: Cue, now: number): void {
    const done = isDone(cue);
    const prev = this.entries.get(cue.id);
    this.entries.set(cue.id, { cue, doneAt: done ? (prev?.doneAt ?? now) : null });
  }

  reset(): void {
    this.entries.clear();
  }

  /** Blocks to draw at `now`, oldest first. Also forgets cues that have expired. */
  visible(now: number, display: CaptionDisplay, showPartials: boolean): CaptionBlock[] {
    for (const [id, e] of this.entries) {
      if (e.doneAt !== null && now >= e.doneAt + this.holdMs(e.cue)) this.entries.delete(id);
    }
    const shown = [...this.entries.values()]
      .sort((a, b) => a.cue.seq - b.cue.seq)
      .slice(-this.options.maxCues);
    const blocks: CaptionBlock[] = [];
    for (const { cue } of shown) {
      const lines = linesFor(cue, display).filter(
        (l) => l.text.trim() !== '' && (showPartials || l.final),
      );
      if (lines.length > 0) blocks.push({ id: cue.id, lines });
    }
    return blocks;
  }

  /** The next time (ms) something expires, or null when nothing is waiting to expire. */
  nextExpiry(): number | null {
    let next: number | null = null;
    for (const e of this.entries.values()) {
      if (e.doneAt === null) continue;
      const at = e.doneAt + this.holdMs(e.cue);
      if (next === null || at < next) next = at;
    }
    return next;
  }

  get size(): number {
    return this.entries.size;
  }

  holdMs(cue: Cue): number {
    const text = cue.translation?.text ?? cue.source.text;
    const reading = (text.length / this.options.charsPerSecond) * 1000;
    return Math.min(this.options.maxHoldMs, Math.max(this.options.minHoldMs, reading));
  }
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

export function linesFor(cue: Cue, display: CaptionDisplay): CaptionLine[] {
  const original: CaptionLine = {
    role: 'original',
    text: cue.source.text,
    lang: cue.source.language,
    final: cue.source.final,
  };
  const asMain = (l: CaptionLine): CaptionLine => ({ ...l, role: 'main' });
  if (display === 'original' || cue.untranslated === 'same-language') return [asMain(original)];

  const t = cue.translation;
  const main: CaptionLine | null = t
    ? { role: 'main', text: t.text, lang: t.language, final: t.final }
    : null;
  if (display === 'translation') {
    // Until the translation arrives, the original stands in, dimmed.
    return [main ?? { ...asMain(original), final: false }];
  }
  return main ? [original, main] : [original];
}
