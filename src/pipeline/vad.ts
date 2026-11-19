/**
 * Voice-activity detection hook. The segmenter asks a detector for a speech probability per fixed
 * frame. `EnergyVad` is the dependency-free default (a loudness gate: it also fires on music); a
 * model-based detector (e.g. Silero via ONNX in a worker) can implement the same interface.
 */

export interface VoiceActivityDetector {
  /** Samples per frame this detector wants (at the pipeline rate). */
  readonly frameSamples: number;
  /** Speech probability, 0–1, for one frame of exactly `frameSamples` samples. */
  process(frame: Float32Array): number;
  reset(): void;
}

export interface EnergyVadOptions {
  frameSamples?: number;
  /** Level (dBFS RMS) at which a frame counts as half speech. Default −45. */
  thresholdDb?: number;
  /** Width of the soft ramp around the threshold, dB. Default 12. */
  rampDb?: number;
}

export class EnergyVad implements VoiceActivityDetector {
  readonly frameSamples: number;
  private readonly thresholdDb: number;
  private readonly rampDb: number;

  constructor(options: EnergyVadOptions = {}) {
    this.frameSamples = options.frameSamples ?? 320;
    this.thresholdDb = options.thresholdDb ?? -45;
    this.rampDb = options.rampDb ?? 12;
  }

  process(frame: Float32Array): number {
    const db = rmsDb(frame);
    const p = (db - (this.thresholdDb - this.rampDb / 2)) / this.rampDb;
    return Math.min(1, Math.max(0, p));
  }

  reset(): void {}
}

/** RMS level in dBFS; −Infinity for silence. */
export function rmsDb(samples: Float32Array): number {
  if (samples.length === 0) return -Infinity;
  let sum = 0;
  for (const s of samples) sum += s * s;
  const rms = Math.sqrt(sum / samples.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}
