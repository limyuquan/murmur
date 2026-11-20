/**
 * Whether a session's models keep falling behind the speech, so that it should step down its
 * ladder (profiles.ts `LADDERS`) as it does when a model runs out of memory: the memory ladder
 * only hears of memory, and a pair that fits can still be too slow (Gemma 4 E4B on a MacBook Air
 * M2 fit, but missed the live budget on 15 of 63 lines and put subtitles ~5 s behind).
 *
 * Two signs, judged over recent lines rather than moments, so a hard passage or a pause doesn't
 * count:
 * - the translator took longer than its budget (`LINE_BUDGET_MS`, the backup then translated the
 *   line) on at least `maxSlowShare` of the last `lines` finished live lines, once that many
 *   lines have been seen, with the late ones spread over at least `minSpanMs` (a stall of a few
 *   seconds makes several lines in a row late). A late line that spent most of its budget
 *   waiting for the line before it (`waitedMs`) counts neither way: one stall makes every line
 *   queued behind it late too;
 * - speech recognition's real-time factor (the median of its last few decodes, `AsrHealth.rtf`)
 *   stayed above `maxRtf` for the last `rtfLines` finished lines in a row.
 *
 * The host leaves out lines while the tab is hidden or Murmur's own lookahead is busy on the same
 * models (`offscreen/host.ts`). One finding is only a strike: the service worker steps down after
 * a second session falls behind at the same step (settings/memoryfit.ts).
 *
 * Pure: the offscreen host feeds it and decides what stepping down means (the next ladder step:
 * a smaller translator for the translator, a smaller speech model for speech recognition).
 */
export interface SlownessOptions {
  /** Finished live lines the translator's share is over. Default 30. */
  lines?: number;
  /** Share of those that took too long to count as falling behind. Default 0.2. */
  maxSlowShare?: number;
  /** Speech recognition's real-time factor above which it counts as slow. Default 0.6. */
  maxRtf?: number;
  /** Finished lines in a row with the factor above `maxRtf`. Default 15. */
  rtfLines?: number;
  /** Shortest time the translator's late lines in the window may span, ms. Default 2 minutes. */
  minSpanMs?: number;
  /** The translator's budget per line, ms (for `waitedMs`). Default 3000. */
  budgetMs?: number;
}

/** A finished live line from the translator. */
export interface TranslatedLine {
  /** It ran out of its budget. */
  slow: boolean;
  /** How long it waited for lines before it to finish first, ms. */
  waitedMs?: number;
}

export type Slowness =
  | { engine: 'translator'; slow: number; lines: number }
  | { engine: 'asr'; rtf: number; lines: number };

export class SlownessWatch {
  private readonly lines: number;
  private readonly maxSlow: number;
  private readonly maxRtf: number;
  private readonly rtfLines: number;
  private readonly minSpanMs: number;
  private readonly budgetMs: number;
  /** The last `lines` translated lines: when, and whether too slow. */
  private readonly outcomes: { at: number; slow: boolean }[] = [];
  /** Finished lines in a row with the factor above `maxRtf`, and the latest factor. */
  private overRtf = 0;
  private lastRtf = 0;
  private fired: Slowness | null = null;

  constructor(options: SlownessOptions = {}) {
    this.lines = options.lines ?? 30;
    this.maxSlow = Math.max(1, Math.ceil(this.lines * (options.maxSlowShare ?? 0.2)));
    this.maxRtf = options.maxRtf ?? 0.6;
    this.rtfLines = options.rtfLines ?? 15;
    this.minSpanMs = options.minSpanMs ?? 2 * 60_000;
    this.budgetMs = options.budgetMs ?? 3000;
  }

  /** The translator finished a live line at `now` (epoch ms): within its budget, or too slow. */
  onTranslated(line: TranslatedLine, now: number = Date.now()): Slowness | null {
    if (this.fired) return null;
    // Late mostly from waiting behind a late line: says little about this one.
    if (line.slow && (line.waitedMs ?? 0) > this.budgetMs / 2) return null;
    this.outcomes.push({ at: now, slow: line.slow });
    if (this.outcomes.length > this.lines) this.outcomes.shift();
    if (this.outcomes.length < this.lines) return null;
    const slow = this.outcomes.filter((o) => o.slow);
    const count = slow.length;
    if (count < this.maxSlow) return null;
    // Late lines all within a short stretch: something else had the graphics card for a while.
    const spread = (slow.at(-1) as { at: number }).at - (slow[0] as { at: number }).at;
    if (spread < this.minSpanMs) return null;
    return this.fire({ engine: 'translator', slow: count, lines: this.outcomes.length });
  }

  /**
   * Speech recognition finished a line with text; `rtf` is its real-time factor as last
   * reported (null: not measured, which doesn't count either way).
   */
  onRecognized(rtf: number | null): Slowness | null {
    if (this.fired || rtf === null) return null;
    if (rtf <= this.maxRtf) {
      this.overRtf = 0;
      return null;
    }
    this.overRtf++;
    this.lastRtf = rtf;
    if (this.overRtf < this.rtfLines) return null;
    return this.fire({ engine: 'asr', rtf: this.lastRtf, lines: this.overRtf });
  }

  /** What it found, once; nothing more after. */
  private fire(found: Slowness): Slowness {
    this.fired = found;
    return found;
  }
}

/** "took longer than 3 s on 7 of the last 30 lines", "took 0.8 s per second of speech". */
export function describeSlowness(found: Slowness, budgetMs: number): string {
  return found.engine === 'translator'
    ? `took longer than ${Number((budgetMs / 1000).toFixed(1))} s on ${found.slow} of the last ${found.lines} lines`
    : `took ${found.rtf.toFixed(1)} s per second of speech for ${found.lines} lines in a row`;
}
