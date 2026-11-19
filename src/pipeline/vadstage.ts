/**
 * Puts a model speech detector, which answers asynchronously, in front of the segmenter: cuts the
 * stream into the model's frames, scores each one, and hands the frames on with their
 * probabilities in order. If the model fails, that frame and every later one are scored by the
 * energy gate instead, so a session never stops hearing speech.
 */
import { LOG_PREFIX } from '@/shared/ids';
import { type AsyncVoiceActivityDetector, EnergyVad } from './vad';

export type ScoredFrameHandler = (samples: Float32Array, startSample: number, prob: number) => void;

export class VadStage {
  private readonly pending: Float32Array;
  private pendingLen = 0;
  private pendingStart = 0;
  /** Absolute index of the next sample to arrive. */
  private position = 0;
  private queue: Promise<void> = Promise.resolve();
  /** The energy gate, once the model failed. */
  private fallback: EnergyVad | null = null;

  constructor(
    private readonly vad: AsyncVoiceActivityDetector,
    private readonly onFrame: ScoredFrameHandler,
    /** Told once, when the model fails and the energy gate takes over. */
    private readonly onFailure: (error: Error) => void = () => {},
  ) {
    this.pending = new Float32Array(vad.frameSamples);
  }

  /** True once the energy gate took over from the model. */
  get failed(): boolean {
    return this.fallback !== null;
  }

  /**
   * Feeds samples. A gap or overlap in `startSample` drops the partial frame and starts a new
   * stream there.
   */
  push(samples: Float32Array, startSample: number = this.position): void {
    if (startSample !== this.position) {
      this.pendingLen = 0;
      this.position = startSample;
      this.reset();
    }
    const size = this.pending.length;
    let offset = 0;
    while (offset < samples.length) {
      if (this.pendingLen === 0) this.pendingStart = this.position + offset;
      const n = Math.min(size - this.pendingLen, samples.length - offset);
      this.pending.set(samples.subarray(offset, offset + n), this.pendingLen);
      this.pendingLen += n;
      offset += n;
      if (this.pendingLen === size) {
        this.pendingLen = 0;
        this.score(this.pending.slice(), this.pendingStart);
      }
    }
    this.position += samples.length;
  }

  /** Runs `fn` once every frame pushed so far was handed on. */
  after(fn: () => void): void {
    this.queue = this.queue.then(fn).catch(report);
  }

  /** Starts a new stream for the model (after the frames already pushed). */
  reset(): void {
    if (this.fallback) this.fallback.reset();
    else this.vad.reset();
  }

  /** Resolves once every frame pushed so far was handed on. */
  async drain(): Promise<void> {
    await this.queue;
  }

  private score(frame: Float32Array, startSample: number): void {
    const prob = this.fallback
      ? Promise.resolve(this.fallback.process(frame))
      : this.vad.process(frame).catch((err: unknown) => this.fail(err, frame));
    this.queue = this.queue
      .then(async () => this.onFrame(frame, startSample, await prob))
      .catch(report);
  }

  private fail(err: unknown, frame: Float32Array): number {
    if (!this.fallback) {
      this.fallback = new EnergyVad({ frameSamples: this.pending.length });
      this.onFailure(err instanceof Error ? err : new Error(String(err)));
    }
    return this.fallback.process(frame);
  }
}

/** A handler that threw must not stop later frames. */
function report(err: unknown): void {
  console.error(LOG_PREFIX, 'speech detector', err);
}
