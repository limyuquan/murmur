/**
 * How long after the page plays a moment the person hears it, while Murmur captures the tab and
 * plays its audio back: lookahead cues are shown that much after their media time. It depends on
 * the codec, the decoder and the audio output (60–130 ms measured in Chrome, 128 ms with hls.js),
 * so a session starts at `DEFAULT_LAG_S` and measures it: a few seconds of the live capture (each
 * frame stamped with when it is heard) against lookahead's decoded audio of the same moments
 * (placed by the playhead reports), cross-correlated over 0 to `MAX_LAG_S`. A window counts when
 * the video played steadily through it at 1×, the audio wasn't quiet, and the two match well
 * (other sounds in the tab don't); the median of the first `WANTED` windows is kept.
 *
 * Costs about 20 ms per window (a 4 kHz coarse pass, then 16 kHz around its peak), a few times
 * per session.
 */
import { PCM_RATE, type PcmTimeline, toSample } from './pcm';
import type { Playhead } from './scheduler';

/** The lag before (or without) a measurement, seconds. */
export const DEFAULT_LAG_S = 0.12;
/** Lags measured are kept within `[0, MAX_LAG_S]`. */
export const MAX_LAG_S = 0.3;
/** Audio compared per window, seconds. */
const WINDOW_S = 4;
/** Windows measured before the lag is settled. */
const WANTED = 3;
/** A window whose best match is weaker than this is not used. */
const MIN_CORRELATION = 0.6;
/** Nor one this quiet (RMS of the live audio). */
const MIN_RMS = 0.01;
/** Windows tried at most per session. */
const MAX_TRIES = 40;
/** Between tries, ms. */
const TRY_EVERY_MS = 2000;
/** Coarse pass: every `DECIMATE` samples averaged. */
const DECIMATE = 4;

/** Where `live` best matches `reference`, and how well. */
export interface LagMatch {
  /** Offset into `reference`, samples. */
  offset: number;
  /** Normalized correlation at it (1: identical). */
  correlation: number;
}

/**
 * The offset `k` in `[0, maxOffset]` at which `reference[k..k+n)` best matches `live[0..n)`
 * (normalized cross-correlation), searched at a quarter of the rate, then exactly around the best.
 * `reference` must hold `live.length + maxOffset` samples.
 */
export function bestMatch(
  live: Float32Array,
  reference: Float32Array,
  maxOffset: number,
): LagMatch {
  const n = live.length;
  const coarse = scan(decimate(live), decimate(reference), Math.floor(maxOffset / DECIMATE), 0);
  const from = Math.max(0, coarse.offset * DECIMATE - DECIMATE * 2);
  const to = Math.min(maxOffset, coarse.offset * DECIMATE + DECIMATE * 2);
  const fine = scan(live, reference.subarray(from, to + n), to - from, 0);
  return { offset: from + fine.offset, correlation: fine.correlation };
}

function decimate(x: Float32Array): Float32Array {
  const out = new Float32Array(Math.floor(x.length / DECIMATE));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let k = 0; k < DECIMATE; k++) sum += x[i * DECIMATE + k] ?? 0;
    out[i] = sum / DECIMATE;
  }
  return out;
}

function scan(a: Float32Array, b: Float32Array, maxOffset: number, min: number): LagMatch {
  const n = a.length;
  let ea = 0;
  for (let i = 0; i < n; i++) ea += (a[i] ?? 0) ** 2;
  // Energy of b[k..k+n), kept as k moves.
  let eb = 0;
  for (let i = 0; i < n; i++) eb += (b[i] ?? 0) ** 2;
  let best: LagMatch = { offset: 0, correlation: -1 };
  for (let k = min; k <= maxOffset && k + n <= b.length; k++) {
    if (k > min) eb += (b[k + n - 1] ?? 0) ** 2 - (b[k - 1] ?? 0) ** 2;
    let dot = 0;
    for (let i = 0; i < n; i++) dot += (a[i] ?? 0) * (b[k + i] ?? 0);
    const norm = Math.sqrt(ea * Math.max(eb, 0));
    const c = norm > 0 ? dot / norm : 0;
    if (c > best.correlation) best = { offset: k, correlation: c };
  }
  return best;
}

interface Frame {
  samples: Float32Array;
  at: number;
}

interface Report extends Playhead {
  timeline: string;
}

export interface LagEstimate {
  /** The lag in use, seconds. */
  lagS: number;
  /** Measured (else the default). */
  measured: boolean;
  /** Each window's lag, seconds, and match. */
  windows: { lagS: number; correlation: number }[];
  tries: number;
}

export class LagCalibrator {
  private frames: Frame[] = [];
  private reports: Report[] = [];
  private readonly windows: { lagS: number; correlation: number }[] = [];
  private tries = 0;
  private triedAt = Number.NEGATIVE_INFINITY;
  private lag = DEFAULT_LAG_S;

  /** The lag to use now, seconds. */
  get lagS(): number {
    return this.lag;
  }

  get done(): boolean {
    return this.windows.length >= WANTED || this.tries >= MAX_TRIES;
  }

  get estimate(): LagEstimate {
    return {
      lagS: this.lag,
      measured: this.windows.length > 0,
      windows: [...this.windows],
      tries: this.tries,
    };
  }

  /** A live frame (16 kHz), heard at `epochMs`. */
  onLiveFrame(samples: Float32Array, epochMs: number): void {
    if (this.done) return;
    this.frames.push({ samples, at: epochMs });
    // Keep a little more than a window.
    const keep = epochMs - (WINDOW_S + 2) * 1000;
    while ((this.frames[0]?.at ?? keep) < keep) this.frames.shift();
  }

  /** Where the video was (each playhead report on the timeline lookahead follows). */
  onPlayhead(timeline: string, playhead: Playhead): void {
    if (this.done) return;
    this.reports.push({ ...playhead, timeline });
    const keep = playhead.at - (WINDOW_S + 4) * 1000;
    while ((this.reports[0]?.at ?? keep) < keep) this.reports.shift();
  }

  /**
   * Measures one window when it's time to try, if the conditions hold. Returns the new lag when
   * it changed, else null.
   */
  attempt(now: number, pcmOf: (timeline: string) => PcmTimeline | undefined): number | null {
    if (this.done || now - this.triedAt < TRY_EVERY_MS) return null;
    const window = this.window();
    if (!window) return null;
    const pcm = pcmOf(window.timeline);
    const maxOffset = Math.round(MAX_LAG_S * PCM_RATE);
    const start = toSample(window.mediaStart - MAX_LAG_S);
    const end = start + window.live.length + maxOffset;
    const span = pcm?.spanFrom(start);
    if (!pcm || !span || span[0] > start || span[1] < end) return null;
    this.triedAt = now;
    this.tries++;
    if (rmsOf(window.live) < MIN_RMS) return null;
    const match = bestMatch(window.live, pcm.read(start, end), maxOffset);
    if (match.correlation < MIN_CORRELATION) return null;
    const lagS = clampLag(MAX_LAG_S - match.offset / PCM_RATE);
    this.windows.push({ lagS, correlation: Number(match.correlation.toFixed(3)) });
    const next = clampLag(median(this.windows.map((w) => w.lagS)));
    const changed = Math.abs(next - this.lag) >= 0.002;
    this.lag = next;
    if (this.done) {
      this.frames = [];
      this.reports = [];
    }
    return changed ? next : null;
  }

  /**
   * The last `WINDOW_S` of live audio, if it is contiguous and the video played steadily at 1×
   * on one timeline all through it (and a little before), with the media time of its start.
   */
  private window(): { live: Float32Array; mediaStart: number; timeline: string } | null {
    const frames = this.frames;
    const last = frames.at(-1);
    if (!last) return null;
    const endAt = last.at + (last.samples.length / PCM_RATE) * 1000;
    const startAt = endAt - WINDOW_S * 1000;
    const first = frames.findIndex((f) => f.at >= startAt);
    if (first <= 0) return null;
    const used = frames.slice(first);
    for (let i = 1; i < used.length; i++) {
      const prev = used[i - 1] as Frame;
      const expected = prev.at + (prev.samples.length / PCM_RATE) * 1000;
      if (Math.abs((used[i] as Frame).at - expected) > 5) return null;
    }
    // Reports from a second before the window to its end: one timeline, playing at 1×, no jumps.
    const reports = this.reports.filter((r) => r.at >= startAt - 1000 && r.at <= endAt);
    const anchor = [...this.reports].reverse().find((r) => r.at <= startAt - 500);
    if (!anchor) return null;
    for (const r of [anchor, ...reports]) {
      if (r.paused || r.rate !== 1 || r.timeline !== anchor.timeline) return null;
      if (Math.abs(anchor.time + (r.at - anchor.at) / 1000 - r.time) > 0.08) return null;
    }
    let total = 0;
    for (const f of used) total += f.samples.length;
    const live = new Float32Array(total);
    let at = 0;
    for (const f of used) {
      live.set(f.samples, at);
      at += f.samples.length;
    }
    const firstAt = (used[0] as Frame).at;
    // Placed by the report nearest the window's start.
    let near = anchor;
    for (const r of reports) if (Math.abs(r.at - firstAt) < Math.abs(near.at - firstAt)) near = r;
    return {
      live,
      mediaStart: near.time + (firstAt - near.at) / 1000,
      timeline: anchor.timeline,
    };
  }
}

function clampLag(lag: number): number {
  return Math.min(MAX_LAG_S, Math.max(0, Math.round(lag * 1000) / 1000));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function rmsOf(x: Float32Array): number {
  let sum = 0;
  for (const v of x) sum += v * v;
  return Math.sqrt(sum / Math.max(1, x.length));
}
