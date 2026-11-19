/**
 * Silero VAD with the bundled model on ONNX Runtime's WebAssembly backend (in Node), on short
 * real clips (tests/unit/fixtures/vad/README.md): speech, music without speech, silence, and the
 * two mixed. Then the segmenter fed its probabilities, against the energy gate.
 */
import { readFileSync } from 'node:fs';
import * as ort from 'onnxruntime-web';
import { beforeAll, describe, expect, it } from 'vitest';
import { type SegmentEvent, Segmenter } from '@/pipeline/segmenter';
import { SILERO_FRAME, SileroVad } from '@/pipeline/silero';
import { EnergyVad } from '@/pipeline/vad';
import { concat } from './helpers';

const RATE = 16_000;
const MODEL = new URL('../../src/assets/silero-vad/silero_vad.onnx', import.meta.url);
const FIXTURES = new URL('./fixtures/vad/', import.meta.url);

/** A 16-bit mono PCM WAV as floats. */
function readWav(name: string): Float32Array {
  const buf = readFileSync(new URL(name, FIXTURES));
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      expect(view.getUint16(offset + 10, true)).toBe(1);
      expect(view.getUint32(offset + 12, true)).toBe(RATE);
      expect(view.getUint16(offset + 22, true)).toBe(16);
    }
    if (id === 'data') {
      const out = new Float32Array(size / 2);
      for (let i = 0; i < out.length; i++) out[i] = view.getInt16(offset + 8 + i * 2, true) / 32768;
      return out;
    }
    offset += 8 + size;
  }
  throw new Error(`${name}: no data chunk`);
}

const scale = (x: Float32Array, gain: number) => x.map((v) => v * gain);
const mix = (a: Float32Array, b: Float32Array) => a.map((v, i) => v + (b[i] ?? 0));
/** `x` repeated to `n` samples. */
const loop = (x: Float32Array, n: number) =>
  Float32Array.from({ length: n }, (_, i) => x[i % x.length] ?? 0);

async function probs(vad: SileroVad, audio: Float32Array): Promise<number[]> {
  const out: Promise<number>[] = [];
  // Not awaited one by one: the detector queues them.
  for (let i = 0; i + SILERO_FRAME <= audio.length; i += SILERO_FRAME) {
    out.push(vad.process(audio.subarray(i, i + SILERO_FRAME)));
  }
  return Promise.all(out);
}

const share = (ps: number[], at = 0.5) => ps.filter((p) => p >= at).length / ps.length;
/** Longest run of frames at or above `at`, ms. */
function longestRunMs(ps: number[], at = 0.5): number {
  let best = 0;
  let run = 0;
  for (const p of ps) {
    run = p >= at ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return (best * SILERO_FRAME * 1000) / RATE;
}

let speech: Float32Array;
let music: Float32Array;
let fresh: () => Promise<SileroVad>;

beforeAll(async () => {
  ort.env.wasm.numThreads = 1;
  const model = new Uint8Array(readFileSync(MODEL));
  fresh = () => SileroVad.create(ort, model);
  speech = readWav('speech.wav');
  music = readWav('music.wav');
});

describe('SileroVad', () => {
  it('hears speech, from where it starts', async () => {
    const ps = await probs(await fresh(), speech);
    // The clip opens with about 0.4 s of room tone.
    expect(Math.max(...ps.slice(0, 10))).toBeLessThan(0.2);
    expect(share(ps.slice(16))).toBeGreaterThan(0.95);
  });

  it('hears no speech in music, silence or faint noise', async () => {
    const vad = await fresh();
    const inMusic = await probs(vad, music);
    expect(share(inMusic)).toBeLessThan(0.05);
    expect(longestRunMs(inMusic)).toBeLessThan(100);
    vad.reset();
    const quiet = await probs(vad, new Float32Array(RATE));
    expect(Math.max(...quiet)).toBeLessThan(0.1);
    vad.reset();
    let seed = 1;
    const noise = Float32Array.from({ length: RATE }, () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return (seed / 2 ** 31 - 0.5) * 0.002;
    });
    expect(Math.max(...(await probs(vad, noise)))).toBeLessThan(0.1);
  });

  it('hears speech over music, where the energy gate hears only sound', async () => {
    const vad = await fresh();
    const over = mix(speech, scale(music, 0.5));
    const ps = await probs(vad, over);
    expect(share(ps.slice(16))).toBeGreaterThan(0.8);
    const energy = new EnergyVad({ frameSamples: SILERO_FRAME });
    const gate: number[] = [];
    for (let i = 0; i + SILERO_FRAME <= over.length; i += SILERO_FRAME) {
      gate.push(energy.process(over.subarray(i, i + SILERO_FRAME)));
    }
    // The gate can't tell the music-only opening from speech.
    expect(share(gate.slice(0, 10))).toBe(1);
  });

  it('carries its state from frame to frame, and reset() starts over', async () => {
    const vad = await fresh();
    const first = await probs(vad, speech);
    const again = await probs(vad, speech);
    // The second pass opens straight after speech: the model still has it in mind.
    expect(again.slice(0, 3)).not.toEqual(first.slice(0, 3));
    vad.reset();
    expect(await probs(vad, speech)).toEqual(first);
  });

  it('takes 512-sample frames only, and costs a few percent of a core', async () => {
    const vad = await fresh();
    await expect(vad.process(new Float32Array(320))).rejects.toThrow(/512/);
    await probs(vad, concat([speech, music, speech, music]));
    const msPerFrame = vad.cost.ms / vad.cost.frames;
    // A frame is 32 ms of audio. Real figures: about 1 ms here, see the README.
    expect(msPerFrame).toBeLessThan(8);
    await vad.dispose();
    await expect(vad.process(new Float32Array(SILERO_FRAME))).rejects.toThrow(/released/);
  });
});

describe('Segmenter on Silero probabilities', () => {
  /** Speech, a 1.2 s break with only the music, speech again, all over music; then quiet. */
  function talkOverMusic(): Float32Array {
    const gap = new Float32Array(Math.round(1.2 * RATE));
    const talk = concat([speech, gap, speech]);
    const bed = scale(loop(music, talk.length), 0.5);
    return concat([mix(talk, bed), new Float32Array(RATE)]);
  }

  async function segment(vad: 'silero' | 'energy', audio: Float32Array): Promise<SegmentEvent[]> {
    const events: SegmentEvent[] = [];
    if (vad === 'energy') {
      const seg = new Segmenter(new EnergyVad());
      for (let i = 0; i < audio.length; i += 320)
        events.push(...seg.push(audio.subarray(i, i + 320), i));
      return events;
    }
    const seg = new Segmenter(new EnergyVad({ frameSamples: SILERO_FRAME }), { minSpeechMs: 32 });
    const ps = await probs(await fresh(), audio);
    ps.forEach((p, k) => {
      const at = k * SILERO_FRAME;
      events.push(...seg.pushScored(audio.slice(at, at + SILERO_FRAME), at, p));
    });
    return events;
  }

  const ends = (events: SegmentEvent[]) =>
    events.filter((e) => e.type === 'end') as Extract<SegmentEvent, { type: 'end' }>[];

  it('ends the first line at the break in the talk, which the energy gate misses', async () => {
    const audio = talkOverMusic();
    const silero = ends(await segment('silero', audio));
    expect(silero.map((e) => e.reason)).toEqual(['silence', 'silence']);
    // The first ends after the first clip's speech (3 s), not at the 6 s cut.
    expect(silero[0]?.endSample).toBeGreaterThan(2.8 * RATE);
    expect(silero[0]?.endSample).toBeLessThan(3.4 * RATE);

    const energy = ends(await segment('energy', audio));
    expect(energy[0]?.reason).toBe('max-length');
  });
});
