/** Signal generators for audio tests. */

export function sine(freq: number, rate: number, seconds: number, amplitude = 1): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++)
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

export function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += (samples[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
}

export function concat(parts: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** `seconds` of a 220 Hz tone at `amplitude`, or silence when amplitude is 0. */
export function burst(seconds: number, amplitude: number, rate = 16_000): Float32Array {
  return amplitude === 0
    ? new Float32Array(Math.round(rate * seconds))
    : sine(220, rate, seconds, amplitude);
}
