/**
 * Decodes a SourceBuffer's audio frames (from mirror.ts) with WebCodecs into 16 kHz mono PCM on
 * the media timeline.
 *
 * One `AudioDecoder` per contiguous run: at every jump (seek, gap, re-appended range) the old
 * decoder is flushed and closed and a new one starts, anchored at the new frame's time. Chrome's
 * AAC decoder keeps its output timestamps continuous across input jumps, so a single decoder
 * would label audio after a seek with the wrong time. Output is placed by counting samples from
 * the run's first frame, never by the decoder's timestamps.
 */
import { downmix, StreamingResampler } from '@/capture/resampler';
import type { MirrorSink } from './mirror';
import { PCM_RATE, toSample } from './pcm';
import type { AudioTrackConfig } from './types';

/** The parts of WebCodecs' `AudioData` used here. */
export interface AudioDataLike {
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  copyTo(destination: Float32Array, options: { planeIndex: number; format: 'f32-planar' }): void;
  close(): void;
}

/** The parts of WebCodecs' `AudioDecoder` used here. */
export interface DecoderLike {
  configure(config: {
    codec: string;
    sampleRate: number;
    numberOfChannels: number;
    description?: Uint8Array;
  }): void;
  decode(chunk: { timestamp: number; duration?: number; data: Uint8Array }): void;
  flush(): Promise<void>;
  close(): void;
}

export type CreateDecoder = (
  output: (data: AudioDataLike) => void,
  error: (error: Error) => void,
) => DecoderLike;

/** WebCodecs, as the offscreen document has it. */
export const webCodecsDecoder: CreateDecoder = (output, error) => {
  const decoder = new AudioDecoder({
    output: (data) => output(data as unknown as AudioDataLike),
    error: (e) => error(e instanceof Error ? e : new Error(String(e))),
  });
  return {
    configure: (config) =>
      decoder.configure({
        codec: config.codec,
        sampleRate: config.sampleRate,
        numberOfChannels: config.numberOfChannels,
        ...(config.description ? { description: config.description } : {}),
      }),
    decode: (chunk) =>
      decoder.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: chunk.timestamp,
          ...(chunk.duration !== undefined ? { duration: chunk.duration } : {}),
          data: chunk.data,
        }),
      ),
    flush: () => decoder.flush(),
    close: () => {
      if (decoder.state !== 'closed') decoder.close();
    },
  };
};

/** Where decoded audio goes: `samples` start at 16 kHz sample `start` of the media timeline. */
export type PcmWriter = (start: number, samples: Float32Array) => void;

interface Run {
  decoder: DecoderLike;
  /** 16 kHz sample of the run's first frame. */
  start: number;
  written: number;
  resampler: StreamingResampler | null;
  failed: boolean;
}

export class AudioRuns implements MirrorSink {
  private current: Run | null = null;
  private settings: AudioTrackConfig | null = null;
  /** Frames decoded, for diagnostics. */
  decodedSeconds = 0;
  errors: string[] = [];

  constructor(
    private readonly write: PcmWriter,
    private readonly create: CreateDecoder = webCodecsDecoder,
  ) {}

  config(config: AudioTrackConfig | null): void {
    this.end();
    this.settings = config && !config.encrypted ? config : null;
    if (config?.encrypted) this.warn('encrypted');
  }

  frame(time: number, duration: number | null, data: Uint8Array, jump: boolean): void {
    const settings = this.settings;
    if (!settings) return;
    if (jump || !this.current) this.begin(time, settings);
    const run = this.current;
    if (!run || run.failed) return;
    try {
      run.decoder.decode({
        timestamp: Math.round(time * 1e6),
        ...(duration !== null ? { duration: Math.round(duration * 1e6) } : {}),
        data,
      });
    } catch (err) {
      this.fail(run, err);
    }
  }

  warn(message: string): void {
    if (this.errors.length < 20) this.errors.push(message);
  }

  /** Ends the current run (its decoder is flushed, then closed). */
  end(): void {
    const run = this.current;
    this.current = null;
    if (!run) return;
    if (run.failed) {
      run.decoder.close();
      return;
    }
    run.decoder
      .flush()
      .then(() => {
        const tail = run.resampler?.flush();
        if (tail && tail.length > 0) this.emit(run, tail);
      })
      .catch(() => {})
      .finally(() => run.decoder.close());
  }

  private begin(time: number, settings: AudioTrackConfig): void {
    this.end();
    const run: Run = {
      decoder: null as unknown as DecoderLike,
      start: toSample(time),
      written: 0,
      resampler: null,
      failed: false,
    };
    run.decoder = this.create(
      (data) => this.output(run, data),
      (err) => this.fail(run, err),
    );
    try {
      run.decoder.configure({
        codec: settings.codec,
        sampleRate: settings.sampleRate,
        numberOfChannels: settings.channels,
        ...(settings.description ? { description: settings.description } : {}),
      });
    } catch (err) {
      this.fail(run, err);
    }
    this.current = run;
  }

  private output(run: Run, data: AudioDataLike): void {
    try {
      const frames = data.numberOfFrames;
      const channels: Float32Array[] = [];
      for (let c = 0; c < data.numberOfChannels; c++) {
        const plane = new Float32Array(frames);
        data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        channels.push(plane);
      }
      const mono = downmix(channels);
      if (!run.resampler || run.resampler.inRate !== data.sampleRate) {
        run.resampler = new StreamingResampler(data.sampleRate, PCM_RATE);
      }
      this.decodedSeconds += frames / data.sampleRate;
      const out = run.resampler.process(mono);
      // `process` reuses its buffer: copy before keeping.
      if (out.length > 0) this.emit(run, out.slice());
    } finally {
      data.close();
    }
  }

  private emit(run: Run, samples: Float32Array): void {
    this.write(run.start + run.written, samples);
    run.written += samples.length;
  }

  private fail(run: Run, err: unknown): void {
    if (run.failed) return;
    run.failed = true;
    this.warn(`decoder: ${err instanceof Error ? err.message : String(err)}`);
  }
}
