/**
 * Maps audio time to wall-clock time. Everything that leaves the offscreen document is stamped in
 * epoch ms (`performance.timeOrigin + performance.now()` scale), the one clock the offscreen
 * document and the page's content script share to about a millisecond. The overlay (later) maps
 * those times onto `video.currentTime`.
 */
import { PIPELINE_SAMPLE_RATE } from './types';

/** `AudioContext.getOutputTimestamp()`: the context time being heard at `performanceTime`. */
export interface OutputTimestamp {
  contextTime: number;
  performanceTime: number;
}

/**
 * Epoch ms at which the sample at `contextTime` (seconds) is heard. The offscreen document plays
 * the tab back through the same context, so a captured sample is heard when the context outputs
 * it: `getOutputTimestamp()` tells us when that is, including output latency.
 */
export function contextTimeToEpochMs(
  contextTime: number,
  stamp: OutputTimestamp,
  timeOrigin: number,
): number {
  return timeOrigin + stamp.performanceTime + (contextTime - stamp.contextTime) * 1000;
}

/**
 * Sample index ↔ epoch ms for one session's 16 kHz stream. Anchored on frames as they arrive, so
 * slow drift between the audio clock and the system clock is corrected as it happens.
 */
export class SampleClock {
  private anchorSample = 0;
  private anchorEpochMs = Number.NaN;

  constructor(readonly sampleRate: number = PIPELINE_SAMPLE_RATE) {}

  /** Records that `sample` is heard at `epochMs`. */
  anchor(sample: number, epochMs: number): void {
    this.anchorSample = sample;
    this.anchorEpochMs = epochMs;
  }

  get anchored(): boolean {
    return !Number.isNaN(this.anchorEpochMs);
  }

  /** Epoch ms of `sample`, extrapolated from the latest anchor. NaN before the first anchor. */
  toEpochMs(sample: number): number {
    return this.anchorEpochMs + ((sample - this.anchorSample) / this.sampleRate) * 1000;
  }

  /** The sample heard at `epochMs` (fractional). NaN before the first anchor. */
  toSample(epochMs: number): number {
    return this.anchorSample + ((epochMs - this.anchorEpochMs) / 1000) * this.sampleRate;
  }
}

/** Duration of `samples` at the pipeline rate, in ms. */
export function samplesToMs(samples: number, sampleRate: number = PIPELINE_SAMPLE_RATE): number {
  return (samples / sampleRate) * 1000;
}

/** Samples in `ms` at the pipeline rate, rounded. */
export function msToSamples(ms: number, sampleRate: number = PIPELINE_SAMPLE_RATE): number {
  return Math.round((ms / 1000) * sampleRate);
}
