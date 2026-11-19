/**
 * Cuts the continuous 16 kHz stream into speech segments for the ASR engine, from a
 * `VoiceActivityDetector`'s per-frame speech probability.
 *
 *   silence ──(speech for minSpeechMs)──▶ speech ──(silence for hangoverMs)──▶ silence
 *                                           └──(maxSegmentMs)──▶ end + start a new segment
 *
 * A segment opens `preRollMs` before the first speech frame (so the first syllable isn't
 * clipped), its audio is streamed as it arrives (including the trailing silence, which some models
 * want as context), and its `endSample` is the end of the last speech frame: the honest end of the
 * words, for subtitle timing. Pure: no timers, driven only by the samples pushed in.
 */
import { msToSamples } from '@/capture/clock';
import { PIPELINE_SAMPLE_RATE } from '@/capture/types';
import type { VoiceActivityDetector } from './vad';

export interface SegmenterOptions {
  sampleRate?: number;
  /** Probability at or above which a frame is speech. Default 0.5. */
  threshold?: number;
  /** Speech needed to open a segment, ms. Default 120. */
  minSpeechMs?: number;
  /** Silence that closes a segment, ms. Default 500. */
  hangoverMs?: number;
  /** Longest segment before a forced cut, ms. Default 8000. */
  maxSegmentMs?: number;
  /** Audio kept from before the speech started, ms. Default 200. */
  preRollMs?: number;
}

export type SegmentEndReason = 'silence' | 'max-length' | 'flush';

export type SegmentEvent =
  | { type: 'start'; segmentId: string; startSample: number }
  | { type: 'audio'; segmentId: string; samples: Float32Array; startSample: number }
  | { type: 'end'; segmentId: string; endSample: number; reason: SegmentEndReason };

interface Frame {
  samples: Float32Array;
  startSample: number;
}

export class Segmenter {
  private readonly vad: VoiceActivityDetector;
  private readonly threshold: number;
  private readonly minSpeech: number;
  private readonly hangover: number;
  private readonly maxSegment: number;
  private readonly preRoll: number;
  private readonly idPrefix: string;

  /** Rechunking buffer: input → frames of exactly vad.frameSamples. */
  private pending: Float32Array;
  private pendingLen = 0;
  /** Absolute index of the next sample to arrive. */
  private position = 0;
  private pendingStart = 0;

  /** Recent non-segment frames, for pre-roll and for the candidate speech run. */
  private history: Frame[] = [];
  /** Speech frames seen in a row while closed. */
  private candidate = 0;

  private open: { id: string; startSample: number; lastSpeechEnd: number } | null = null;
  private silence = 0;
  private count = 0;

  constructor(vad: VoiceActivityDetector, options: SegmenterOptions = {}, idPrefix = 's') {
    const rate = options.sampleRate ?? PIPELINE_SAMPLE_RATE;
    this.vad = vad;
    this.threshold = options.threshold ?? 0.5;
    this.minSpeech = msToSamples(options.minSpeechMs ?? 120, rate);
    this.hangover = msToSamples(options.hangoverMs ?? 500, rate);
    this.maxSegment = msToSamples(options.maxSegmentMs ?? 8000, rate);
    this.preRoll = msToSamples(options.preRollMs ?? 200, rate);
    this.idPrefix = idPrefix;
    this.pending = new Float32Array(vad.frameSamples);
  }

  /** True while a segment is open. */
  get inSegment(): boolean {
    return this.open !== null;
  }

  /**
   * Feeds samples that follow the previous ones (`startSample` is checked: a gap or overlap
   * flushes and restarts there). Returns the events they produced, in order.
   */
  push(samples: Float32Array, startSample: number = this.position): SegmentEvent[] {
    const events: SegmentEvent[] = [];
    if (startSample !== this.position) {
      events.push(...this.flush());
      this.history = [];
      this.pendingLen = 0;
      this.position = startSample;
    }
    let offset = 0;
    const size = this.vad.frameSamples;
    while (offset < samples.length) {
      if (this.pendingLen === 0) this.pendingStart = this.position + offset;
      const n = Math.min(size - this.pendingLen, samples.length - offset);
      this.pending.set(samples.subarray(offset, offset + n), this.pendingLen);
      this.pendingLen += n;
      offset += n;
      if (this.pendingLen === size) {
        this.pendingLen = 0;
        this.frame({ samples: this.pending.slice(), startSample: this.pendingStart }, events);
      }
    }
    this.position += samples.length;
    return events;
  }

  /** Closes the open segment, if any (end of capture, seek, pause). */
  flush(): SegmentEvent[] {
    const events: SegmentEvent[] = [];
    if (this.open) this.close('flush', this.open.lastSpeechEnd, events);
    this.candidate = 0;
    this.vad.reset();
    return events;
  }

  private frame(frame: Frame, events: SegmentEvent[]): void {
    const speech = this.vad.process(frame.samples) >= this.threshold;
    const frameEnd = frame.startSample + frame.samples.length;

    if (this.open) {
      events.push({
        type: 'audio',
        segmentId: this.open.id,
        samples: frame.samples,
        startSample: frame.startSample,
      });
      if (speech) {
        this.silence = 0;
        this.open.lastSpeechEnd = frameEnd;
      } else {
        this.silence += frame.samples.length;
      }
      if (this.silence >= this.hangover) {
        this.close('silence', this.open.lastSpeechEnd, events);
      } else if (frameEnd - this.open.startSample >= this.maxSegment) {
        this.close('max-length', frameEnd, events);
        // Still talking: carry straight on in a new segment, no pre-roll (no audio is lost).
        if (speech) this.start(frameEnd, frameEnd, [], events);
      }
      return;
    }

    this.history.push(frame);
    this.candidate = speech ? this.candidate + frame.samples.length : 0;
    if (this.candidate >= this.minSpeech) {
      const speechStart = frameEnd - this.candidate;
      const from = Math.max(0, speechStart - this.preRoll);
      const kept = this.history.filter((f) => f.startSample + f.samples.length > from);
      const first = kept[0]?.startSample ?? speechStart;
      this.start(Math.max(from, first), frameEnd, kept, events);
      this.history = [];
      this.candidate = 0;
      return;
    }
    // Keep only what pre-roll + a candidate run can need.
    const keep = this.preRoll + this.minSpeech + frame.samples.length;
    while (this.history.length > 0) {
      const head = this.history[0];
      if (!head || frameEnd - (head.startSample + head.samples.length) < keep) break;
      this.history.shift();
    }
  }

  private start(
    startSample: number,
    lastSpeechEnd: number,
    backlog: Frame[],
    events: SegmentEvent[],
  ): void {
    this.count++;
    const id = `${this.idPrefix}${this.count}`;
    this.open = { id, startSample, lastSpeechEnd };
    this.silence = 0;
    events.push({ type: 'start', segmentId: id, startSample });
    for (const f of backlog) {
      // Trim the first backlog frame to the segment start.
      const skip = Math.max(0, startSample - f.startSample);
      events.push({
        type: 'audio',
        segmentId: id,
        samples: skip > 0 ? f.samples.subarray(skip) : f.samples,
        startSample: f.startSample + skip,
      });
    }
  }

  private close(reason: SegmentEndReason, endSample: number, events: SegmentEvent[]): void {
    const open = this.open;
    if (!open) return;
    events.push({ type: 'end', segmentId: open.id, endSample, reason });
    this.open = null;
    this.silence = 0;
  }
}
