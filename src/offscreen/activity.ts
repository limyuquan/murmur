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
      this.delays.push(Math.max(0, now - cue.endEpochMs));
      if (this.delays.length > DELAYS) this.delays.shift();
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
      rtf,
      backlogMs: this.health?.backlogMs ?? 0,
      queue: backlog,
      silentMs: Math.max(0, now - (this.lastSound ?? this.startedAt)),
      soundEver: this.lastSound !== null,
    };
  }
}

/** Two snapshots differ in a way worth reporting (the delay counts in half-second steps). */
export function activityChanged(a: SessionActivity | undefined, b: SessionActivity): boolean {
  if (!a) return true;
  const coarse = (x: SessionActivity) =>
    JSON.stringify({
      ...x,
      delayMs: x.delayMs === null ? null : Math.round(x.delayMs / 500),
      rtf: x.rtf === null ? null : Math.round(x.rtf * 10),
      backlogMs: Math.round(x.backlogMs / 1000),
      // Silence matters to the popup in steps: none, a few seconds, long.
      silentMs: x.silentMs < 3000 ? 0 : x.silentMs < 8000 ? 1 : 2,
    });
  return coarse(a) !== coarse(b);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
