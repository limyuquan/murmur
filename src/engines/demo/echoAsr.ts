/**
 * Demo ASR: no model. While a segment is open it emits a partial every quarter second of audio,
 * and a final when the segment ends, with placeholder text that says when the speech was and how
 * loud it was. Enough to run capture → pipeline → overlay end to end before real models land.
 */
import type { AsrEngine, AsrSession, AsrSessionOptions, EngineState } from '../types';
import { ECHO_ASR_INFO } from './info';

/** Audio between partial results, in samples at the session rate. */
const PARTIAL_EVERY_S = 0.25;

export class EchoAsrEngine implements AsrEngine {
  readonly info = ECHO_ASR_INFO;
  state: EngineState = 'unloaded';

  async load(): Promise<void> {
    this.state = 'ready';
  }

  async unload(): Promise<void> {
    this.state = 'unloaded';
  }

  createSession(options: AsrSessionOptions): AsrSession {
    return new EchoSession(options);
  }
}

interface OpenSegment {
  id: string;
  ordinal: number;
  startSample: number;
  samples: number;
  sumSquares: number;
  sinceLastPartial: number;
}

class EchoSession implements AsrSession {
  private open: OpenSegment | null = null;
  private count = 0;

  constructor(private readonly options: AsrSessionOptions) {}

  startSegment(segmentId: string, startSample: number): void {
    this.count++;
    this.open = {
      id: segmentId,
      ordinal: this.count,
      startSample,
      samples: 0,
      sumSquares: 0,
      sinceLastPartial: 0,
    };
  }

  pushAudio(segmentId: string, samples: Float32Array): void {
    const seg = this.open;
    if (!seg || seg.id !== segmentId) return;
    for (const s of samples) seg.sumSquares += s * s;
    seg.samples += samples.length;
    seg.sinceLastPartial += samples.length;
    if (seg.sinceLastPartial >= PARTIAL_EVERY_S * this.options.sampleRate) {
      seg.sinceLastPartial = 0;
      this.emit(seg, seg.startSample + seg.samples, false);
    }
  }

  endSegment(segmentId: string, endSample: number): void {
    const seg = this.open;
    if (!seg || seg.id !== segmentId) return;
    this.open = null;
    this.emit(seg, endSample, true);
  }

  async close(): Promise<void> {
    this.open = null;
  }

  private emit(seg: OpenSegment, endSample: number, final: boolean): void {
    const rate = this.options.sampleRate;
    const rms = Math.sqrt(seg.sumSquares / Math.max(1, seg.samples));
    const db = rms > 0 ? Math.round(20 * Math.log10(rms)) : -Infinity;
    const span = `${clock(seg.startSample / rate)}–${clock(endSample / rate)}`;
    const text = final
      ? `Sound ${seg.ordinal} · ${span} · ${db} dB`
      : `Sound ${seg.ordinal} · ${span} …`;
    const hint = this.options.languageHint;
    this.options.onResult({
      segmentId: seg.id,
      final,
      text,
      language: hint ? { tag: hint, confidence: 0 } : null,
      startSample: seg.startSample,
      endSample,
    });
  }
}

/** `m:ss.s` from seconds. */
function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = (seconds - m * 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}
