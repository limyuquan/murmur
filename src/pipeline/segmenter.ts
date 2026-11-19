/**
 * Cuts the continuous 16 kHz stream into speech segments for the ASR engine, from a
 * `VoiceActivityDetector`'s per-frame speech probability. Pure: no timers, driven only by the
 * samples pushed in and the transcripts handed back.
 *
 *   silence ──(speech for minSpeechMs)──▶ speech ──(pause)──▶ silence
 *                                           ├──(sentence end at a short pause)──▶ silence
 *                                           └──(maxSegmentMs)──▶ cut + carry on in a new segment
 *
 * Two strategies share the machinery; every parameter is in `SegmenterConfig`:
 *
 * - `sentence` (default; `SENTENCE_SEGMENTER`): built for continuous chatter, where waiting for a
 *   real pause made subtitles seconds late. A segment ends at a 250 ms pause once it is 1 s long
 *   (shorter ones wait for a 1 s pause, so a lone word isn't cut off), or already at a 150 ms
 *   pause when the words so far end a sentence. For that it asks the ASR session for a decode up
 *   to the pause (a `probe` event) and is told the text (`transcript()`); sentence.ts decides. A
 *   segment that reaches 6 s is cut in its last second rather than on the spot, at the frame
 *   least likely to be speech (a gap between words), then the quietest; the audio after the cut
 *   carries over into the next segment. Nothing is lost and none is heard twice, so no text needs
 *   merging at the cut. A segment with under 250 ms of speech is dropped (a cough, a blip): its
 *   events are held back until it has that much. Speech/silence uses hysteresis: a frame below
 *   `negThreshold` starts a pause, one at or above `threshold` ends it.
 * - `pause` (`PAUSE_SEGMENTER`): the original rule, a 500 ms pause or a hard cut at the maximum.
 *   Engines that listen to the track themselves (Chrome speech) use it: cutting their recognizer
 *   mid-sentence costs words, and they can't decode on request.
 *
 * The benchmark measured these rules with a speech detector (Silero VAD), and the pipeline uses
 * the same one (silero.ts, fed through `pushScored()` by vadstage.ts). With the energy gate
 * (vad.ts), speech over music or noise rarely shows a pause, so on such audio most segments end at
 * the 6 s cut: the model is what lets the pause and sentence rules act. The energy gate stays for
 * when the model can't load, and for engines that listen to the track.
 *
 * Shorter segments also keep most segments to one language, which matters for engines that pick
 * one language per segment. A cut where the language changes (a language-ID model on a sliding
 * window) was tried in the benchmark on top of this and didn't help, so there is none.
 *
 * A segment opens `preRollMs` before the first speech frame (so the first syllable isn't
 * clipped). Its audio is streamed as it arrives (including the trailing silence, which some models
 * want as context); its `endSample` is where the pause began plus `tailPadMs`, or the cut.
 */
import { msToSamples } from '@/capture/clock';
import { PIPELINE_SAMPLE_RATE } from '@/capture/types';
import { isSentenceEnd, type SentenceRule } from './sentence';
import type { VoiceActivityDetector } from './vad';

export type SegmentStrategy = 'sentence' | 'pause';

export interface SegmenterConfig {
  /** Which preset the unset fields come from (see the file comment). */
  strategy: SegmentStrategy;
  sampleRate: number;
  /** Probability at or above which a frame is speech. */
  threshold: number;
  /** Probability below which a frame starts a pause (hysteresis; = `threshold` for none). */
  negThreshold: number;
  /** Speech in a row needed to open a segment, ms. */
  minSpeechMs: number;
  /** Speech a segment must span to be kept at all, ms (shorter ones are dropped). 0: all kept. */
  minSpeechSpanMs: number;
  /** Audio kept from before the speech started, ms. */
  preRollMs: number;
  /** Audio kept after the speech ended, ms (part of the segment's span). */
  tailPadMs: number;
  /** Pause that ends a segment, ms... */
  hangoverMs: number;
  /** ...once the segment is at least this long, ms; */
  minSegmentMs: number;
  /** ...a shorter one ends only at a pause this long, ms. */
  longHangoverMs: number;
  /** Longest segment before a forced cut, ms. */
  maxSegmentMs: number;
  /**
   * The forced cut goes at the least speech-like, then quietest, frame in the last this-many ms
   * (0: a hard cut).
   */
  cutSearchMs: number;
  /** ...but never in a segment's first this-many ms. */
  cutMinHeadMs: number;
  /** Pause after which to ask whether the words so far end a sentence, ms. 0: never. */
  sentenceHangMs: number;
  /** Only for segments at least this long, ms. */
  sentenceMinSegmentMs: number;
  /** Which evidence of a sentence end counts (sentence.ts). */
  sentenceRule: SentenceRule;
}

/**
 * The default: `sent150_h250_max6` from the segmentation benchmark (real chatter, code-switching
 * and long-form speech with Qwen3-ASR): final subtitles p50 1.1 s / p90 4.3 s after the speech
 * on chatter (3.9 / 9.9 s with the pause strategy), nothing lost, the same accuracy.
 */
export const SENTENCE_SEGMENTER: Readonly<SegmenterConfig> = {
  strategy: 'sentence',
  sampleRate: PIPELINE_SAMPLE_RATE,
  threshold: 0.5,
  negThreshold: 0.35,
  minSpeechMs: 120,
  minSpeechSpanMs: 250,
  preRollMs: 100,
  tailPadMs: 100,
  hangoverMs: 250,
  minSegmentMs: 1000,
  longHangoverMs: 1000,
  maxSegmentMs: 6000,
  cutSearchMs: 1000,
  cutMinHeadMs: 1000,
  sentenceHangMs: 150,
  sentenceMinSegmentMs: 1000,
  sentenceRule: 'punct',
};

/** The original pause-only strategy. */
export const PAUSE_SEGMENTER: Readonly<SegmenterConfig> = {
  strategy: 'pause',
  sampleRate: PIPELINE_SAMPLE_RATE,
  threshold: 0.5,
  negThreshold: 0.5,
  minSpeechMs: 120,
  minSpeechSpanMs: 0,
  preRollMs: 200,
  tailPadMs: 0,
  hangoverMs: 500,
  minSegmentMs: 0,
  longHangoverMs: 500,
  maxSegmentMs: 8000,
  cutSearchMs: 0,
  cutMinHeadMs: 0,
  sentenceHangMs: 0,
  sentenceMinSegmentMs: 0,
  sentenceRule: 'punct',
};

export type SegmenterOptions = Partial<SegmenterConfig>;

/** The full config: the strategy's preset with `options` over it. */
export function segmenterConfig(options: SegmenterOptions = {}): SegmenterConfig {
  const base = options.strategy === 'pause' ? PAUSE_SEGMENTER : SENTENCE_SEGMENTER;
  const config = { ...base };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) (config as Record<string, unknown>)[key] = value;
  }
  return config;
}

/** A forced cut picks the quietest frame among those this close to the least speech-like. */
const CUT_PROB_SLACK = 0.05;

export type SegmentEndReason = 'silence' | 'sentence' | 'max-length' | 'flush';

export type SegmentEvent =
  | { type: 'start'; segmentId: string; startSample: number }
  | { type: 'audio'; segmentId: string; samples: Float32Array; startSample: number }
  | { type: 'end'; segmentId: string; endSample: number; reason: SegmentEndReason }
  /**
   * The segmenter would like the segment's text decoded up to `endSample` (a short pause began
   * there): hand it back with `transcript()`. Sessions that can't may ignore it.
   */
  | { type: 'probe'; segmentId: string; endSample: number };

interface Frame {
  samples: Float32Array;
  startSample: number;
  /** Speech probability from the VAD. */
  prob: number;
  /** Level, dBFS (for placing cuts). */
  db: number;
}

interface Open {
  id: string;
  startSample: number;
  /** Where the speech began (after the pre-roll). */
  speechStart: number;
  /** End of the last frame at or above the threshold. */
  lastSpeechEnd: number;
  /** Start of the pause under way (first frame below the negative threshold), or null. */
  silenceStart: number | null;
  /** The segment's frames so far: cuts and sentence ends can fall in the past. */
  frames: Frame[];
  /** Its `start` was sent (it has enough speech to keep). */
  confirmed: boolean;
  /** The pause (its `silenceStart`) already probed. */
  probedPause: number | null;
  /** Probe ends asked for and not answered yet. */
  probes: Set<number>;
}

export class Segmenter {
  readonly config: Readonly<SegmenterConfig>;
  private readonly vad: VoiceActivityDetector;
  private readonly idPrefix: string;
  private readonly s: {
    minSpeech: number;
    minSpeechSpan: number;
    preRoll: number;
    tailPad: number;
    hangover: number;
    minSegment: number;
    longHangover: number;
    maxSegment: number;
    cutSearch: number;
    cutMinHead: number;
    sentenceHang: number;
    sentenceMinSegment: number;
  };

  /** Rechunking buffer: input → frames of exactly vad.frameSamples. */
  private pending: Float32Array;
  private pendingLen = 0;
  /** Absolute index of the next sample to arrive. */
  private position = 0;
  private pendingStart = 0;
  /** End of the last frame processed. */
  private heard = 0;

  /** Recent non-segment frames, for pre-roll and for the candidate speech run. */
  private history: Frame[] = [];
  /** Speech samples seen in a row while closed. */
  private candidate = 0;

  private open: Open | null = null;
  private count = 0;

  constructor(vad: VoiceActivityDetector, options: SegmenterOptions = {}, idPrefix = 's') {
    this.config = segmenterConfig(options);
    const c = this.config;
    const n = (ms: number) => msToSamples(ms, c.sampleRate);
    this.s = {
      minSpeech: n(c.minSpeechMs),
      minSpeechSpan: n(c.minSpeechSpanMs),
      preRoll: n(c.preRollMs),
      tailPad: n(c.tailPadMs),
      hangover: n(c.hangoverMs),
      minSegment: n(c.minSegmentMs),
      longHangover: n(c.longHangoverMs),
      maxSegment: n(c.maxSegmentMs),
      cutSearch: n(c.cutSearchMs),
      cutMinHead: n(c.cutMinHeadMs),
      sentenceHang: n(c.sentenceHangMs),
      sentenceMinSegment: n(c.sentenceMinSegmentMs),
    };
    this.vad = vad;
    this.idPrefix = idPrefix;
    this.pending = new Float32Array(vad.frameSamples);
  }

  /** True while a segment is open (including one too short yet to have started). */
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
        const frame = this.pending.slice();
        this.frame(
          {
            samples: frame,
            startSample: this.pendingStart,
            prob: this.vad.process(frame),
            db: levelDb(frame),
          },
          events,
        );
      }
    }
    this.position += samples.length;
    return events;
  }

  /**
   * Feeds one frame already scored by a detector outside the segmenter (a model that answers
   * asynchronously: `VadStage`). `samples` is exactly `vad.frameSamples` long and follows the
   * previous samples (a gap or overlap flushes and restarts there). Don't mix with `push()`.
   */
  pushScored(samples: Float32Array, startSample: number, prob: number): SegmentEvent[] {
    if (samples.length !== this.vad.frameSamples) {
      throw new RangeError(`A scored frame has ${this.vad.frameSamples} samples.`);
    }
    const events: SegmentEvent[] = [];
    if (startSample !== this.position) {
      events.push(...this.flush());
      this.history = [];
      this.pendingLen = 0;
    }
    this.position = startSample + samples.length;
    this.frame({ samples, startSample, prob, db: levelDb(samples) }, events);
    return events;
  }

  /**
   * The ASR's text for segment `segmentId` decoded up to `endSample`. When that answers one of
   * this segment's probes and the text ends a sentence, the segment ends there (any speech since
   * starts the next one). Returns the events that produced.
   */
  transcript(
    segmentId: string,
    endSample: number,
    text: string,
    language: string | null = null,
  ): SegmentEvent[] {
    const open = this.open;
    if (!open || open.id !== segmentId || !open.probes.delete(endSample)) return [];
    if (!isSentenceEnd(text, { rule: this.config.sentenceRule, language })) return [];
    const events: SegmentEvent[] = [];
    const after = framesFrom(open.frames, endSample);
    this.close('sentence', endSample, events);
    // Hear what came after the sentence again, as if the segment had ended right then.
    this.history = [];
    this.candidate = 0;
    for (const f of after) this.frame(f, events);
    return events;
  }

  /** Closes the open segment, if any (end of capture, seek, pause). */
  flush(): SegmentEvent[] {
    const events: SegmentEvent[] = [];
    if (this.open) this.close('flush', this.speechEnd(this.open), events);
    this.candidate = 0;
    this.vad.reset();
    return events;
  }

  private frame(frame: Frame, events: SegmentEvent[]): void {
    this.heard = frame.startSample + frame.samples.length;
    if (this.open) this.openFrame(this.open, frame, events);
    else this.closedFrame(frame, events);
  }

  private openFrame(open: Open, frame: Frame, events: SegmentEvent[]): void {
    const c = this.config;
    const s = this.s;
    const frameEnd = frame.startSample + frame.samples.length;
    open.frames.push(frame);
    if (open.confirmed) {
      events.push({
        type: 'audio',
        segmentId: open.id,
        samples: frame.samples,
        startSample: frame.startSample,
      });
    }
    const speech = frame.prob >= c.threshold;
    if (speech) {
      open.silenceStart = null;
      open.lastSpeechEnd = frameEnd;
    } else if (frame.prob < c.negThreshold && open.silenceStart === null) {
      open.silenceStart = frame.startSample;
    }
    if (!open.confirmed && open.lastSpeechEnd - open.speechStart >= s.minSpeechSpan) {
      this.confirm(open, events);
    }

    const length = frameEnd - open.startSample;
    if (open.silenceStart !== null) {
      const pause = frameEnd - open.silenceStart;
      if (pause >= s.hangover && (length >= s.minSegment || pause >= s.longHangover)) {
        const end = this.speechEnd(open);
        this.close('silence', end, events);
        // The pause after the words may serve as the next segment's pre-roll.
        this.history = framesFrom(open.frames, end);
        return;
      }
      if (
        s.sentenceHang > 0 &&
        pause >= s.sentenceHang &&
        length >= s.sentenceMinSegment &&
        open.confirmed &&
        open.probedPause !== open.silenceStart
      ) {
        open.probedPause = open.silenceStart;
        const endSample = this.speechEnd(open);
        open.probes.add(endSample);
        events.push({ type: 'probe', segmentId: open.id, endSample });
      }
    }
    if (length >= s.maxSegment) this.cut(open, frame, speech, events);
  }

  /** Forced cut of a segment at its maximum length; carries on in a new one if still talking. */
  private cut(open: Open, frame: Frame, speech: boolean, events: SegmentEvent[]): void {
    const cutAt = this.cutPoint(open, frame);
    const after = framesFrom(open.frames, cutAt);
    this.close('max-length', cutAt, events);
    if (speech || after.some((f) => f.prob >= this.config.threshold)) {
      // Still talking: the next segment starts at the cut, with no pre-roll (no audio is lost),
      // and hears the audio after the cut again.
      this.start(cutAt, cutAt, cutAt, [], events);
      for (const f of after) this.frame(f, events);
    } else {
      this.history = after;
    }
  }

  /**
   * Where a forced cut goes: between words if the search window has a gap. Each frame's speech
   * probability and level are smoothed over it and its neighbours (one odd frame inside a
   * syllable doesn't count). The cut goes at the frame least likely to be speech; among frames
   * within `CUT_PROB_SLACK` of that, the quietest. When every frame is speech (no gap between
   * words to find), the probability says nothing and the quietest frame wins. Ties go to the
   * earliest frame. With no window, the cut is right here.
   */
  private cutPoint(open: Open, frame: Frame): number {
    const frameEnd = frame.startSample + frame.samples.length;
    const s = this.s;
    if (s.cutSearch <= 0) return frameEnd;
    const from = Math.max(frameEnd - s.cutSearch, open.startSample + s.cutMinHead);
    const frames = open.frames;
    const window: { start: number; prob: number; db: number }[] = [];
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i] as Frame;
      if (f.startSample < from) break;
      const near = [frames[i - 1], f, frames[i + 1]].filter((x): x is Frame => x !== undefined);
      window.push({
        start: f.startSample,
        prob: near.reduce((sum, x) => sum + x.prob, 0) / near.length,
        db: near.reduce((sum, x) => sum + x.db, 0) / near.length,
      });
    }
    if (window.length === 0) return frameEnd;
    const least = Math.min(...window.map((w) => w.prob));
    const ceiling = least < this.config.threshold ? least + CUT_PROB_SLACK : Infinity;
    let best = -1;
    let bestDb = Infinity;
    // `window` runs backwards: `<=` leaves the earliest of equals.
    for (const w of window) {
      if (w.prob <= ceiling && w.db <= bestDb) {
        bestDb = w.db;
        best = w.start;
      }
    }
    return best > open.startSample ? best : frameEnd;
  }

  private closedFrame(frame: Frame, events: SegmentEvent[]): void {
    const s = this.s;
    const frameEnd = frame.startSample + frame.samples.length;
    this.history.push(frame);
    this.candidate =
      frame.prob >= this.config.threshold ? this.candidate + frame.samples.length : 0;
    if (this.candidate >= s.minSpeech) {
      const speechStart = frameEnd - this.candidate;
      const from = Math.max(0, speechStart - s.preRoll);
      const kept = this.history.filter((f) => f.startSample + f.samples.length > from);
      const first = kept[0]?.startSample ?? speechStart;
      this.start(Math.max(from, first), speechStart, frameEnd, kept, events);
      this.history = [];
      this.candidate = 0;
      return;
    }
    // Keep only what pre-roll + a candidate run can need.
    const keep = s.preRoll + s.minSpeech + frame.samples.length;
    while (this.history.length > 0) {
      const head = this.history[0];
      if (!head || frameEnd - (head.startSample + head.samples.length) < keep) break;
      this.history.shift();
    }
  }

  private start(
    startSample: number,
    speechStart: number,
    lastSpeechEnd: number,
    backlog: Frame[],
    events: SegmentEvent[],
  ): Open {
    this.count++;
    const open: Open = {
      id: `${this.idPrefix}${this.count}`,
      startSample,
      speechStart,
      lastSpeechEnd,
      silenceStart: null,
      // Trim the first backlog frame to the segment start.
      frames: framesFrom(backlog, startSample),
      confirmed: false,
      probedPause: null,
      probes: new Set(),
    };
    this.open = open;
    if (lastSpeechEnd - speechStart >= this.s.minSpeechSpan) this.confirm(open, events);
    return open;
  }

  /** The segment has enough speech to keep: send its start and the audio so far. */
  private confirm(open: Open, events: SegmentEvent[]): void {
    open.confirmed = true;
    events.push({ type: 'start', segmentId: open.id, startSample: open.startSample });
    for (const f of open.frames) {
      events.push({
        type: 'audio',
        segmentId: open.id,
        samples: f.samples,
        startSample: f.startSample,
      });
    }
  }

  /** Where the open segment's words end: the pause's start (or now), plus the tail pad. */
  private speechEnd(open: Open): number {
    const end = open.silenceStart ?? this.heard;
    return Math.max(open.startSample, Math.min(end + this.s.tailPad, this.heard));
  }

  /** Ends the open segment at `endSample`; one too short to keep is dropped without a trace. */
  private close(reason: SegmentEndReason, endSample: number, events: SegmentEvent[]): void {
    const open = this.open;
    if (!open) return;
    this.open = null;
    if (open.confirmed) events.push({ type: 'end', segmentId: open.id, endSample, reason });
  }
}

/** The frames at or after `sample`, the first one trimmed to start there. */
function framesFrom(frames: readonly Frame[], sample: number): Frame[] {
  const out: Frame[] = [];
  for (const f of frames) {
    const end = f.startSample + f.samples.length;
    if (end <= sample) continue;
    const skip = Math.max(0, sample - f.startSample);
    out.push(
      skip > 0 ? { ...f, samples: f.samples.subarray(skip), startSample: f.startSample + skip } : f,
    );
  }
  return out;
}

/** Mean-square level in dB (−100 for digital silence). */
function levelDb(samples: Float32Array): number {
  let sum = 0;
  for (const x of samples) sum += x * x;
  return 10 * Math.log10(sum / Math.max(1, samples.length) + 1e-10);
}
