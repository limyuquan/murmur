/**
 * Decoded lookahead audio, 16 kHz mono, by media time: one `PcmTimeline` per MediaSource (or
 * progressive source). Stored as 16-bit samples in one-second blocks, so overwriting a range
 * (a re-appended segment: the newest wins), removing one, and dropping what's far from the
 * playhead are all cheap. What has been written is tracked in samples, separately from the
 * blocks, so a block can be partly filled.
 */
import { PIPELINE_SAMPLE_RATE } from '@/capture/types';
import { SpanSet } from './spans';
import type { Span } from './types';

export const PCM_RATE = PIPELINE_SAMPLE_RATE;
const BLOCK = PCM_RATE;
/** Bytes per stored block. */
export const BLOCK_BYTES = BLOCK * 2;

export class PcmTimeline {
  private readonly blocks = new Map<number, Int16Array>();
  /** Written samples. Joined across gaps under 20 ms (a decoder restart's rounding). */
  private readonly written = new SpanSet(320);

  /** Writes `samples` starting at sample `start` (= round(media seconds × 16000)). */
  write(start: number, samples: Float32Array): void {
    let i = 0;
    while (i < samples.length) {
      const at = start + i;
      const index = Math.floor(at / BLOCK);
      let block = this.blocks.get(index);
      if (!block) {
        block = new Int16Array(BLOCK);
        this.blocks.set(index, block);
      }
      const offset = at - index * BLOCK;
      const n = Math.min(BLOCK - offset, samples.length - i);
      for (let k = 0; k < n; k++) {
        const v = samples[i + k] ?? 0;
        block[offset + k] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767);
      }
      i += n;
    }
    this.written.add(start, start + samples.length);
  }

  /** Samples `[start, end)` (zeros where nothing was written). */
  read(start: number, end: number): Float32Array {
    const out = new Float32Array(Math.max(0, end - start));
    let i = 0;
    while (i < out.length) {
      const at = start + i;
      const index = Math.floor(at / BLOCK);
      const offset = at - index * BLOCK;
      const n = Math.min(BLOCK - offset, out.length - i);
      const block = this.blocks.get(index);
      if (block) for (let k = 0; k < n; k++) out[i + k] = (block[offset + k] ?? 0) / 32768;
      i += n;
    }
    return out;
  }

  /** Forgets samples `[start, end)`. */
  remove(start: number, end: number): void {
    this.written.subtract(start, end);
    for (const index of [...this.blocks.keys()]) {
      if (this.written.overlap(index * BLOCK, (index + 1) * BLOCK) === 0) {
        this.blocks.delete(index);
      }
    }
  }

  /** What has been written, in seconds. */
  coverage(): Span[] {
    return this.written.list.map(([s, e]) => [s / PCM_RATE, e / PCM_RATE] as const);
  }

  /** The written stretch holding `seconds` (or starting just after it), in samples. */
  spanFrom(sample: number): Span | null {
    return this.written.from(sample);
  }

  get bytes(): number {
    return this.blocks.size * BLOCK_BYTES;
  }

  /** Block indices, farthest from `sample` first (behind it counts double). */
  evictionOrder(sample: number): number[] {
    const distance = (index: number) => {
      const mid = (index + 0.5) * BLOCK;
      return mid < sample ? (sample - mid) * 2 : mid - sample;
    };
    return [...this.blocks.keys()].sort((a, b) => distance(b) - distance(a));
  }

  /** Drops one block (and what was written in it). */
  dropBlock(index: number): void {
    this.remove(index * BLOCK, (index + 1) * BLOCK);
    this.blocks.delete(index);
  }
}

/** Seconds → the 16 kHz sample index lookahead uses (absolute on the media timeline). */
export function toSample(seconds: number): number {
  return Math.round(seconds * PCM_RATE);
}
