/**
 * Whether a session's models keep falling behind the speech, so that it should step down its
 * ladder (profiles.ts `LADDERS`) as it does when a model runs out of memory: the memory ladder
 * only hears of memory, and a pair that fits can still be too slow (Gemma 4 E4B on a MacBook Air
 * M2 fit, but missed the live budget on 15 of 63 lines and put subtitles ~5 s behind).
 *
 * Two signs, judged over recent lines rather than moments, so a hard passage or a pause doesn't
 * count:
 * - the translator took longer than its budget (`LINE_BUDGET_MS`, the backup then translated the
 *   line) on at least `maxSlowShare` of the last `lines` finished live lines;
 * - speech recognition's real-time factor (the median of its last few decodes, `AsrHealth.rtf`)
 *   stayed above `maxRtf` for the last `rtfLines` finished lines in a row.
 *
 * Pure: the offscreen host feeds it and decides what stepping down means (the next ladder step,
 * the translator's first: the ladder's steps shrink the translator before the speech model).
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
}

export type Slowness =
  | { engine: 'translator'; slow: number; lines: number }
  | { engine: 'asr'; rtf: number; lines: number };

export class SlownessWatch {
  private readonly lines: number;
  private readonly maxSlow: number;
  private readonly maxRtf: number;
  private readonly rtfLines: number;
  /** The last `lines` translated lines, true where too slow. */
  private readonly outcomes: boolean[] = [];
  /** Finished lines in a row with the factor above `maxRtf`, and the latest factor. */
  private overRtf = 0;
  private lastRtf = 0;
  private fired: Slowness | null = null;

  constructor(options: SlownessOptions = {}) {
    this.lines = options.lines ?? 30;
    this.maxSlow = Math.max(1, Math.ceil(this.lines * (options.maxSlowShare ?? 0.2)));
    this.maxRtf = options.maxRtf ?? 0.6;
    this.rtfLines = options.rtfLines ?? 15;
  }

  /** The translator finished a live line: within its budget, or too slow (`slow`). */
  onTranslated(slow: boolean): Slowness | null {
    if (this.fired) return null;
    this.outcomes.push(slow);
    if (this.outcomes.length > this.lines) this.outcomes.shift();
    const count = this.outcomes.filter(Boolean).length;
    if (count < this.maxSlow) return null;
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
