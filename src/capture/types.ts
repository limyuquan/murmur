/**
 * The audio contract between capture and everything downstream. Whatever the source (tab audio,
 * a test tone, later a companion app), the pipeline sees one format: 16 kHz mono Float32 frames
 * with an absolute sample index and the wall-clock time the user hears them.
 */

/** Sample rate of every frame the pipeline and the engines see. */
export const PIPELINE_SAMPLE_RATE = 16_000;

/** Name of the AudioWorklet processor in capture/worklet.ts. */
export const CAPTURE_PROCESSOR = 'murmur-capture';

/** Samples per frame posted by the capture worklet: 20 ms at 16 kHz. */
export const FRAME_SAMPLES = 320;

export interface AudioFrame {
  /** Mono samples in [-1, 1] at PIPELINE_SAMPLE_RATE. */
  samples: Float32Array;
  /** Index of `samples[0]` in the session's sample stream (0 = the first captured sample). */
  startSample: number;
  /**
   * When the user hears `samples[0]`, in epoch ms (`performance.timeOrigin + performance.now()`
   * scale, comparable across extension documents and the page). See capture/clock.ts.
   */
  startEpochMs: number;
}

/** Called for every captured frame, in order, without gaps. */
export type FrameSink = (frame: AudioFrame) => void;

/** Messages from the capture worklet to the offscreen document. */
export type WorkletMessage =
  | {
      type: 'start';
      /** AudioContext time of the first input sample the worklet saw. */
      contextTime: number;
      /** The context's sample rate (the worklet's input rate). */
      inputRate: number;
    }
  | { type: 'frame'; samples: Float32Array; startSample: number };
