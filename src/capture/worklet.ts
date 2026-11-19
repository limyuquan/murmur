/**
 * AudioWorklet processor: downmixes and resamples the captured audio to 16 kHz mono and posts
 * 20 ms frames to the offscreen document. Runs on the audio thread, so it does no allocation
 * beyond the frames it hands off, and never blocks.
 *
 * Built as its own bundle (`?worker&url` in capture/graph.ts) and loaded with
 * `audioWorklet.addModule`, so it can only import pure modules.
 */
import { downmix, FrameBatcher, StreamingResampler } from './resampler';
import {
  CAPTURE_PROCESSOR,
  FRAME_SAMPLES,
  PIPELINE_SAMPLE_RATE,
  type WorkletMessage,
} from './types';

// AudioWorkletGlobalScope isn't in TypeScript's DOM lib.
declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

/** Render quantum size (fixed at 128 in every shipping browser). */
const QUANTUM = 128;

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly resampler = new StreamingResampler(sampleRate, PIPELINE_SAMPLE_RATE);
  private readonly batcher = new FrameBatcher(FRAME_SAMPLES);
  private readonly mono = new Float32Array(QUANTUM);
  private readonly silence = new Float32Array(QUANTUM);
  private started = false;

  process(inputs: Float32Array[][]): boolean {
    if (!this.started) {
      this.started = true;
      this.post({ type: 'start', contextTime: currentTime, inputRate: sampleRate });
    }
    const channels = inputs[0] ?? [];
    // No channels means the source is inactive (paused track): that is silence, and time goes on.
    const mono = channels.length > 0 ? downmix(channels, this.mono) : this.silence;
    const out = this.resampler.process(mono);
    this.batcher.push(out, (samples, startSample) => {
      this.post({ type: 'frame', samples, startSample }, [samples.buffer]);
    });
    return true;
  }

  private post(message: WorkletMessage, transfer: Transferable[] = []): void {
    this.port.postMessage(message, transfer);
  }
}

registerProcessor(CAPTURE_PROCESSOR, CaptureProcessor);
