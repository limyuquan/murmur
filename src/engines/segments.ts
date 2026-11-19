/**
 * A speech-recognition session for engines that decode whole segments (Whisper, Qwen3-ASR): it
 * buffers each speech segment, re-decodes the growing segment for partial results and decodes it
 * once more when it ends for the final (whisper/scheduler.ts decides when, so finals never wait
 * behind partials), and passes every decode through the hallucination guards
 * (whisper/filters.ts). Every result carries the language detected for that segment.
 */
import type { AsrHealth, AsrResult, AsrSession, AsrSessionOptions } from './types';
import { filterDecode, peakDb } from './whisper/filters';
import { type DecodeJob, DecodeScheduler, type SchedulerOptions } from './whisper/scheduler';

/** One decode of a stretch of a segment. */
export interface SegmentDecode {
  text: string;
  /** Language tag of the segment (`und` when none). */
  language: string;
  languageProb: number;
  /** The model's own probability that there is no speech. */
  noSpeechProb: number;
  /** Mean log-probability of the decoded tokens. */
  avgLogprob: number;
  /** Decode time. */
  ms: number;
}

/** What decodes a session's segments. */
export interface SegmentDecoder {
  /** Decodes `samples` (16 kHz mono, the job's span of its segment). */
  decode(job: DecodeJob, samples: Float32Array): Promise<SegmentDecode>;
  /** The segment is done (its final sent, or given up on): drop anything kept for it. */
  forget?(segmentId: string): void;
}

interface Buffered {
  startSample: number;
  chunks: { start: number; samples: Float32Array }[];
  endSample: number | null;
  /** The final result was sent: later partials are stale. */
  finished: boolean;
}

export class SegmentSession implements AsrSession {
  private readonly scheduler: DecodeScheduler;
  private readonly segments = new Map<string, Buffered>();
  private closed = false;
  private idle: (() => void) | null = null;
  private reported: AsrHealth | null = null;
  /** Decode ms per audio ms of the last few finals. */
  private readonly factors: number[] = [];

  constructor(
    private readonly decoder: SegmentDecoder,
    private readonly options: AsrSessionOptions,
    schedulerOptions: SchedulerOptions,
  ) {
    this.scheduler = new DecodeScheduler({ sampleRate: options.sampleRate, ...schedulerOptions });
  }

  startSegment(segmentId: string, startSample: number): void {
    if (this.closed) return;
    this.segments.set(segmentId, { startSample, chunks: [], endSample: null, finished: false });
    this.scheduler.startSegment(segmentId, startSample);
    this.pump();
  }

  pushAudio(segmentId: string, samples: Float32Array, startSample: number): void {
    const seg = this.segments.get(segmentId);
    if (!seg || this.closed) return;
    seg.chunks.push({ start: startSample, samples });
    this.scheduler.audio(segmentId, startSample + samples.length);
    this.pump();
  }

  endSegment(segmentId: string, endSample: number): void {
    const seg = this.segments.get(segmentId);
    if (!seg) return;
    seg.endSample = endSample;
    for (const id of this.scheduler.endSegment(segmentId, endSample)) this.giveUp(id);
    this.pump();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (!this.scheduler.busy && this.scheduler.backlogSamples() === 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      this.idle = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private pump(): void {
    const job = this.scheduler.next();
    this.report();
    if (!job) {
      if (!this.scheduler.busy && this.scheduler.backlogSamples() === 0) this.idle?.();
      return;
    }
    const seg = this.segments.get(job.segmentId);
    if (!seg) {
      this.scheduler.done();
      this.pump();
      return;
    }
    const samples = slice(seg, job.startSample, job.endSample);
    const peak = peakDb(samples, this.options.sampleRate);
    this.decoder
      .decode(job, samples)
      .then((out) => {
        if (seg.finished) return;
        const filtered = filterDecode({
          text: out.text,
          language: out.language,
          noSpeechProb: out.noSpeechProb,
          avgLogprob: out.avgLogprob,
          peakDb: peak,
        });
        const final = job.kind === 'final';
        if (final) this.measure(out.ms, job.endSample - job.startSample);
        if (!final && filtered.dropped) return;
        const result: AsrResult = {
          segmentId: job.segmentId,
          final,
          text: filtered.text,
          language: filtered.text ? { tag: out.language, confidence: out.languageProb } : null,
          startSample: job.startSample,
          endSample: job.endSample,
        };
        if (final) this.finish(job.segmentId);
        this.options.onResult(result);
      })
      .catch((err: unknown) => {
        if (job.kind === 'final' && !seg.finished) {
          this.finish(job.segmentId);
          this.options.onResult(emptyFinal(job.segmentId, job.startSample, job.endSample));
        }
        this.options.onError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        this.scheduler.done();
        this.pump();
      });
  }

  /** A segment dropped to keep up: its one final, empty. */
  private giveUp(id: string): void {
    const seg = this.segments.get(id);
    if (!seg || seg.finished) return;
    this.finish(id);
    this.options.onResult(emptyFinal(id, seg.startSample, seg.endSample ?? seg.startSample));
  }

  private finish(id: string): void {
    const seg = this.segments.get(id);
    if (seg) seg.finished = true;
    this.segments.delete(id);
    this.decoder.forget?.(id);
  }

  /** Records one final decode's real-time factor (short lines are dominated by fixed costs). */
  private measure(decodeMs: number, samples: number): void {
    const audioMs = (samples / this.options.sampleRate) * 1000;
    if (audioMs < 1000) return;
    this.factors.push(decodeMs / audioMs);
    if (this.factors.length > RTF_WINDOW) this.factors.shift();
  }

  private rtf(): number | null {
    if (this.factors.length === 0) return null;
    const sorted = [...this.factors].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? null;
  }

  private report(): void {
    const health = { ...this.scheduler.health(), rtf: this.rtf() };
    const last = this.reported;
    if (
      last &&
      last.behind === health.behind &&
      last.droppedSegments === health.droppedSegments &&
      Math.abs(last.backlogMs - health.backlogMs) < 1000 &&
      Math.abs((last.rtf ?? 0) - (health.rtf ?? 0)) < 0.1
    ) {
      return;
    }
    this.reported = health;
    this.options.onHealth?.(health);
  }
}

/** Finals the real-time factor is the median of. */
const RTF_WINDOW = 5;

function emptyFinal(segmentId: string, startSample: number, endSample: number): AsrResult {
  return { segmentId, final: true, text: '', language: null, startSample, endSample };
}

/** The segment's audio in [from, to), as one array. */
function slice(seg: Buffered, from: number, to: number): Float32Array {
  const out = new Float32Array(Math.max(0, to - from));
  for (const c of seg.chunks) {
    const s = Math.max(from, c.start);
    const e = Math.min(to, c.start + c.samples.length);
    if (e > s) out.set(c.samples.subarray(s - c.start, e - c.start), s - from);
  }
  return out;
}
