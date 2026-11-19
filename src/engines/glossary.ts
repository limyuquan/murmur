/**
 * The person's glossary: names and terms with the rendering they want (`source → target`). A
 * translator that uses one (`usesGlossary`) gets only the entries a line needs: those whose
 * source occurs in the line or the earlier lines given as context. Fewer entries keep the prompt
 * short and keep the model from reaching for a name nobody said.
 *
 * Matching:
 * - Words in scripts written with spaces (Latin, Cyrillic, ...): whole words, any case.
 * - Scripts written without spaces (Chinese, Japanese, Korean, Thai): anywhere in the text,
 *   except that a Korean name of one or two syllables must stand alone or be followed by a
 *   particle, so a short name doesn't match inside a longer word.
 * - Light fuzzy matching for names speech recognition misheard: a source of 3+ characters (5+
 *   letters in spaced scripts) also matches text that is nearly the same, letter by letter
 *   (Korean compared by its letters, not whole syllables).
 */

export interface GlossaryEntry {
  /** As it is said (or as speech recognition writes it). */
  source: string;
  /** How it should appear in the translation. */
  target: string;
}

/** Most entries a single line is given. */
export const MAX_GLOSSARY_HITS = 24;

const HANGUL = /[가-힣]/;
/** Scripts written without spaces between words. */
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

/** Particles that may follow a short Korean name. */
const PARTICLES = [
  '이가',
  '이는',
  '이도',
  '이를',
  '이랑',
  '이한테',
  '이야',
  '이의',
  '이',
  '가',
  '는',
  '은',
  '도',
  '를',
  '을',
  '랑',
  '한테',
  '에게',
  '야',
  '아',
  '의',
  '씨',
  '님',
  '께서',
  '하고',
  '와',
  '과',
  '만',
  '까지',
];

/** A short Korean term standing alone or followed by a particle, somewhere in `text`. */
function boundedHangulHit(source: string, text: string): boolean {
  for (let at = text.indexOf(source); at >= 0; at = text.indexOf(source, at + 1)) {
    const before = at > 0 ? (text[at - 1] as string) : ' ';
    if (HANGUL.test(before)) continue;
    const rest = text.slice(at + source.length);
    const next = rest[0];
    if (!next || !HANGUL.test(next)) return true;
    const particle = PARTICLES.find(
      (p) =>
        rest.startsWith(p) && (rest.length === p.length || !HANGUL.test(rest[p.length] as string)),
    );
    if (particle) return true;
  }
  return false;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Longest common subsequence length. */
function lcs(a: readonly string[], b: readonly string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      row[j] =
        a[i - 1] === b[j - 1]
          ? (prev[j - 1] as number) + 1
          : Math.max(prev[j] as number, row[j - 1] as number);
    }
    prev = row;
  }
  return prev[b.length] as number;
}

/** 0–1: how alike two strings are, letter by letter (insertions and deletions). */
export function similarity(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  if (x.length + y.length === 0) return 1;
  return (2 * lcs(x, y)) / (x.length + y.length);
}

/** The best `similarity` of `needle` with any stretch of `haystack` as long as it. */
export function partialSimilarity(needle: string, haystack: string): number {
  const n = [...needle];
  const h = [...haystack];
  if (h.length <= n.length) return similarity(needle, haystack);
  let best = 0;
  for (let i = 0; i + n.length <= h.length; i++) {
    best = Math.max(best, similarity(needle, h.slice(i, i + n.length).join('')));
    if (best === 1) break;
  }
  return best;
}

/** Lower case, accents dropped. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Fuzzy matches need this `similarity` (unspaced scripts) ... */
const UNSPACED_FUZZY = 0.8;
/** ... and this (spaced scripts, same first letter). */
const SPACED_FUZZY = 0.85;

function codePoints(text: string): Int32Array {
  return Int32Array.from(text, (c) => c.codePointAt(0) as number);
}

const bigramKey = (a: number, b: number) => a * 0x110000 + b;

/** Reused rows for `lcsAt`. */
let rowA = new Int32Array(64);
let rowB = new Int32Array(64);

/** Longest common subsequence of `a` and `b[start, start + len)`. */
function lcsAt(a: Int32Array, b: Int32Array, start: number, len: number): number {
  if (rowA.length <= len) {
    rowA = new Int32Array(len * 2);
    rowB = new Int32Array(len * 2);
  }
  let prev = rowA;
  let row = rowB;
  prev.fill(0, 0, len + 1);
  for (let i = 1; i <= a.length; i++) {
    row[0] = 0;
    const ai = a[i - 1];
    for (let j = 1; j <= len; j++) {
      row[j] =
        ai === b[start + j - 1]
          ? (prev[j - 1] as number) + 1
          : Math.max(prev[j] as number, row[j - 1] as number);
    }
    const t = prev;
    prev = row;
    row = t;
  }
  return prev[len] as number;
}

/** The text of one request, prepared once for every entry. */
interface Prepared {
  blob: string;
  /** Unspaced fuzzy matching: the text without spaces, decomposed, and its bigrams' positions. */
  squashed?: { cps: Int32Array; bigrams: Map<number, number[]> };
  /** Spaced fuzzy matching: folded words, and where each first letter starts one. */
  words?: { cps: Int32Array[]; byFirst: Map<number, number[]> };
}

function squashedOf(p: Prepared): NonNullable<Prepared['squashed']> {
  if (!p.squashed) {
    const cps = codePoints(p.blob.replace(/\s+/g, '').normalize('NFD'));
    const bigrams = new Map<number, number[]>();
    for (let q = 0; q + 1 < cps.length; q++) {
      const key = bigramKey(cps[q] as number, cps[q + 1] as number);
      const list = bigrams.get(key);
      if (list) list.push(q);
      else bigrams.set(key, [q]);
    }
    p.squashed = { cps, bigrams };
  }
  return p.squashed;
}

function wordsOf(p: Prepared): NonNullable<Prepared['words']> {
  if (!p.words) {
    const cps = fold(p.blob)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .map(codePoints);
    const byFirst = new Map<number, number[]>();
    cps.forEach((w, i) => {
      const list = byFirst.get(w[0] as number);
      if (list) list.push(i);
      else byFirst.set(w[0] as number, [i]);
    });
    p.words = { cps, byFirst };
  }
  return p.words;
}

/** One entry's source, made ready to match against any text. */
interface CompiledSource {
  exact(text: string): boolean;
  fuzzy: ((p: Prepared) => boolean) | null;
}

function compileSource(source: string): CompiledSource {
  let exact: (text: string) => boolean;
  if (HANGUL.test(source) && [...source].length <= 2) {
    exact = (text) => boundedHangulHit(source, text);
  } else if (UNSPACED.test(source)) {
    exact = (text) => text.includes(source);
  } else {
    const re = new RegExp(escapeRegExp(source), 'giu');
    exact = (text) => {
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const before = text[m.index - 1];
        const after = text[m.index + m[0].length];
        if ((!before || !WORD_CHAR.test(before)) && (!after || !WORD_CHAR.test(after))) {
          return true;
        }
        re.lastIndex = m.index + 1;
      }
      return false;
    };
  }
  return { exact, fuzzy: compileFuzzy(source) };
}

/**
 * Whether text nearly says `source` (a misheard name), as `partialSimilarity` /
 * `similarity` decide, but only where it can: a window of the text as alike as the threshold
 * shares at least 0.4·m − 1 of the needle's m − 1 letter pairs (each unmatched letter, in the
 * needle or the window, breaks at most one pair), placed within 0.2·m of where they are.
 */
function compileFuzzy(source: string): CompiledSource['fuzzy'] {
  if (UNSPACED.test(source)) {
    if ([...source].length < 3) return null;
    // Korean by its letters: two names a vowel apart differ in one letter, not one syllable.
    const needle = codePoints(source.replace(/\s+/g, '').normalize('NFD'));
    const m = needle.length;
    const keys = Array.from({ length: m - 1 }, (_, i) =>
      bigramKey(needle[i] as number, needle[i + 1] as number),
    );
    const minShared = Math.ceil(0.4 * m - 1 - 1e-9);
    const slack = Math.floor(0.2 * m);
    return (p) => {
      const { cps, bigrams } = squashedOf(p);
      const h = cps.length;
      if (h <= m) return (2 * lcsAt(needle, cps, 0, h)) / (m + h) >= UNSPACED_FUZZY;
      let shared = 0;
      for (const k of keys) if (bigrams.has(k)) shared++;
      if (shared < Math.max(1, minShared)) return false;
      const last = h - m;
      const tried = new Uint8Array(last + 1);
      for (let at = 0; at < keys.length; at++) {
        for (const q of bigrams.get(keys[at] as number) ?? []) {
          const from = Math.max(0, q - at - slack);
          const to = Math.min(last, q - at + slack);
          for (let w = from; w <= to; w++) {
            if (tried[w]) continue;
            tried[w] = 1;
            if (lcsAt(needle, cps, w, m) / m >= UNSPACED_FUZZY) return true;
          }
        }
      }
      return false;
    };
  }
  const s = fold(source);
  if ([...s.replace(/[^\p{L}]/gu, '')].length < 5) return null;
  const size = s.split(/\s+/).length;
  const needle = codePoints(s);
  return (p) => {
    const { cps, byFirst } = wordsOf(p);
    // Same first letter: names misheard keep their start far more often than not.
    for (const i of byFirst.get(needle[0] as number) ?? []) {
      if (i + size > cps.length) break;
      const parts = cps.slice(i, i + size);
      const len = parts.reduce((n, w) => n + w.length, 0) + size - 1;
      const candidate = new Int32Array(len);
      let at = 0;
      for (const w of parts) {
        if (at > 0) candidate[at++] = 32;
        candidate.set(w, at);
        at += w.length;
      }
      if ((2 * lcsAt(needle, candidate, 0, len)) / (needle.length + len) >= SPACED_FUZZY) {
        return true;
      }
    }
    return false;
  };
}

/** Whether `source` occurs in `text` (see the rules above). */
export function glossaryMatch(source: string, text: string, fuzzy = true): boolean {
  const s = source.trim();
  if (!s || !text) return false;
  const compiled = compileSource(s);
  if (compiled.exact(text)) return true;
  return fuzzy && !!compiled.fuzzy?.({ blob: text });
}

export interface GlossaryMatcher {
  /**
   * The entries `texts` (the line, then its context) use, in glossary order, one per target
   * (other spellings of the same name collapse to the first that matched), at most
   * `MAX_GLOSSARY_HITS`.
   */
  hits(texts: readonly string[], options?: { fuzzy?: boolean }): GlossaryEntry[];
}

/** Prepares every entry once (per glossary), so each request costs about one pass of its text. */
export function compileGlossary(entries: readonly GlossaryEntry[]): GlossaryMatcher {
  const compiled: (CompiledSource & GlossaryEntry)[] = [];
  for (const entry of entries) {
    const source = entry.source.trim();
    const target = entry.target.trim();
    if (!source || !target) continue;
    compiled.push({ source, target, ...compileSource(source) });
  }
  return {
    hits(texts, options = {}) {
      const fuzzy = options.fuzzy ?? true;
      const blob = texts.filter(Boolean).join(' ');
      if (!blob.trim()) return [];
      const prepared: Prepared = { blob };
      const out: GlossaryEntry[] = [];
      const targets = new Set<string>();
      for (const entry of compiled) {
        if (targets.has(entry.target)) continue;
        if (!entry.exact(blob) && !(fuzzy && entry.fuzzy?.(prepared))) continue;
        targets.add(entry.target);
        out.push({ source: entry.source, target: entry.target });
        if (out.length >= MAX_GLOSSARY_HITS) break;
      }
      return out;
    },
  };
}

/** `compileGlossary(entries).hits(texts, options)`, for one request. */
export function glossaryHits(
  entries: readonly GlossaryEntry[],
  texts: readonly string[],
  options: { fuzzy?: boolean } = {},
): GlossaryEntry[] {
  return compileGlossary(entries).hits(texts, options);
}
