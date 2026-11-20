/**
 * What a running session is doing, for the popup and the overlay's chip: pure, fed by the host
 * with captured frames and the cues it sends. See `SessionActivity` (messaging/protocol.ts).
 */
import { type AsrHealth, UNKNOWN_LANGUAGE } from '@/engines/types';
import type { SessionActivity } from '@/messaging/protocol';
import { primaryLanguage } from '@/pipeline/language';
import type { Cue } from '@/pipeline/types';

export interface ActivityOptions {
  /** Whether the engines handle `language` (primary subtag). Defaults to all. */
  supports?: (language: string) => boolean;
  /** Typical delay above which subtitles count as falling behind, ms. */
  behindMs?: number;
  /** Finished lines waiting for translation at once that count as falling behind. */
  maxBacklog?: number;
  /** Speech engine real-time factor above which it counts as falling behind. */
  maxRtf?: number;
  /** RMS level that counts as sound. */
  soundLevel?: number;
}

const RECENT = 10;
const DELAYS = 3;
/** Lines the session's typical delay is taken over, and the share of them at or under it. */
const TYPICAL_DELAYS = 30;
const TYPICAL_QUANTILE = 0.3;

/**
 * When the overlay's chip says subtitles are late: only when the delay is clearly abnormal, and
 * for a while, so a slow line or two never flashes it. The popup shows the delay as it is.
 */
export const LATE = {
  /** Late on any session: the delay above this for `absoluteForMs`. */
  absoluteMs: 4000,
  absoluteForMs: 3000,
  /** Late for this session: above this many times its typical delay for `relativeForMs`… */
  relativeFactor: 2,
  relativeForMs: 5000,
  /** …and above this at least (twice a short delay is still short). */
  relativeMinMs: 2500,
  /** Shown until the delay is back under `max(hideBelowMs, hideFactor × typical)` for `hideForMs`. */
  hideBelowMs: 3000,
  hideFactor: 1.5,
  hideForMs: 2000,
} as const;

interface Seen {
  seq: number;
  sourceFinal: boolean;
  waiting: boolean;
  done: boolean;
  language: string;
}

export class ActivityTracker {
  private readonly cues = new Map<string, Seen>();
  private readonly delays: number[] = [];
  /** More delays, for what is typical in this session. */
  private readonly typicalDelays: number[] = [];
  /** Since when the delay has been abnormal (chip hidden) or back to normal (chip shown). */
  private lateSince: number | null = null;
  private late = false;
  private lastSound: number | null = null;
  private health: AsrHealth | null = null;
  /** Languages an engine said it can't handle at all (primary tags). */
  private readonly refused = new Set<string>();
  private readonly behindMs: number;
  private readonly maxBacklog: number;
  private readonly maxRtf: number;
  private readonly soundLevel: number;

  constructor(
    private readonly startedAt: number,
    private readonly options: ActivityOptions = {},
  ) {
    this.behindMs = options.behindMs ?? 6000;
    this.maxBacklog = options.maxBacklog ?? 3;
    this.maxRtf = options.maxRtf ?? 1;
    this.soundLevel = options.soundLevel ?? 0.003;
  }

  onFrame(samples: Float32Array, now: number): void {
    let sum = 0;
    for (const s of samples) sum += s * s;
    if (Math.sqrt(sum / Math.max(1, samples.length)) >= this.soundLevel) this.lastSound = now;
  }

  /** The speech engine's own report: its backlog, speed, and whether it is skipping work. */
  onHealth(health: AsrHealth): void {
    this.health = health;
  }

  /** An engine can't handle `language` at all (not a missing download). */
  onUnsupported(language: string): void {
    const p = primaryLanguage(language);
    if (p && p !== UNKNOWN_LANGUAGE) this.refused.add(p);
  }

  onCue(cue: Cue, now: number): void {
    const prev = this.cues.get(cue.id);
    const hasText = cue.source.text.trim() !== '';
    const waiting = cue.source.final && hasText && cue.untranslated === 'pending';
    const done =
      cue.source.final &&
      (cue.untranslated === 'same-language' ||
        cue.untranslated === 'failed' ||
        (cue.untranslated === null && (cue.translation?.final ?? true)) ||
        !hasText);
    if (done && !prev?.done && hasText) {
      const delay = Math.max(0, now - cue.endEpochMs);
      this.delays.push(delay);
      if (this.delays.length > DELAYS) this.delays.shift();
      this.typicalDelays.push(delay);
      if (this.typicalDelays.length > TYPICAL_DELAYS) this.typicalDelays.shift();
    }
    this.cues.delete(cue.id);
    this.cues.set(cue.id, {
      seq: cue.seq,
      sourceFinal: cue.source.final,
      waiting,
      done,
      language: cue.source.final && hasText ? cue.source.language : UNKNOWN_LANGUAGE,
    });
    while (this.cues.size > RECENT) {
      this.cues.delete(this.cues.keys().next().value as string);
    }
  }

  snapshot(now: number): SessionActivity {
    const cues = [...this.cues.values()].sort((a, b) => a.seq - b.seq);
    const latest = cues.at(-1);
    const backlog = cues.filter((c) => c.waiting).length;
    const stage =
      latest && !latest.sourceFinal ? 'transcribing' : backlog > 0 ? 'translating' : 'listening';

    const counts = new Map<string, number>();
    for (const c of cues) {
      const p = primaryLanguage(c.language);
      if (p && p !== UNKNOWN_LANGUAGE) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    const languages = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
    const supports = this.options.supports;
    const unsupported = languages.filter(
      (l) => this.refused.has(l) || (supports ? !supports(l) : false),
    );

    const delayMs = this.delays.length > 0 ? median(this.delays) : null;
    const rtf = this.health?.rtf ?? null;
    const behind =
      (delayMs !== null && delayMs > this.behindMs) ||
      backlog >= this.maxBacklog ||
      (rtf !== null && rtf > this.maxRtf) ||
      (this.health?.behind ?? false);

    return {
      stage,
      languages,
      unsupported,
      delayMs,
      behind,
      lateMs: this.lateness(delayMs, now),
      rtf,
      backlogMs: this.health?.backlogMs ?? 0,
      queue: backlog,
      silentMs: Math.max(0, now - (this.lastSound ?? this.startedAt)),
      soundEver: this.lastSound !== null,
    };
  }

  /**
   * How late subtitles are, for the chip, when clearly abnormal (`LATE`), else null. The delay is
   * that of the last finished lines, or the speech still waiting for recognition when more (a
   * stalled engine finishes no lines).
   */
  private lateness(delayMs: number | null, now: number): number | null {
    const backlog = this.health?.backlogMs ?? 0;
    const delay = delayMs === null ? (backlog > 0 ? backlog : null) : Math.max(delayMs, backlog);
    if (delay === null) {
      this.late = false;
      this.lateSince = null;
      return null;
    }
    // A low quantile: a late stretch doesn't make lateness look typical until it lasts.
    const typical =
      this.typicalDelays.length >= DELAYS ? quantile(this.typicalDelays, TYPICAL_QUANTILE) : null;
    if (!this.late) {
      const absolute = delay > LATE.absoluteMs;
      const relative =
        typical !== null && delay > LATE.relativeMinMs && delay > LATE.relativeFactor * typical;
      if (!absolute && !relative) {
        this.lateSince = null;
        return null;
      }
      this.lateSince ??= now;
      const forMs = absolute ? LATE.absoluteForMs : LATE.relativeForMs;
      if (now - this.lateSince < forMs) return null;
      this.late = true;
      this.lateSince = null;
      return delay;
    }
    const hideBelow = Math.max(LATE.hideBelowMs, LATE.hideFactor * (typical ?? 0));
    if (delay >= hideBelow) {
      this.lateSince = null;
      return delay;
    }
    this.lateSince ??= now;
    if (now - this.lateSince < LATE.hideForMs) return delay;
    this.late = false;
    this.lateSince = null;
    return null;
  }
}

/** Two snapshots differ in a way worth reporting (the delay counts in half-second steps). */
export function activityChanged(a: SessionActivity | undefined, b: SessionActivity): boolean {
  if (!a) return true;
  const coarse = (x: SessionActivity) =>
    JSON.stringify({
      ...x,
      delayMs: x.delayMs === null ? null : Math.round(x.delayMs / 500),
      lateMs: x.lateMs === null ? null : Math.round(x.lateMs / 1000),
      rtf: x.rtf === null ? null : Math.round(x.rtf * 10),
      backlogMs: Math.round(x.backlogMs / 1000),
      // Silence matters to the popup in steps: none, a few seconds, long.
      silentMs: x.silentMs < 3000 ? 0 : x.silentMs < 8000 ? 1 : 2,
    });
  return coarse(a) !== coarse(b);
}

function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
