/**
 * Runs lookahead's speech pipeline over decoded audio, as fast as the engines allow, where the
 * scheduler says (scheduler.ts), and keeps track of what is done ("processed") per content.
 *
 * A job is one pipeline over one contiguous stretch of a timeline, fed from the playhead onwards
 * in one-second pieces, never more than `IN_FLIGHT_S` beyond what is finished. A stretch counts as
 * processed once every speech segment that starts in it has its finished cue (translation
 * included), and the segmenter has seen past it. When the playhead jumps out of the job's
 * stretch, or what it works on is removed, the job is dropped at once and a new one starts.
 *
 * Processed spans are kept per content key (a site's id for the video, else the timeline), so
 * coming back to the same video in a new MediaSource (after an ad) doesn't redo it.
 */
import { isDone } from '@/overlay/captions';
import type { Pipeline } from '@/pipeline/pipeline';
import type { SegmentEvent } from '@/pipeline/segmenter';
import type { Cue } from '@/pipeline/types';
import { PCM_RATE, type PcmTimeline, toSample } from './pcm';
import { LiveGate, leadOf, nextWork, type Playhead, playheadAt } from './scheduler';
import { SpanSet } from './spans';
import type { Span } from './types';

/** Audio pushed beyond what is finished, at most. */
export const IN_FLIGHT_S = 12;
/** Pushed per step. */
const CHUNK_S = 1;
/**
 * The segmenter opens a segment a little before the speech, and only once it has heard enough of
 * it: audio this close to what it has seen may still turn out to start a segment.
 */
const HOLD_BACK_S = 0.6;
/**
 * With no more audio decoded for this long, the open segment is ended (the end of the video, or
 * of what the player has buffered for now). Decoding outruns playback by far, so a pause this
 * long means no more is coming soon.
 */
const IDLE_FLUSH_MS = 1000;
/** A segment whose cue isn't finished this long after it started is given up on. */
const SEGMENT_TIMEOUT_MS = 30_000;

export interface RunnerTarget {
  /** The PCM timeline (MediaSource or source) playing. */
  timeline: string;
  /** Content key: cues and processed spans are kept under it. */
  key: string;
  /** An ad: never subtitled ahead. */
  ad: boolean;
  playhead: Playhead;
}

export interface PipelineHooks {
  onCue(cue: Cue): void;
  onSegment(event: Extract<SegmentEvent, { type: 'start' | 'end' }>): void;
  onError(error: Error): void;
  /** How long until the playhead reaches `start` (media seconds), ms; Infinity while paused. */
  untilShownMs(start: number): number;
}

export interface RunnerDeps {
  /** A pipeline for one job, or null when the engines aren't ready for lookahead. */
  createPipeline(
    media: { timeline: string; idPrefix: string },
    hooks: PipelineHooks,
  ): Pipeline | null;
  pcm(timeline: string): PcmTimeline | undefined;
  /** A lookahead cue (id prefixed, `media` set). */
  onCue(cue: Cue): void;
  /** Processed spans of a content key changed. */
  onCoverage(key: string, spans: readonly Span[]): void;
  /** Cues of `key` from `[start, end)` are no longer valid (their job was dropped unfinished). */
  onDrop(key: string, start: number, end: number): void;
  /** Whether live recognition should be paused (lead), when it changes. */
  onLivePaused(paused: boolean, lead: number): void;
  now(): number;
}

interface Job {
  n: number;
  prefix: string;
  key: string;
  timeline: string;
  pipeline: Pipeline;
  /** First sample of the job. */
  from: number;
  /** Next sample to push. */
  pushed: number;
  /** Segments started, by their pipeline id: start sample, and when (now()). */
  segments: Map<string, { start: number; at: number; done: boolean }>;
  /** Processed up to (sample). */
  done: number;
  /** The open segment was ended at this sample (the audio ran out). */
  flushedAt: number | null;
  /** When `pushed` last moved. */
  grewAt: number;
}

export class LookaheadRunner {
  private target: RunnerTarget | null = null;
  private job: Job | null = null;
  private jobs = 0;
  private readonly processed = new Map<string, SpanSet>();
  private readonly gate = new LiveGate();
  private running = false;
  private again = false;
  private stopped = false;
  private lead = 0;
  /** Why the last jobs were dropped (diagnostics). */
  readonly drops: string[] = [];

  constructor(private readonly deps: RunnerDeps) {}

  /** What is playing now (a new report from the overlay). */
  setTarget(target: RunnerTarget | null): void {
    this.target = target;
    this.kick();
  }

  /**
   * How long until the playhead reaches `start` (media seconds) on the video playing, ms:
   * Infinity while paused or with nothing playing, 0 once reached.
   */
  untilShownMs(start: number): number {
    const target = this.target;
    if (!target || target.playhead.paused || target.playhead.rate <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    const now = this.deps.now();
    const playhead = playheadAt(target.playhead, now);
    return Math.max(0, ((start - playhead) / target.playhead.rate) * 1000);
  }

  /** Lookahead's lead at the playhead, seconds (last computed). */
  get leadS(): number {
    return this.lead;
  }

  get livePaused(): boolean {
    return this.gate.paused;
  }

  /** Processed spans of `key`. */
  spans(key: string): readonly Span[] {
    return this.processed.get(key)?.list ?? [];
  }

  /** Something changed (new audio, a cue): look again. */
  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    void this.loop();
  }

  /**
   * `[start, end)` of `key` is gone from the player (removed ahead of the playhead): it must be
   * done again, and the job working there is dropped.
   */
  invalidate(key: string, start: number, end: number): void {
    const set = this.processed.get(key);
    if (set && set.overlap(start, end) > 0) {
      set.subtract(start, end);
      this.deps.onCoverage(key, set.list);
    }
    const job = this.job;
    if (job && job.key === key && start * PCM_RATE < job.pushed && end * PCM_RATE > job.from) {
      void this.dropJob('invalidated');
    }
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.dropJob('stopped');
  }

  private async loop(): Promise<void> {
    try {
      do {
        this.again = false;
        await this.step();
      } while (this.again && !this.stopped);
    } catch (err) {
      console.warn('[murmur] lookahead', err);
    } finally {
      this.running = false;
    }
  }

  private processedFor(key: string): SpanSet {
    let set = this.processed.get(key);
    if (!set) {
      set = new SpanSet(0.05);
      this.processed.set(key, set);
    }
    return set;
  }

  private async step(): Promise<void> {
    const target = this.target;
    const now = this.deps.now();
    if (!target || target.ad) {
      // Live takes over now, not once the job's decode under way has returned.
      this.setLead(0);
      await this.dropJob('no target or an ad');
      return;
    }
    const playhead = playheadAt(target.playhead, now);
    const processed = this.processedFor(target.key);
    const pcm = this.deps.pcm(target.timeline);
    const decoded = pcm?.coverage() ?? [];

    let job = this.job;
    if (job) this.progress(job, now);
    const work = nextWork(playhead, decoded, processed);
    this.setLead(leadOf(playhead, processed));
    if (
      job &&
      (job.key !== target.key ||
        job.timeline !== target.timeline ||
        !continues(job, work, playhead))
    ) {
      await this.dropJob('moved');
      job = null;
    }
    if (!work || !pcm) return;

    if (!job) {
      job = this.startJob(target, work[0]);
      if (!job) return;
    }
    const end = toSample(work[1]);
    const limit = job.done + IN_FLIGHT_S * PCM_RATE;
    while (job.pushed < end && job.pushed < limit && this.job === job) {
      const to = Math.min(end, job.pushed + CHUNK_S * PCM_RATE);
      const samples = pcm.read(job.pushed, to);
      // Samples are the timeline's own: epoch times don't apply.
      job.pipeline.push({ samples, startSample: job.pushed, startEpochMs: 0 });
      job.pushed = to;
      job.grewAt = now;
      job.flushedAt = null;
    }
    // The job reached what's done already (from before a seek): end the open segment there.
    // Or the audio ran out (for now): end it once it's clear no more is coming.
    const decodedEnd = pcm.spanFrom(job.pushed - 1)?.[1] ?? job.pushed;
    const atDone = job.pushed >= end && end < decodedEnd;
    const ranOut = job.pushed >= decodedEnd && now - job.grewAt > IDLE_FLUSH_MS;
    if (job.flushedAt === null && job.pushed > job.from && (atDone || ranOut)) {
      job.pipeline.flush();
      job.flushedAt = job.pushed;
    }
    this.progress(job, now);
  }

  private startJob(target: RunnerTarget, from: number): Job | null {
    const n = ++this.jobs;
    const prefix = `L${n}:`;
    let job: Job | null = null;
    const pipeline = this.deps.createPipeline(
      { timeline: target.key, idPrefix: prefix },
      {
        onCue: (cue) => {
          if (!job || this.job !== job) return;
          const seg = job.segments.get(cue.id.slice(prefix.length));
          if (seg && isDone(cue)) seg.done = true;
          this.deps.onCue(cue);
          this.kick();
        },
        onSegment: (event) => {
          if (!job || this.job !== job) return;
          if (event.type === 'start') {
            job.segments.set(event.segmentId, {
              start: event.startSample,
              at: this.deps.now(),
              done: false,
            });
          }
        },
        onError: (err) => console.warn('[murmur] lookahead pipeline', err),
        untilShownMs: (start) => this.untilShownMs(start),
      },
    );
    if (!pipeline) return null;
    const start = toSample(from);
    job = {
      n,
      prefix,
      key: target.key,
      timeline: target.timeline,
      pipeline,
      from: start,
      pushed: start,
      segments: new Map(),
      done: start,
      flushedAt: null,
      grewAt: this.deps.now(),
    };
    this.job = job;
    return job;
  }

  /** Moves the job's processed mark forward and records it. */
  private progress(job: Job, now: number): void {
    const scanned = job.pipeline.scannedSample;
    const settled = job.flushedAt !== null && scanned >= job.flushedAt;
    let done = settled ? job.pushed : Math.min(job.pushed, scanned - HOLD_BACK_S * PCM_RATE);
    for (const seg of job.segments.values()) {
      if (!seg.done && now - seg.at > SEGMENT_TIMEOUT_MS) seg.done = true;
      if (!seg.done) done = Math.min(done, seg.start);
    }
    if (done <= job.done) return;
    job.done = done;
    const set = this.processedFor(job.key);
    set.add(job.from / PCM_RATE, done / PCM_RATE);
    this.deps.onCoverage(job.key, set.list);
    // Finished segments can be forgotten.
    for (const [id, seg] of job.segments) if (seg.done && seg.start < done) job.segments.delete(id);
  }

  private async dropJob(reason: string): Promise<void> {
    const job = this.job;
    if (!job) return;
    this.job = null;
    this.drops.push(`${job.prefix} ${reason} at ${(job.pushed / PCM_RATE).toFixed(2)}`);
    if (this.drops.length > 20) this.drops.shift();
    // Cues of unfinished segments would be shown half-done: drop them.
    if (job.pushed > job.done) {
      this.deps.onDrop(job.key, job.done / PCM_RATE, job.pushed / PCM_RATE);
    }
    await job.pipeline.abort().catch(() => {});
  }

  private setLead(lead: number): void {
    this.lead = lead;
    const before = this.gate.paused;
    const paused = this.gate.update(lead);
    if (paused !== before) this.deps.onLivePaused(paused, lead);
  }
}

/**
 * The job can carry on: the work starts at its frontier, or (nothing to do now) the playhead is
 * still in its stretch.
 */
function continues(job: Job, work: Span | null, playhead: number): boolean {
  if (!work) {
    const at = toSample(playhead);
    return at >= job.from - PCM_RATE * 0.05 && at <= job.pushed + PCM_RATE;
  }
  const start = toSample(work[0]);
  return start >= job.from - PCM_RATE * 0.05 && start <= job.pushed + PCM_RATE * 0.05;
}
