/** Small byte helpers for the demuxers. Big-endian unless named otherwise. */

const latin1 = new TextDecoder('latin1');

export function fourcc(u8: Uint8Array, offset: number): string {
  return latin1.decode(u8.subarray(offset, offset + 4));
}

/** Byte `o` (0 past the end). */
function at(u8: Uint8Array, o: number): number {
  return u8[o] ?? 0;
}

export function u16(u8: Uint8Array, o: number): number {
  return (at(u8, o) << 8) | at(u8, o + 1);
}

export function u32(u8: Uint8Array, o: number): number {
  return ((at(u8, o) << 24) >>> 0) + ((at(u8, o + 1) << 16) | (at(u8, o + 2) << 8) | at(u8, o + 3));
}

export function i32(u8: Uint8Array, o: number): number {
  return u32(u8, o) | 0;
}

/** A 64-bit unsigned value as a number (exact up to 2^53). */
export function u64(u8: Uint8Array, o: number): number {
  return u32(u8, o) * 4294967296 + u32(u8, o + 4);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const nonEmpty = parts.filter((p) => p.length > 0);
  if (nonEmpty.length === 0) return parts[0] ?? new Uint8Array(0);
  if (nonEmpty.length === 1) return nonEmpty[0] as Uint8Array;
  const out = new Uint8Array(nonEmpty.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of nonEmpty) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Index of `needle` in `hay` at or after `from`, or -1. */
export function indexOf(hay: Uint8Array, needle: readonly number[], from = 0): number {
  const first = needle[0];
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    if (hay[i] !== first) continue;
    for (let k = 1; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

/** Base64 of bytes (uses the platform's `toBase64` when there is one). */
export function toBase64(u8: Uint8Array): string {
  const native = (u8 as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === 'function') return native.call(u8);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
  if (typeof native === 'function') return native(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
