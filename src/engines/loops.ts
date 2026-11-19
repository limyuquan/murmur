/**
 * Guards against decoding loops, shared by the ASR engines that decode text (Qwen3-ASR, Whisper):
 * greedy decoding that starts repeating itself never stops by itself. Pure, so unit-tested.
 *
 * - `maxTextTokens`: a cap on the text tokens a decode may write, from the audio's length.
 * - `compressionRatio`: how much a text compresses, the measure Whisper's own decoder uses to spot
 *   loops (`len(text) / len(zlib.compress(text))`, above 2.4 is a loop). whisper/filters.ts trims
 *   or drops a line above that.
 */

/**
 * Most text tokens for `seconds` of audio: 8 a second plus 16, the cap the segmentation benchmark
 * recommends. On its ~7,900 final segments (chatter, code-switching, long-form, up to 12 s), real
 * speech ran at p99 8.4 tokens a second over 2 s or more in Qwen3-ASR's tokenizer (Korean, the
 * densest; Japanese, Chinese and English under 6) and at most 42 tokens in 4 s in Whisper's. Only
 * one line that wasn't a loop needed more (49 tokens in 4 s, by 1 token); the loops ran to
 * 64–8,189 tokens.
 */
export function maxTextTokens(seconds: number): number {
  return Math.ceil(16 + Math.max(0, seconds) * 8);
}

/** Text compressing better than this (UTF-8 size ÷ zlib size) is a repetition loop. */
export const MAX_COMPRESSION_RATIO = 2.4;

/*
 * The compression ratio is estimated, not measured with a real compressor (which would be async
 * in a browser): the bytes are parsed the way deflate does (LZ77: repeats of 3–258 bytes up to
 * 32 KB back, greedy, hash chains) and the parse is priced as deflate would, with the fixed
 * Huffman codes or with codes built for this text plus the cost of sending them, whichever is
 * smaller, plus zlib's 6 bytes of header and checksum. On ~26,000 transcripts and loops from the
 * benchmark it was within 1% of zlib's level 6 on average and on the same side of 2.4 for all but
 * 2 (both loops, at 2.35 by zlib); tens of microseconds a line.
 */

const MIN_MATCH = 3;
const MAX_MATCH = 258;
const WINDOW = 32_768;
const MAX_CHAIN = 64;
const HASH_BITS = 12;
/** zlib's 2-byte header and 4-byte Adler-32 checksum. */
const ZLIB_OVERHEAD = 6;
const END_OF_BLOCK = 256;

/** Length → [code, extra bits]: deflate's length codes 257–285. */
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];

function lengthCode(length: number): { code: number; extra: number } {
  let i = LENGTH_BASE.length - 1;
  while ((LENGTH_BASE[i] as number) > length) i--;
  return { code: 257 + i, extra: LENGTH_EXTRA[i] as number };
}

/** Distance (1–32768) → [code 0–29, extra bits]. */
function distanceCode(distance: number): { code: number; extra: number } {
  if (distance <= 4) return { code: distance - 1, extra: 0 };
  const extra = Math.floor(Math.log2(distance - 1)) - 1;
  const code = 2 * extra + 2 + ((distance - 1) >> extra >= 3 ? 1 : 0);
  return { code, extra };
}

/** Bits per symbol of deflate's fixed literal/length code. */
function fixedLitLenBits(symbol: number): number {
  if (symbol < 144) return 8;
  if (symbol < 256) return 9;
  if (symbol < 280) return 7;
  return 8;
}

function bump(counts: number[], symbol: number, by = 1): void {
  counts[symbol] = (counts[symbol] ?? 0) + by;
}

/** Huffman code lengths for `counts` (0 for unused symbols). */
function huffmanLengths(counts: readonly number[]): number[] {
  const lengths = counts.map(() => 0);
  type Node = { weight: number; symbols: number[] };
  let nodes: Node[] = [];
  counts.forEach((c, symbol) => {
    if (c > 0) nodes.push({ weight: c, symbols: [symbol] });
  });
  if (nodes.length === 1) {
    lengths[(nodes[0] as Node).symbols[0] as number] = 1;
    return lengths;
  }
  while (nodes.length > 1) {
    nodes.sort((a, b) => a.weight - b.weight);
    const [a, b] = nodes as [Node, Node];
    for (const s of a.symbols) lengths[s] = (lengths[s] as number) + 1;
    for (const s of b.symbols) lengths[s] = (lengths[s] as number) + 1;
    nodes = [
      { weight: a.weight + b.weight, symbols: [...a.symbols, ...b.symbols] },
      ...nodes.slice(2),
    ];
  }
  return lengths;
}

/** Order in which a dynamic block sends the code-length code's lengths. */
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Bits a dynamic block spends describing its two codes (`lit` and `dist` lengths). */
function tableBits(lit: readonly number[], dist: readonly number[]): number {
  let hlit = 286;
  while (hlit > 257 && lit[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && dist[hdist - 1] === 0) hdist--;
  const seq = [...lit.slice(0, hlit), ...dist.slice(0, hdist)];
  // Run-length code the lengths (16: repeat the last 3–6 times, 17/18: 3–10 / 11–138 zeros).
  const clCounts = new Array<number>(19).fill(0);
  let extra = 0;
  for (let i = 0; i < seq.length; ) {
    const v = seq[i] as number;
    let run = 1;
    while (i + run < seq.length && seq[i + run] === v) run++;
    i += run;
    if (v === 0) {
      while (run >= 11) {
        const n = Math.min(run, 138);
        bump(clCounts, 18);
        extra += 7;
        run -= n;
      }
      if (run >= 3) {
        bump(clCounts, 17);
        extra += 3;
        run = 0;
      }
      bump(clCounts, 0, run);
    } else {
      bump(clCounts, v);
      run--;
      while (run >= 3) {
        run -= Math.min(run, 6);
        bump(clCounts, 16);
        extra += 2;
      }
      bump(clCounts, v, run);
    }
  }
  const clLengths = huffmanLengths(clCounts);
  let hclen = 19;
  while (hclen > 4 && clLengths[CL_ORDER[hclen - 1] as number] === 0) hclen--;
  let bits = 5 + 5 + 4 + 3 * hclen + extra;
  clCounts.forEach((c, s) => {
    bits += c * (clLengths[s] as number);
  });
  return bits;
}

/** Estimated size, in bytes, of `zlib.compress(bytes)` at the default level. */
export function zlibSize(bytes: Uint8Array): number {
  const n = bytes.length;
  const litCounts = new Array<number>(286).fill(0);
  const distCounts = new Array<number>(30).fill(0);
  let extraBits = 0;
  let fixedBits = 0;
  const head = new Int32Array(1 << HASH_BITS).fill(-1);
  const prev = new Int32Array(n);
  const hash = (i: number) =>
    ((((bytes[i] as number) << 10) ^ ((bytes[i + 1] as number) << 5) ^ (bytes[i + 2] as number)) &
      ((1 << HASH_BITS) - 1)) >>>
    0;
  const insert = (i: number) => {
    if (i + MIN_MATCH > n) return;
    const h = hash(i);
    prev[i] = head[h] as number;
    head[h] = i;
  };
  let i = 0;
  while (i < n) {
    let bestLen = 0;
    let bestDist = 0;
    if (i + MIN_MATCH <= n) {
      let j = head[hash(i)] as number;
      for (let chain = 0; j >= 0 && i - j <= WINDOW && chain < MAX_CHAIN; chain++) {
        let len = 0;
        const max = Math.min(MAX_MATCH, n - i);
        while (len < max && bytes[j + len] === bytes[i + len]) len++;
        if (len > bestLen) {
          bestLen = len;
          bestDist = i - j;
          if (len === max) break;
        }
        j = prev[j] as number;
      }
    }
    if (bestLen >= MIN_MATCH) {
      const l = lengthCode(bestLen);
      const d = distanceCode(bestDist);
      bump(litCounts, l.code);
      bump(distCounts, d.code);
      extraBits += l.extra + d.extra;
      fixedBits += fixedLitLenBits(l.code) + 5;
      for (let k = 0; k < bestLen; k++) insert(i + k);
      i += bestLen;
    } else {
      const b = bytes[i] as number;
      bump(litCounts, b);
      fixedBits += fixedLitLenBits(b);
      insert(i);
      i++;
    }
  }
  bump(litCounts, END_OF_BLOCK);
  fixedBits += 7;

  const litLengths = huffmanLengths(litCounts);
  const distLengths = huffmanLengths(distCounts);
  let dynamicBits = tableBits(litLengths, distLengths);
  litCounts.forEach((c, s) => {
    dynamicBits += c * (litLengths[s] as number);
  });
  distCounts.forEach((c, s) => {
    dynamicBits += c * (distLengths[s] as number);
  });
  const blockBits = 3 + extraBits + Math.min(fixedBits, dynamicBits);
  const stored = 5 + n;
  return ZLIB_OVERHEAD + Math.min(Math.ceil(blockBits / 8), stored);
}

const encoder = new TextEncoder();

/** UTF-8 size ÷ estimated zlib size (0 for empty text). Repetition loops score above 2.4. */
export function compressionRatio(text: string): number {
  const bytes = encoder.encode(text);
  if (bytes.length === 0) return 0;
  return bytes.length / zlibSize(bytes);
}
