/**
 * Cues on the video's own timeline, for lookahead (src/lookahead/README.md): kept by media time
 * and shown by `video.currentTime`, so pausing, seeking, a playback rate and a player that jumps
 * all just work, and seeking back shows what was already made at once.
 *
 * - Lookahead cues arrive with their media time, usually long before they play. A cue shows from
 *   its start to the end of its speech, and for its reading time at least (the same rules as live
 *   lines: `CaptionStore`, here run on media time in ms).
 * - Live cues (heard through the tab capture) are placed on the timeline too (`MediaClock`, from
 *   the playhead at the time they were heard). One that mostly covers the same speech as a cue
 *   already kept is a duplicate and isn't shown; a lookahead cue replaces the live ones it covers.
 * - `covered()` says where lookahead has finished subtitles: there only lookahead cues show.
 *
 * Pure: the controller passes the media time in.
 */
import { SpanSet } from '@/lookahead/spans';
import type { Span } from '@/lookahead/types';
import type { Cue, CueMediaTime } from '@/pipeline/types';
import { type CaptionBlock, CaptionStore, type ViewOptions } from './captions';

/** Cues kept, at most (those far from the playhead go first). */
export const MAX_MEDIA_CUES = 3000;
/** A playhead move bigger than this (or backwards) is a seek, not playing. */
export const JUMP_S = 1.5;
/** A live cue this much covered by kept cues is a duplicate. */
export const DUPLICATE_SHARE = 0.5;
/** Cues that started this long before a seek's target are considered for showing there. */
const LOOKBACK_S = 30;
/** Shown at least this long after its speech ends, ms. */
const TAIL_MS = 300;

type MediaCue = Cue & { media: CueMediaTime };

export class MediaCues {
  private readonly cues = new Map<string, MediaCue>();
  private readonly byKey = new Map<string, MediaCue[] | null>();
  private readonly coverage = new Map<string, SpanSet>();
  private readonly store = new CaptionStore();
  private readonly applied = new Set<string>();
  private lastKey: string | null = null;
  private lastT: number | null = null;

  get size(): number {
    return this.cues.size;
  }

  /** A lookahead cue (new or changed). Live cues it covers go. */
  add(cue: Cue): void {
    if (!cue.media) return;
    const media = cue.media;
    for (const other of this.list(media.timeline)) {
      if (other.origin === 'lookahead' || other.id === cue.id) continue;
      if (share(other.media, media) > DUPLICATE_SHARE) this.remove(other.id);
    }
    this.put(cue as MediaCue, true);
  }

  /**
   * A live cue placed at `media`: false when it's a duplicate of what's kept (don't show it),
   * else true (kept, and shown live).
   */
  addLive(cue: Cue, media: CueMediaTime): boolean {
    for (const other of this.list(media.timeline)) {
      if (other.id === cue.id) continue;
      if (share(media, other.media) > DUPLICATE_SHARE) return false;
    }
    // Shown live now; kept for when this stretch plays again.
    this.put({ ...cue, origin: 'live', media }, false);
    return true;
  }

  /** Where lookahead has finished subtitles on `key`. */
  setCoverage(key: string, spans: readonly Span[]): void {
    const set = new SpanSet(0.05);
    for (const [s, e] of spans) set.add(s, e);
    this.coverage.set(key, set);
  }

  covered(key: string, t: number): boolean {
    return this.coverage.get(key)?.at(t) != null;
  }

  /** Lookahead cues of `key` starting in `[start, end)` are void. */
  drop(key: string, start: number, end: number): void {
    for (const cue of this.list(key)) {
      if (cue.origin === 'lookahead' && cue.media.start >= start && cue.media.start < end) {
        this.remove(cue.id);
      }
    }
    this.coverage.get(key)?.subtract(start, end);
  }

  /**
   * Moves the playhead to `t` on `key`: playing on, cues whose start was passed come on screen
   * at their start; after a seek, the screen is rebuilt from the cues around `t`.
   */
  advance(key: string, t: number): void {
    const last = this.lastT;
    const jumped = this.lastKey !== key || last === null || t < last - 0.05 || t - last > JUMP_S;
    if (jumped) {
      this.store.reset();
      this.applied.clear();
      for (const cue of this.list(key)) {
        if (cue.media.start > t) break;
        if (cue.media.start >= t - LOOKBACK_S) this.show(cue, cue.media.start);
      }
    } else {
      for (const cue of this.list(key)) {
        if (cue.media.start > t) break;
        if (cue.media.start > last && !this.applied.has(cue.id)) this.show(cue, cue.media.start);
      }
    }
    this.lastKey = key;
    this.lastT = t;
  }

  /**
   * Blocks to draw at media time `t` (after `advance`). Where lookahead has finished subtitles,
   * only its cues show (kept live lines fill in elsewhere, as after a seek back).
   */
  visible(t: number, view?: ViewOptions): CaptionBlock[] {
    const blocks = this.store.visible(t * 1000, view);
    const key = this.lastKey;
    if (key === null || !this.covered(key, t)) return blocks;
    return blocks.filter((b) => this.cues.get(b.id)?.origin === 'lookahead');
  }

  /** The next media time after `t` at which what's shown may change, or null. */
  nextEvent(key: string, t: number): number | null {
    let next = Number.POSITIVE_INFINITY;
    for (const cue of this.list(key)) {
      if (cue.media.start > t) {
        next = cue.media.start;
        break;
      }
    }
    const change = this.store.nextChange(t * 1000);
    if (change !== null) next = Math.min(next, change / 1000);
    const spans = this.coverage.get(key);
    const span = spans?.from(t);
    if (span) next = Math.min(next, span[0] > t ? span[0] : span[1]);
    return Number.isFinite(next) ? next : null;
  }

  reset(): void {
    this.cues.clear();
    this.byKey.clear();
    this.coverage.clear();
    this.store.reset();
    this.applied.clear();
    this.lastKey = null;
    this.lastT = null;
  }

  private put(cue: MediaCue, showNow: boolean): void {
    const before = this.cues.get(cue.id);
    this.cues.set(cue.id, cue);
    this.byKey.set(cue.media.timeline, null);
    if (before && before.media.timeline !== cue.media.timeline) {
      this.byKey.set(before.media.timeline, null);
    }
    // Already on screen, or due now: show the change (at once, if it is arriving late).
    const t = this.lastT;
    if (this.lastKey === cue.media.timeline && t !== null) {
      const due = showNow && cue.media.start <= t && t < cue.media.end + 5;
      if (this.applied.has(cue.id) || due) this.show(cue, Math.max(cue.media.start, t));
    }
    if (this.cues.size > MAX_MEDIA_CUES) this.trim();
  }

  private remove(id: string): void {
    const cue = this.cues.get(id);
    if (!cue) return;
    this.cues.delete(id);
    this.byKey.set(cue.media.timeline, null);
    if (this.applied.delete(id)) {
      // Rebuild what's on screen without it.
      const t = this.lastT;
      this.lastT = null;
      if (this.lastKey !== null && t !== null) this.advance(this.lastKey, t);
    }
  }

  private show(cue: MediaCue, at: number): void {
    const end = cue.media.end * 1000 + TAIL_MS;
    // Ordered by when they're spoken, not by when they were made.
    this.store.apply({ ...cue, seq: cue.media.start }, at * 1000, end);
    this.applied.add(cue.id);
  }

  /** Cues of `key`, by start. */
  private list(key: string): MediaCue[] {
    let list = this.byKey.get(key);
    if (!list) {
      list = [...this.cues.values()]
        .filter((c) => c.media.timeline === key)
        .sort((a, b) => a.media.start - b.media.start);
      this.byKey.set(key, list);
    }
    return list;
  }

  /** Drops the cues farthest from the playhead (other videos first). */
  private trim(): void {
    const key = this.lastKey;
    const t = this.lastT ?? 0;
    const distance = (c: MediaCue) =>
      c.media.timeline !== key ? Number.POSITIVE_INFINITY : Math.abs(c.media.start - t);
    const order = [...this.cues.values()].sort((a, b) => distance(b) - distance(a));
    for (const cue of order) {
      if (this.cues.size <= MAX_MEDIA_CUES * 0.9) break;
      this.cues.delete(cue.id);
      this.applied.delete(cue.id);
      this.byKey.set(cue.media.timeline, null);
    }
  }
}

/** How much of `a`'s span `b` covers (0–1). */
export function share(
  a: { start: number; end: number },
  b: { start: number; end: number },
): number {
  const length = a.end - a.start;
  if (length <= 0) return a.start >= b.start && a.start <= b.end ? 1 : 0;
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)) / length;
}

/**
 * The playhead over time (epoch ms → media time), to place live cues, which are timed by when
 * they were heard, on the video's timeline.
 */
export class MediaClock {
  private readonly samples: {
    at: number;
    t: number;
    rate: number;
    paused: boolean;
    key: string;
  }[] = [];

  record(at: number, t: number, rate: number, paused: boolean, key: string): void {
    const last = this.samples.at(-1);
    if (
      last &&
      last.key === key &&
      last.paused === paused &&
      last.rate === rate &&
      at - last.at < 1000 &&
      Math.abs(last.t + (paused ? 0 : ((at - last.at) / 1000) * rate) - t) < 0.05
    ) {
      return;
    }
    this.samples.push({ at, t, rate, paused, key });
    if (this.samples.length > 600) this.samples.splice(0, 100);
  }

  /** Media time on `key` at epoch ms `at`, or null when the record doesn't reach back there. */
  toMedia(at: number, key: string): number | null {
    for (let i = this.samples.length - 1; i >= 0; i--) {
      const s = this.samples[i];
      if (!s || s.at > at) continue;
      if (s.key !== key) return null;
      if (s.paused) return s.t;
      if (at - s.at > 5000) return null;
      return s.t + ((at - s.at) / 1000) * s.rate;
    }
    return null;
  }
}
