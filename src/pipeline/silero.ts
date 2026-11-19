/**
 * Silero VAD, a small speech detector (v6.2, MIT: src/assets/silero-vad/), on ONNX Runtime's
 * WebAssembly backend, one thread. It tells speech from music and noise, which the energy gate
 * (vad.ts) can't: over background music the gate hears no pauses at all.
 *
 * The model takes 512 samples (32 ms at 16 kHz) at a time, plus the last 64 samples of the
 * previous frame as context, and carries a recurrent state from frame to frame: frames must come
 * in order, and `reset()` starts a new stream (after a gap). Calls are queued, so they may be
 * made without waiting. About 0.5 ms per frame in Chrome on a desktop CPU: under 2% of one core.
 *
 * The ONNX Runtime module is passed in (`SileroVad.create`), so this file runs in Node for tests;
 * `silero-load.ts` loads it in the extension, from its own files.
 */
import type * as Ort from 'onnxruntime-web';
import type { AsyncVoiceActivityDetector } from './vad';

/** Samples per frame at 16 kHz. */
export const SILERO_FRAME = 512;
/** Samples of the previous frame the model sees again. */
const CONTEXT = 64;
const SAMPLE_RATE = 16_000;

/** The parts of ONNX Runtime used here. */
export interface OrtRuntime {
  InferenceSession: typeof Ort.InferenceSession;
  Tensor: typeof Ort.Tensor;
}

/** Time spent in the model. */
export interface VadCost {
  frames: number;
  /** Total, ms. */
  ms: number;
}

export class SileroVad implements AsyncVoiceActivityDetector {
  readonly frameSamples = SILERO_FRAME;
  readonly cost: VadCost = { frames: 0, ms: 0 };
  /** Context, then the frame. */
  private readonly input = new Float32Array(CONTEXT + SILERO_FRAME);
  private state: Ort.Tensor;
  private readonly sr: Ort.Tensor;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  private constructor(
    private readonly ort: OrtRuntime,
    private readonly session: Ort.InferenceSession,
  ) {
    this.state = this.zeroState();
    this.sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);
  }

  /** Loads the model (`model`: the ONNX file's bytes) on the WebAssembly backend. */
  static async create(ort: OrtRuntime, model: Uint8Array): Promise<SileroVad> {
    const session = await ort.InferenceSession.create(model, {
      executionProviders: ['wasm'],
      // 'all' fuses more but runs slower on this small recurrent model.
      graphOptimizationLevel: 'basic',
    });
    return new SileroVad(ort, session);
  }

  /** Speech probability, 0–1, of one frame of exactly 512 samples (16 kHz), after the last. */
  process(frame: Float32Array): Promise<number> {
    if (frame.length !== SILERO_FRAME) {
      return Promise.reject(new RangeError(`Silero VAD takes ${SILERO_FRAME} samples a frame.`));
    }
    const copy = frame.slice();
    const result = this.queue.then(() => this.run(copy));
    this.queue = result.catch(() => {});
    return result;
  }

  /** Forgets the stream so far (queued after the frames already given). */
  reset(): void {
    this.queue = this.queue.then(() => {
      this.input.fill(0);
      this.state = this.zeroState();
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.queue;
    await this.session.release();
  }

  private async run(frame: Float32Array): Promise<number> {
    if (this.disposed) throw new Error('Silero VAD was released.');
    this.input.set(frame, CONTEXT);
    const started = performance.now();
    const out = await this.session.run({
      input: new this.ort.Tensor('float32', this.input.slice(), [1, CONTEXT + SILERO_FRAME]),
      state: this.state,
      sr: this.sr,
    });
    this.cost.ms += performance.now() - started;
    this.cost.frames++;
    this.state = out.stateN as Ort.Tensor;
    // This frame's tail is the next frame's context.
    this.input.copyWithin(0, SILERO_FRAME);
    return (out.output as Ort.Tensor).data[0] as number;
  }

  private zeroState(): Ort.Tensor {
    return new this.ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
  }
}
