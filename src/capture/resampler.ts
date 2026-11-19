/**
 * Streaming downmix + resampler for the capture worklet: any input rate (usually 48 kHz or
 * 44.1 kHz) to 16 kHz mono. Pure and allocation-light so it runs on the audio thread, and easy to
 * test in Node.
 *
 * Method: band-limited interpolation with a Blackman-windowed sinc (cutoff 0.9 × the lower
 * Nyquist), looked up from a precomputed table. Linear interpolation would alias music and
 * sibilants into the speech band and cost ASR accuracy; a FIR this size costs ~1–2 M
 * multiply-adds per second at 48 kHz → 16 kHz, which is nothing on the audio thread.
 *
 * Timing: output sample `n` is centred on input position `n * inRate / outRate` exactly (the
 * filter is symmetric). The resampler holds back `halfWidth` input samples (about 1 ms) until the
 * future input it needs has arrived, but timestamps stay exact: see `inputPosition`.
 */

export interface ResamplerOptions {
  /** Zero crossings of the sinc on each side. More = sharper filter, more work. Default 16. */
  zeroCrossings?: number;
  /** Passband edge as a fraction of the lower Nyquist frequency. Default 0.9. */
  cutoff?: number;
}

/** Table entries per input sample of filter offset. */
const TABLE_RESOLUTION = 64;

export class StreamingResampler {
  readonly inRate: number;
  readonly outRate: number;
  /** Input samples per output sample. */
  readonly step: number;
  /** Input samples the filter reaches on each side of an output sample's centre. */
  readonly halfWidth: number;
  private readonly table: Float32Array;
  private readonly passthrough: boolean;
  /** Pending input; `buf[0]` is absolute input index `bufStart`. */
  private buf: Float32Array;
  private bufLen = 0;
  private bufStart = 0;
  /** Absolute index of the next output sample. */
  private nextOut = 0;
  /** Output scratch, reused between calls (no allocation on the audio thread). */
  private out = new Float32Array(256);

  constructor(inRate: number, outRate: number, options: ResamplerOptions = {}) {
    if (!(inRate > 0 && outRate > 0)) throw new RangeError('sample rates must be positive');
    this.inRate = inRate;
    this.outRate = outRate;
    this.step = inRate / outRate;
    this.passthrough = inRate === outRate;
    const zeroCrossings = options.zeroCrossings ?? 16;
    const cutoff = options.cutoff ?? 0.9;
    // Cutoff in cycles per input sample.
    const fc = (cutoff * Math.min(inRate, outRate)) / 2 / inRate;
    this.halfWidth = this.passthrough ? 0 : Math.ceil(zeroCrossings / (2 * fc));
    const size = this.halfWidth * TABLE_RESOLUTION + 2;
    this.table = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      const x = i / TABLE_RESOLUTION;
      if (x > this.halfWidth) break;
      const t = x / this.halfWidth;
      const window = 0.42 + 0.5 * Math.cos(Math.PI * t) + 0.08 * Math.cos(2 * Math.PI * t);
      const arg = 2 * fc * x;
      const sinc = arg === 0 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg);
      this.table[i] = 2 * fc * sinc * window;
    }
    this.buf = new Float32Array(Math.max(1024, this.halfWidth * 4));
  }

  /** Input position (fractional input samples since the stream started) of output sample `n`. */
  inputPosition(n: number): number {
    return n * this.step;
  }

  /** Output samples produced so far. */
  get outputCount(): number {
    return this.nextOut;
  }

  /**
   * Feeds mono input; returns the output samples that are now complete (possibly none). The
   * result is a view of an internal buffer: valid until the next call, so copy what you keep.
   */
  process(input: Float32Array): Float32Array {
    if (this.passthrough) {
      this.nextOut += input.length;
      return input;
    }
    this.append(input);
    const available = this.bufStart + this.bufLen; // one past the last input index we have
    const max = Math.ceil(input.length / this.step) + this.halfWidth + 2;
    if (this.out.length < max) this.out = new Float32Array(max * 2);
    let count = 0;
    for (;;) {
      const centre = this.nextOut * this.step;
      if (Math.floor(centre) + this.halfWidth >= available) break;
      if (count === this.out.length) this.grow();
      this.out[count++] = this.sampleAt(centre);
      this.nextOut++;
    }
    this.discardBefore(Math.floor(this.nextOut * this.step) - this.halfWidth);
    return this.out.subarray(0, count);
  }

  private grow(): void {
    const next = new Float32Array(this.out.length * 2);
    next.set(this.out);
    this.out = next;
  }

  /**
   * Emits every output sample whose centre lies inside the input seen so far, treating the
   * future as silence. Call once at the end of a stream.
   */
  flush(): Float32Array {
    if (this.passthrough) return new Float32Array(0);
    const end = this.bufStart + this.bufLen;
    const out: number[] = [];
    while (this.nextOut * this.step < end) {
      out.push(this.sampleAt(this.nextOut * this.step));
      this.nextOut++;
    }
    return Float32Array.from(out);
  }

  private sampleAt(centre: number): number {
    const first = Math.ceil(centre - this.halfWidth);
    const last = Math.floor(centre + this.halfWidth);
    let acc = 0;
    let gain = 0;
    for (let i = first; i <= last; i++) {
      const pos = Math.abs(i - centre) * TABLE_RESOLUTION;
      const k = Math.floor(pos);
      const frac = pos - k;
      const a = this.table[k] ?? 0;
      const b = this.table[k + 1] ?? 0;
      const h = a + (b - a) * frac;
      gain += h;
      const j = i - this.bufStart;
      if (j >= 0 && j < this.bufLen) acc += (this.buf[j] ?? 0) * h;
    }
    // Normalise by the taps' sum so DC passes at exactly 1 whatever the fractional phase.
    return gain === 0 ? 0 : acc / gain;
  }

  private append(input: Float32Array): void {
    if (this.bufLen + input.length > this.buf.length) {
      const next = new Float32Array(Math.max(this.buf.length * 2, this.bufLen + input.length));
      next.set(this.buf.subarray(0, this.bufLen));
      this.buf = next;
    }
    this.buf.set(input, this.bufLen);
    this.bufLen += input.length;
  }

  private discardBefore(index: number): void {
    const drop = Math.min(this.bufLen, index - this.bufStart);
    if (drop <= 0) return;
    this.buf.copyWithin(0, drop, this.bufLen);
    this.bufLen -= drop;
    this.bufStart += drop;
  }
}

/**
 * Averages channels into `out` (allocated when not given). Equal-gain average keeps a centred
 * voice at its level and can't clip.
 */
export function downmix(channels: readonly Float32Array[], out?: Float32Array): Float32Array {
  const first = channels[0];
  const length = first?.length ?? 0;
  const target = out ?? new Float32Array(length);
  if (!first) return target;
  if (channels.length === 1) {
    target.set(first);
    return target;
  }
  const scale = 1 / channels.length;
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i] ?? 0;
    target[i] = sum * scale;
  }
  return target;
}

/**
 * Cuts a stream of variable-size chunks into fixed-size frames, each with the absolute index of
 * its first sample.
 */
export class FrameBatcher {
  private readonly frame: Float32Array;
  private filled = 0;
  private emitted = 0;

  constructor(readonly frameSamples: number) {
    this.frame = new Float32Array(frameSamples);
  }

  push(samples: Float32Array, emit: (frame: Float32Array, startSample: number) => void): void {
    let offset = 0;
    while (offset < samples.length) {
      const n = Math.min(this.frameSamples - this.filled, samples.length - offset);
      this.frame.set(samples.subarray(offset, offset + n), this.filled);
      this.filled += n;
      offset += n;
      if (this.filled === this.frameSamples) {
        emit(this.frame.slice(), this.emitted);
        this.emitted += this.frameSamples;
        this.filled = 0;
      }
    }
  }
}
