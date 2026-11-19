/**
 * The capture graph, in the offscreen document:
 *
 *   source ─┬─▶ destination            (playback, so a captured tab stays audible)
 *           └─▶ capture worklet ─▶ 0 gain ─▶ destination   (16 kHz mono frames out)
 *
 * One AudioContext does both, so playback and analysis share a clock: the time a frame is heard
 * (its `startEpochMs`) comes from that context's output timestamp.
 */
import { contextTimeToEpochMs, type OutputTimestamp } from './clock';
import type { AudioSource } from './sources';
import {
  CAPTURE_PROCESSOR,
  type FrameSink,
  PIPELINE_SAMPLE_RATE,
  type WorkletMessage,
} from './types';
import workletUrl from './worklet.ts?worker&url';

export interface CaptureHandle {
  readonly context: AudioContext;
  readonly source: AudioSource;
  stop(): Promise<void>;
}

/** Starts capturing `source`; frames arrive at `onFrame` until `stop()`. */
export async function startCapture(
  source: AudioSource,
  onFrame: FrameSink,
): Promise<CaptureHandle> {
  const context = new AudioContext({ latencyHint: 'interactive' });
  try {
    // USER_MEDIA offscreen documents may start audio without a gesture; resume in case the
    // context still came up suspended.
    if (context.state === 'suspended') await context.resume();
    const connected = await source.connect(context);
    if (connected.playback) connected.node.connect(context.destination);

    await context.audioWorklet.addModule(workletUrl);
    const worklet = new AudioWorkletNode(context, CAPTURE_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    // The worklet must reach the destination to be pulled; a zero gain keeps it silent.
    const sink = new GainNode(context, { gain: 0 });
    connected.node.connect(worklet).connect(sink).connect(context.destination);

    let firstContextTime = Number.NaN;
    worklet.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
      const message = event.data;
      if (message.type === 'start') {
        firstContextTime = message.contextTime;
        return;
      }
      const contextTime = firstContextTime + message.startSample / PIPELINE_SAMPLE_RATE;
      onFrame({
        samples: message.samples,
        startSample: message.startSample,
        startEpochMs: contextTimeToEpochMs(
          contextTime,
          outputTimestamp(context),
          performance.timeOrigin,
        ),
      });
    };

    return {
      context,
      source,
      async stop() {
        worklet.port.onmessage = null;
        connected.stop();
        await context.close();
      },
    };
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

/**
 * The context's output timestamp. Right after start-up Chrome reports zeros; until it has a real
 * one, estimate from the current time and the reported latencies.
 */
function outputTimestamp(context: AudioContext): OutputTimestamp {
  const stamp = context.getOutputTimestamp();
  if (stamp.performanceTime && stamp.contextTime !== undefined) {
    return { contextTime: stamp.contextTime, performanceTime: stamp.performanceTime };
  }
  const latency = (context.outputLatency || 0) + context.baseLatency;
  return { contextTime: context.currentTime - latency, performanceTime: performance.now() };
}
