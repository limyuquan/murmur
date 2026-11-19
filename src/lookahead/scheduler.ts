/**
 * What lookahead works on next, and when the live path steps aside. Pure.
 *
 * - Work is decoded audio not yet processed, on the timeline that is playing: the stretch at the
 *   playhead (or the nearest after it) first, never behind the playhead, and nothing more than
 *   `HORIZON_S` ahead of it (it is queued again as the playhead comes closer). This bounds what is
 *   wasted when the person leaves.
 * - The live path (tab capture) keeps capturing but stops recognizing while lookahead has the
 *   next `PAUSE_LIVE_S` already done, and starts again when that drops under `RESUME_LIVE_S`
 *   (after a seek, on a slow graphics card, at 2× speed), so the two never compete for the
 *   graphics card while lookahead is ahead.
 */
import type { SpanSet } from './spans';
import type { Span } from './types';

export const HORIZON_S = 90;
export const PAUSE_LIVE_S = 3;
export const RESUME_LIVE_S = 1.5;
/** Unprocessed stretches shorter than this aren't worth a job (rounding at span edges). */
const MIN_WORK_S = 0.3;

export interface Playhead {
  /** `currentTime` when reported. */
  time: number;
  rate: number;
  paused: boolean;
  /** Epoch ms of the report. */
  at: number;
}

/** Where the playhead is at `now` (epoch ms), extrapolated while playing. */
export function playheadAt(p: Playhead, now: number): number {
  if (p.paused) return p.time;
  return p.time + (Math.max(0, now - p.at) / 1000) * p.rate;
}

/**
 * The next stretch to process: decoded, not processed, from the playhead (or the first such
 * stretch after it) up to the end of what is decoded there, cut at the horizon. Null: nothing to
 * do now.
 */
export function nextWork(
  playhead: number,
  decoded: readonly Span[],
  processed: SpanSet,
  horizon = HORIZON_S,
): Span | null {
  const limit = playhead + horizon;
  for (const [ds, de] of decoded) {
    if (de <= playhead) continue;
    let from = Math.max(ds, playhead);
    // Step over what's done, and over gaps too short to be worth a job.
    for (let guard = 0; guard < 10_000 && from < de && from < limit; guard++) {
      const done = processed.at(from, 0.05);
      if (done && done[1] > from) {
        from = done[1];
        continue;
      }
      const next = processed.from(from);
      const to = Math.min(de, limit, next ? Math.max(next[0], from) : Number.POSITIVE_INFINITY);
      if (to - from >= MIN_WORK_S) return [from, to];
      if (!next) break;
      from = Math.max(next[1], from + 0.01);
    }
  }
  return null;
}

/** How far ahead of the playhead lookahead has finished subtitles without a break, seconds. */
export function leadOf(playhead: number, processed: SpanSet): number {
  const span = processed.at(playhead, 0.25);
  return span ? Math.max(0, span[1] - playhead) : 0;
}

/** The live path's switch, with hysteresis. */
export class LiveGate {
  private pausedNow = false;

  get paused(): boolean {
    return this.pausedNow;
  }

  /** Updates with the current lead; returns whether live recognition is paused. */
  update(lead: number): boolean {
    if (!this.pausedNow && lead >= PAUSE_LIVE_S) this.pausedNow = true;
    else if (this.pausedNow && lead < RESUME_LIVE_S) this.pausedNow = false;
    return this.pausedNow;
  }

  reset(): void {
    this.pausedNow = false;
  }
}
