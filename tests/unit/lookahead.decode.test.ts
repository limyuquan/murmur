/**
 * From appended bytes to 16 kHz PCM on the media timeline: the SourceBuffer mirror (timestamp
 * offset, append window, jumps, abort, sequence mode), decoder runs (a fresh decoder at every
 * jump, output placed by counting samples), and the PCM store (overwrite, remove, eviction).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type AudioDataLike, AudioRuns, type CreateDecoder } from '@/lookahead/decode';
import { kindOf } from '@/lookahead/kind';
import { type MirrorSink, SourceBufferMirror } from '@/lookahead/mirror';
import { PCM_RATE, PcmTimeline } from '@/lookahead/pcm';
import type { AudioTrackConfig } from '@/lookahead/types';

const read = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/lookahead/${name}`, import.meta.url)));

function recordingSink() {
  const configs: (AudioTrackConfig | null)[] = [];
  const frames: { time: number; jump: boolean }[] = [];
  const warnings: string[] = [];
  const sink: MirrorSink = {
    config: (c) => configs.push(c),
    frame: (time, _d, _data, jump) => frames.push({ time, jump }),
    warn: (m) => warnings.push(m),
  };
  return { sink, configs, frames, warnings };
}

const append = (
  bytes: Uint8Array,
  patch: Partial<Parameters<SourceBufferMirror['append']>[0]> = {},
) => ({
  bytes,
  timestampOffset: 0,
  appendWindowStart: 0,
  appendWindowEnd: Number.POSITIVE_INFINITY,
  sequence: false,
  ...patch,
});

describe('kindOf', () => {
  it('goes by the codecs first', () => {
    expect(kindOf('audio/webm; codecs="opus"')).toBe('audio');
    expect(kindOf('video/mp4;codecs="mp4a.40.2"')).toBe('audio');
    expect(kindOf('video/mp4; codecs="avc1.4d401f,mp4a.40.2"')).toBe('muxed');
    expect(kindOf('video/webm; codecs="vp9"')).toBe('video');
    expect(kindOf('audio/mp4')).toBe('audio');
    expect(kindOf('video/mp4')).toBe('unknown');
  });
});

describe('SourceBufferMirror', () => {
  it('puts frames on the video timeline with the timestamp offset of their append', () => {
    const { sink, configs, frames } = recordingSink();
    const mirror = new SourceBufferMirror('audio/webm; codecs="opus"', sink);
    mirror.append(append(read('opus.webm'), { timestampOffset: 100 }));
    expect(configs[0]?.codec).toBe('opus');
    expect(frames[0]).toEqual({ time: 100, jump: true });
    expect(frames.slice(1).every((f) => !f.jump)).toBe(true);
    expect(frames.at(-1)?.time).toBeCloseTo(103, 1);
  });

  it('drops frames outside the append window and marks a jump after a gap', () => {
    const { sink, frames } = recordingSink();
    const mirror = new SourceBufferMirror('audio/webm', sink);
    const bytes = read('opus.webm');
    mirror.append(append(bytes, { appendWindowStart: 1, appendWindowEnd: 2 }));
    expect(frames.every((f) => f.time >= 0.98 && f.time < 2)).toBe(true);
    const n = frames.length;
    // The same clip again 60 s later (a seek): a jump.
    mirror.append(append(bytes, { timestampOffset: 60 }));
    expect(frames[n]).toEqual({ time: 60, jump: true });
  });

  it('skips sequence mode, and starts a new run after abort', () => {
    const { sink, frames, warnings } = recordingSink();
    const mirror = new SourceBufferMirror('audio/mp4', sink);
    const bytes = read('aac-frag.mp4');
    mirror.append(append(bytes, { sequence: true }));
    expect(frames).toEqual([]);
    expect(warnings).toContain('sequence mode');
    mirror.abort();
    mirror.append(append(bytes));
    expect(frames[0]?.jump).toBe(true);
  });
});

/** A stand-in decoder: one output per input, `rate` Hz, a ramp, with its own (wrong) times. */
function fakeDecoders(rate: number) {
  const made: { configs: unknown[]; inputs: number[]; closed: boolean }[] = [];
  const create: CreateDecoder = (output) => {
    const state = { configs: [] as unknown[], inputs: [] as number[], closed: false };
    made.push(state);
    return {
      configure: (c) => state.configs.push(c),
      decode: (chunk) => {
        state.inputs.push(chunk.timestamp);
        const frames = Math.round(rate * 0.02);
        const data: AudioDataLike = {
          numberOfFrames: frames,
          numberOfChannels: 2,
          sampleRate: rate,
          copyTo: (dest, { planeIndex }) => dest.fill(planeIndex === 0 ? 0.5 : -0.5),
          close: () => {},
        };
        output(data);
      },
      flush: () => Promise.resolve(),
      close: () => {
        state.closed = true;
      },
    };
  };
  return { create, made };
}

describe('AudioRuns', () => {
  const config: AudioTrackConfig = {
    codec: 'opus',
    sampleRate: 48000,
    channels: 2,
    description: null,
    encrypted: false,
  };

  it('starts a fresh decoder at every jump and places output by counting samples', async () => {
    const pcm = new PcmTimeline();
    const { create, made } = fakeDecoders(48000);
    const runs = new AudioRuns((start, s) => pcm.write(start, s), create);
    runs.config(config);
    for (let i = 0; i < 50; i++) runs.frame(10 + i * 0.02, 0.02, new Uint8Array(1), i === 0);
    for (let i = 0; i < 50; i++) runs.frame(300 + i * 0.02, 0.02, new Uint8Array(1), i === 0);
    runs.end();
    await new Promise((r) => setTimeout(r, 0));
    expect(made).toHaveLength(2);
    expect(made[0]?.closed).toBe(true);
    const spans = pcm.coverage();
    expect(spans).toHaveLength(2);
    expect(spans[0]?.[0]).toBeCloseTo(10, 3);
    expect(spans[0]?.[1]).toBeCloseTo(11, 2);
    expect(spans[1]?.[0]).toBeCloseTo(300, 3);
    // Stereo downmixed: +0.5 and -0.5 cancel.
    const mid = pcm.read(10.5 * PCM_RATE, 10.5 * PCM_RATE + 10);
    expect(Math.max(...mid.map(Math.abs))).toBeLessThan(0.01);
  });

  it('decodes nothing that is encrypted', () => {
    const { create, made } = fakeDecoders(48000);
    const runs = new AudioRuns(() => {}, create);
    runs.config({ ...config, encrypted: true });
    runs.frame(0, 0.02, new Uint8Array(1), true);
    expect(made).toHaveLength(0);
    expect(runs.errors).toContain('encrypted');
  });
});

describe('PcmTimeline', () => {
  it('overwrites, reads back, removes and evicts', () => {
    const pcm = new PcmTimeline();
    pcm.write(0, new Float32Array(3 * PCM_RATE).fill(0.25));
    // A re-appended stretch: the newest wins.
    pcm.write(PCM_RATE, new Float32Array(PCM_RATE).fill(-0.5));
    expect(pcm.read(PCM_RATE - 1, PCM_RATE + 1)[1]).toBeCloseTo(-0.5, 3);
    expect(pcm.read(PCM_RATE - 1, PCM_RATE + 1)[0]).toBeCloseTo(0.25, 3);
    expect(pcm.coverage()).toEqual([[0, 3]]);
    pcm.remove(PCM_RATE, 2 * PCM_RATE);
    expect(pcm.coverage()).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(pcm.bytes).toBe(2 * PCM_RATE * 2);
    // Behind the playhead goes first.
    expect(pcm.evictionOrder(2.5 * PCM_RATE)[0]).toBe(0);
    pcm.dropBlock(0);
    expect(pcm.coverage()).toEqual([[2, 3]]);
  });
});
