/**
 * The lookahead demuxers on real files made by scripts/make-lookahead-media.sh (tone bursts), fed
 * whole and in the odd slices players append; times checked against what ffprobe reports.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Fmp4Demuxer, parseMovie, topLevelBoxes } from '@/lookahead/fmp4';
import type { AudioTrackConfig, DemuxEvent, Demuxer, EncodedSample } from '@/lookahead/types';
import { lacedFrames, opusPacketDuration, WebmDemuxer } from '@/lookahead/webm';

const FIXTURES = new URL('./fixtures/lookahead/', import.meta.url);
const read = (name: string) => new Uint8Array(readFileSync(new URL(name, FIXTURES)));

function run(demuxer: Demuxer, bytes: Uint8Array, slice = bytes.length) {
  const events: DemuxEvent[] = [];
  for (let o = 0; o < bytes.length; o += slice) {
    events.push(...demuxer.push(bytes.subarray(o, o + slice)));
  }
  const inits = events.flatMap((e) => (e.type === 'init' ? [e.audio] : []));
  const samples = events.flatMap((e) => (e.type === 'samples' ? e.samples : []));
  const warnings = events.flatMap((e) => (e.type === 'warning' ? [e.message] : []));
  return { inits, samples, warnings };
}

/** Frames follow each other `frame` s apart (`digits`: WebM times are whole ms). */
function expectContinuous(samples: EncodedSample[], frame: number, digits = 5): void {
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1] as EncodedSample;
    expect((samples[i] as EncodedSample).time - prev.time).toBeCloseTo(frame, digits);
  }
}

describe('Fmp4Demuxer', () => {
  it('reads AAC in fragments, whole or in any slices', () => {
    const bytes = read('aac-frag.mp4');
    const whole = run(new Fmp4Demuxer(), bytes);
    expect(whole.warnings).toEqual([]);
    expect(whole.inits).toHaveLength(1);
    const config = whole.inits[0] as AudioTrackConfig;
    expect(config).toMatchObject({ codec: 'mp4a.40.2', sampleRate: 44100, channels: 2 });
    expect(config.encrypted).toBe(false);
    expect(config.description?.length).toBeGreaterThan(1);
    expect(whole.samples).toHaveLength(131);
    // ffprobe: first packet at 0, then every 1024 samples.
    expect(whole.samples[0]?.time).toBeCloseTo(0, 5);
    expect(whole.samples.at(-1)?.time).toBeCloseTo(3.018594, 4);
    expectContinuous(whole.samples, 1024 / 44100);

    for (const slice of [1, 7, 333, 4096]) {
      const sliced = run(new Fmp4Demuxer(), bytes, slice);
      expect(sliced.samples.map((s) => s.time)).toEqual(whole.samples.map((s) => s.time));
      expect(sliced.samples.map((s) => s.data.length)).toEqual(
        whole.samples.map((s) => s.data.length),
      );
    }
  });

  it('reads Opus in fragments and gives WebCodecs an OpusHead', () => {
    const { inits, samples, warnings } = run(new Fmp4Demuxer(), read('opus-frag.mp4'), 1000);
    expect(warnings).toEqual([]);
    const config = inits[0] as AudioTrackConfig;
    expect(config).toMatchObject({ codec: 'opus', sampleRate: 48000, channels: 1 });
    expect(new TextDecoder().decode(config.description?.subarray(0, 8))).toBe('OpusHead');
    expect(config.description?.[9]).toBe(1);
    expect(samples).toHaveLength(151);
    expectContinuous(samples, 0.02);
  });

  it('finds the next fragment after skipped bytes', () => {
    const bytes = read('aac-frag.mp4');
    const demuxer = new Fmp4Demuxer();
    const all = run(new Fmp4Demuxer(), bytes).samples;
    // The init, then bytes from the middle of the first fragment on.
    const moov = topLevelBoxes(bytes).find((b) => b.type === 'moov');
    expect(moov).toBeDefined();
    const initEnd = (moov?.start ?? 0) + (moov?.size ?? 0);
    expect(demuxer.push(bytes.subarray(0, initEnd))[0]?.type).toBe('init');
    demuxer.resync();
    const rest = run(demuxer, bytes.subarray(initEnd + 500), 777);
    expect(rest.samples.length).toBeGreaterThan(80);
    expect(rest.samples.length).toBeLessThan(all.length);
    // What it found lines up with the full read.
    const tail = all.slice(all.length - rest.samples.length);
    expect(rest.samples.map((s) => s.time)).toEqual(tail.map((s) => s.time));
  });

  it('drops a partly appended fragment on reset (SourceBuffer.abort)', () => {
    const bytes = read('aac-frag.mp4');
    const demuxer = new Fmp4Demuxer();
    const boxes = topLevelBoxes(bytes);
    const moov = boxes.find((b) => b.type === 'moov');
    const moofs = boxes.filter((b) => b.type === 'moof');
    const second = moofs[1];
    expect(moov && second).toBeTruthy();
    demuxer.push(bytes.subarray(0, (moov?.start ?? 0) + (moov?.size ?? 0)));
    // Half of the first fragment, then abort, then the rest of the stream from fragment 2.
    demuxer.push(bytes.subarray((moov?.start ?? 0) + (moov?.size ?? 0), (second?.start ?? 0) - 10));
    demuxer.reset();
    const after = run(demuxer, bytes.subarray(second?.start ?? 0));
    expect(after.warnings).toEqual([]);
    expect(after.samples[0]?.time).toBeGreaterThan(0.3);
  });
});

describe('parseMovie (progressive MP4)', () => {
  it('lists the audio samples of a file whose index is at the end', () => {
    const bytes = read('aac-progressive.mp4');
    const boxes = topLevelBoxes(bytes);
    expect(boxes.map((b) => b.type)).toEqual(['ftyp', 'free', 'mdat', 'moov']);
    const moov = boxes.find((b) => b.type === 'moov');
    const movie = parseMovie(bytes.subarray(moov?.start, (moov?.start ?? 0) + (moov?.size ?? 0)));
    expect(movie?.config).toMatchObject({ codec: 'mp4a.40.2', sampleRate: 44100, channels: 1 });
    const samples = movie?.samples ?? [];
    expect(samples).toHaveLength(131);
    // ffprobe: the edit list starts the track 1024 samples in, so the first packet is at -23 ms.
    expect(samples[0]?.time).toBeCloseTo(-0.02322, 4);
    expect(samples[1]).toMatchObject({ offset: 96, size: 4 });
    expect(samples[1]?.time).toBeCloseTo(0, 5);
    expect(samples.at(-1)).toMatchObject({ offset: 9119, size: 4 });
  });
});

describe('WebmDemuxer', () => {
  it('reads Opus, whole or in any slices', () => {
    const bytes = read('opus.webm');
    const whole = run(new WebmDemuxer(), bytes);
    expect(whole.warnings).toEqual([]);
    const config = whole.inits[0] as AudioTrackConfig;
    expect(config).toMatchObject({ codec: 'opus', sampleRate: 48000, channels: 1 });
    expect(new TextDecoder().decode(config.description?.subarray(0, 8))).toBe('OpusHead');
    expect(whole.samples).toHaveLength(151);
    // Block times as written (ffprobe shows them 7 ms earlier: it subtracts the codec delay).
    expect(whole.samples[0]?.time).toBeCloseTo(0, 5);
    expect(whole.samples.every((s) => s.duration === 0.02)).toBe(true);
    expectContinuous(whole.samples, 0.02, 2);
    for (const slice of [1, 13, 32 * 1024]) {
      const sliced = run(new WebmDemuxer(), bytes, slice);
      expect(sliced.samples.map((s) => s.time)).toEqual(whole.samples.map((s) => s.time));
    }
  });

  it('picks up at the next cluster after skipped bytes', () => {
    const bytes = read('opus.webm');
    const all = run(new WebmDemuxer(), bytes).samples;
    const demuxer = new WebmDemuxer();
    demuxer.push(bytes.subarray(0, 400));
    demuxer.resync();
    const rest = run(demuxer, bytes.subarray(bytes.length / 2), 1000);
    expect(rest.samples.length).toBeGreaterThan(10);
    const tail = all.slice(all.length - rest.samples.length);
    expect(rest.samples.map((s) => s.time)).toEqual(tail.map((s) => s.time));
  });

  it('splits laced blocks', () => {
    const payload = new Uint8Array([2, 3, 255, 1, 9, 9, 9, ...new Array(256).fill(7), 5, 5]);
    // Xiph: 3 frames, sizes 3 and 256, the rest 2.
    const xiph = lacedFrames(payload, 0, payload.length, 1);
    expect(xiph?.map((f) => f.length)).toEqual([3, 256, 2]);
    // Fixed: 2 frames of 3.
    const fixed = new Uint8Array([1, 1, 2, 3, 4, 5, 6]);
    expect(lacedFrames(fixed, 0, fixed.length, 2)?.map((f) => [...f])).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    // EBML: 3 frames, first 2 bytes, second 2 + (-1) = 1, the rest 1.
    const ebml = new Uint8Array([2, 0x82, 0xbe, 1, 1, 2, 3]);
    expect(lacedFrames(ebml, 0, ebml.length, 3)?.map((f) => f.length)).toEqual([2, 1, 1]);
  });

  it('knows how long an Opus packet is', () => {
    expect(opusPacketDuration(new Uint8Array([0xfc]))).toBeCloseTo(0.02); // CELT 20 ms, 1 frame
    expect(opusPacketDuration(new Uint8Array([0x78 | 1]))).toBeCloseTo(0.04); // 2 × 20 ms
    expect(opusPacketDuration(new Uint8Array([0x08 | 3, 3]))).toBeCloseTo(0.06); // 3 × 20 ms
  });
});
