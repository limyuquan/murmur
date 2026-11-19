/**
 * Decides what the (single, serial) Whisper worker decodes next, so subtitles keep up with speech.
 *
 * - While a segment is open, its growing audio is re-decoded about every `partialIntervalMs` of
 *   new audio for a partial result (shown dimmed). The first partial waits for `firstPartialMs`.
 * - When a segment ends, one final decode of all of it is queued. Finals run before any partial,
 *   oldest first, and a segment's queued partial is dropped once its final is queued.
 * - When the worker is busy, partials aren't queued up: the next partial simply waits for the
 *   worker and covers all audio so far. Every cadence tick that passed meanwhile counts as a
 *   dropped partial.
 * - Backlog = audio waiting to be decoded (queued finals + the open segment's undecoded tail).
 *   Over `behindMs` the session reports it is falling behind; over `maxBacklogMs` the oldest
 *   queued finals are given up on (the engine sends them as empty finals) so the newest speech
 *   still gets subtitles soon.
 *
 * Pure: times are passed in, no timers. The engine calls `next()` whenever the worker is idle and
 * after every event.
 */
import type { AsrHealth } from '../types';

export interface SchedulerOptions {
  sampleRate?: number;
  partialIntervalMs?: number;
  firstPartialMs?: number;
  behindMs?: number;
  maxBacklogMs?: number;
}

export interface DecodeJob {
  kind: 'partial' | 'final';
  segmentId: string;
  startSample: number;
  /** End of the audio to decode (the segment's end for a final). */
  endSample: number;
}

interface Segment {
  id: string;
  startSample: number;
  /** End of the audio received so far. */
  received: number;
  /** End of the audio covered by the last partial decode (or start). */
  partialAt: number;
  /** Set once the segment ended. */
  endSample: number | null;
}

export class DecodeScheduler {
  private readonly rate: number;
  private readonly interval: number;
  private readonly first: number;
  private readonly behindSamples: number;
  private readonly maxBacklog: number;

  private open: Segment | null = null;
  private readonly finals: Segment[] = [];
  private running: DecodeJob | null = null;
  private droppedPartials = 0;
  private droppedSegments = 0;

  constructor(options: SchedulerOptions = {}) {
    this.rate = options.sampleRate ?? 16_000;
    this.interval = this.samples(options.partialIntervalMs ?? 1000);
    this.first = this.samples(options.firstPartialMs ?? 1000);
    this.behindSamples = this.samples(options.behindMs ?? 4000);
    this.maxBacklog = this.samples(options.maxBacklogMs ?? 20_000);
  }

  get busy(): boolean {
    return this.running !== null;
  }

  startSegment(id: string, startSample: number): void {
    if (this.open) this.endSegment(this.open.id, this.open.received);
    this.open = { id, startSample, received: startSample, partialAt: startSample, endSample: null };
  }

  /** Audio for the open segment now reaches `endSample`. */
  audio(id: string, endSample: number): void {
    if (this.open?.id === id) this.open.received = Math.max(this.open.received, endSample);
  }

  /**
   * Ends the open segment and queues its final. Returns segments given up on to keep the
   * backlog bounded: send each as an empty final.
   */
  endSegment(id: string, endSample: number): string[] {
    const seg = this.open;
    if (!seg || seg.id !== id) return [];
    this.open = null;
    seg.endSample = Math.max(seg.startSample, endSample);
    // A partial that would have been due for the unfinished tail is replaced by the final.
    if (seg.received - seg.partialAt >= this.interval && seg.partialAt > seg.startSample) {
      this.droppedPartials++;
    }
    this.finals.push(seg);
    return this.trim();
  }

  /** The job to run now, or null (worker busy, or nothing due). Marks it running. */
  next(): DecodeJob | null {
    if (this.running) return null;
    const final = this.finals.shift();
    if (final) {
      this.running = {
        kind: 'final',
        segmentId: final.id,
        startSample: final.startSample,
        endSample: final.endSample ?? final.received,
      };
      return this.running;
    }
    const seg = this.open;
    if (!seg) return null;
    const heard = seg.received - seg.startSample;
    const fresh = seg.received - seg.partialAt;
    const due = seg.partialAt === seg.startSample ? heard >= this.first : fresh >= this.interval;
    if (!due) return null;
    // Cadence ticks that passed while the worker was busy.
    if (seg.partialAt > seg.startSample) {
      this.droppedPartials += Math.max(0, Math.floor(fresh / this.interval) - 1);
    }
    seg.partialAt = seg.received;
    this.running = {
      kind: 'partial',
      segmentId: seg.id,
      startSample: seg.startSample,
      endSample: seg.received,
    };
    return this.running;
  }

  /** The running job finished (or failed). */
  done(): void {
    this.running = null;
  }

  /** Audio heard but not decoded yet, in samples. */
  backlogSamples(): number {
    let n = 0;
    for (const f of this.finals) n += (f.endSample ?? f.received) - f.startSample;
    if (this.running?.kind === 'final') n += this.running.endSample - this.running.startSample;
    if (this.open) n += this.open.received - this.open.partialAt;
    return n;
  }

  health(): AsrHealth {
    const backlog = this.backlogSamples();
    return {
      behind: backlog > this.behindSamples || this.finals.length >= 2,
      backlogMs: Math.round((backlog / this.rate) * 1000),
      droppedPartials: this.droppedPartials,
      droppedSegments: this.droppedSegments,
    };
  }

  /** Drops the oldest queued finals while the backlog is over the cap (the newest is kept). */
  private trim(): string[] {
    const dropped: string[] = [];
    while (this.finals.length > 1 && this.backlogSamples() > this.maxBacklog) {
      const seg = this.finals.shift();
      if (!seg) break;
      dropped.push(seg.id);
      this.droppedSegments++;
    }
    return dropped;
  }

  private samples(ms: number): number {
    return Math.round((ms / 1000) * this.rate);
  }
}
