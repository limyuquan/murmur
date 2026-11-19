/**
 * Qwen3-ASR log-mel features, matching transformers' `Qwen3ASRFeatureExtractor` for a single clip:
 * 16 kHz, n_fft 400 (periodic Hann), hop 160, centred STFT with reflect padding, power spectrum,
 * 128 Slaney mel filters (0–8 kHz, Slaney norm), log10 floored at 1e-10, clamped to max − 8,
 * (x + 4) / 4, last STFT frame dropped (T = floor(n / 160)). Clips shorter than 0.5 s are
 * zero-padded to 0.5 s first, like the processor.
 *
 * Output: Float32Array laid out [128][T] (the encoder's [1, 128, T] input).
 */

const N_FFT = 400;
const HOP = 160;
const N_MELS = 128;
const N_BINS = N_FFT / 2 + 1;
const MIN_SAMPLES = 8000;

// ---------------------------------------------------------------- FFT (mixed radix 2/5, n = 400)

const COS = new Float64Array(N_FFT);
const SIN = new Float64Array(N_FFT);
for (let k = 0; k < N_FFT; k++) {
  COS[k] = Math.cos((2 * Math.PI * k) / N_FFT);
  SIN[k] = -Math.sin((2 * Math.PI * k) / N_FFT);
}
const scratch = new Map<number, { re: Float64Array; im: Float64Array }>();
function scratchFor(n: number) {
  let s = scratch.get(n);
  if (!s) {
    s = { re: new Float64Array(n), im: new Float64Array(n) };
    scratch.set(n, s);
  }
  return s;
}

/** Decimation-in-time FFT of the real input x[off + i·stride], i < n, into out[outOff .. outOff+n). */
function fft(
  x: Float64Array,
  off: number,
  stride: number,
  n: number,
  outRe: Float64Array,
  outIm: Float64Array,
  outOff: number,
): void {
  if (n === 1) {
    outRe[outOff] = x[off] as number;
    outIm[outOff] = 0;
    return;
  }
  const r = n % 2 === 0 ? 2 : n % 5 === 0 ? 5 : n;
  const m = n / r;
  for (let j = 0; j < r; j++) fft(x, off + j * stride, stride * r, m, outRe, outIm, outOff + j * m);
  const tw = N_FFT / n;
  const { re, im } = scratchFor(n);
  for (let k = 0; k < m; k++) {
    for (let q = 0; q < r; q++) {
      const idx = k + q * m;
      let sr = 0;
      let si = 0;
      for (let j = 0; j < r; j++) {
        const yr = outRe[outOff + j * m + k] as number;
        const yi = outIm[outOff + j * m + k] as number;
        const w = ((j * idx * tw) % N_FFT) | 0;
        const c = COS[w] as number;
        const s = SIN[w] as number;
        sr += yr * c - yi * s;
        si += yr * s + yi * c;
      }
      re[idx] = sr;
      im[idx] = si;
    }
  }
  for (let i = 0; i < n; i++) {
    outRe[outOff + i] = re[i] as number;
    outIm[outOff + i] = im[i] as number;
  }
}

// ---------------------------------------------------------------- Slaney mel filters

function hzToMel(f: number): number {
  return f >= 1000 ? 15 + Math.log(f / 1000) * (27 / Math.log(6.4)) : (3 * f) / 200;
}
function melToHz(m: number): number {
  return m >= 15 ? 1000 * Math.exp((Math.log(6.4) / 27) * (m - 15)) : (200 * m) / 3;
}

interface Filter {
  start: number;
  weights: Float32Array;
}
function buildFilters(): Filter[] {
  const fftFreqs = Array.from({ length: N_BINS }, (_, i) => (i * 8000) / (N_BINS - 1));
  const lo = hzToMel(0);
  const hi = hzToMel(8000);
  const hz = Array.from({ length: N_MELS + 2 }, (_, i) =>
    melToHz(lo + ((hi - lo) * i) / (N_MELS + 1)),
  );
  const filters: Filter[] = [];
  for (let m = 0; m < N_MELS; m++) {
    const l = hz[m] as number;
    const c = hz[m + 1] as number;
    const r = hz[m + 2] as number;
    const enorm = 2 / (r - l);
    const w: number[] = [];
    let start = -1;
    for (let b = 0; b < N_BINS; b++) {
      const f = fftFreqs[b] as number;
      const v = Math.max(0, Math.min((f - l) / (c - l), (r - f) / (r - c))) * enorm;
      if (v > 0) {
        if (start < 0) start = b;
        w[b - start] = v;
      } else if (start >= 0) break;
    }
    filters.push({ start: Math.max(0, start), weights: Float32Array.from(w) });
  }
  return filters;
}
const FILTERS = buildFilters();
const WINDOW = Float64Array.from(
  { length: N_FFT },
  (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT),
);

/** Log-mel features; returns the [128 × T] buffer and T. */
export function logMel(samples: Float32Array): { data: Float32Array; frames: number } {
  let x = samples;
  if (x.length < MIN_SAMPLES) {
    const padded = new Float32Array(MIN_SAMPLES);
    padded.set(x);
    x = padded;
  }
  const n = x.length;
  const T = Math.floor(n / HOP);
  const pad = N_FFT / 2;
  // Reflect-padded signal (centre = True).
  const xp = new Float64Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) xp[i] = x[pad - i] as number;
  for (let i = 0; i < n; i++) xp[pad + i] = x[i] as number;
  for (let i = 0; i < pad; i++) xp[pad + n + i] = x[n - 2 - i] as number;

  const out = new Float32Array(N_MELS * T);
  const frame = new Float64Array(N_FFT);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const power = new Float64Array(N_BINS);
  let max = -Infinity;
  for (let t = 0; t < T; t++) {
    const base = t * HOP;
    for (let i = 0; i < N_FFT; i++) frame[i] = (xp[base + i] as number) * (WINDOW[i] as number);
    fft(frame, 0, 1, N_FFT, re, im, 0);
    for (let b = 0; b < N_BINS; b++) power[b] = (re[b] as number) ** 2 + (im[b] as number) ** 2;
    for (let m = 0; m < N_MELS; m++) {
      const { start, weights } = FILTERS[m] as Filter;
      let s = 0;
      for (let k = 0; k < weights.length; k++)
        s += (weights[k] as number) * (power[start + k] as number);
      const v = Math.log10(Math.max(s, 1e-10));
      out[m * T + t] = v;
      if (v > max) max = v;
    }
  }
  const floor = max - 8;
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i] as number, floor) + 4) / 4;
  return { data: out, frames: T };
}

/** Number of audio tokens the encoder emits for T mel frames (13 per full 100-frame window). */
export function audioTokens(frames: number): number {
  const conv = (t: number) => Math.floor((t - 1) / 2) + 1;
  const rest = frames % 100;
  return (rest > 0 ? conv(conv(conv(rest))) : 0) + 13 * Math.floor(frames / 100);
}
