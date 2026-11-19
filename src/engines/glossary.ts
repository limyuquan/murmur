/**
 * The person's glossary: names and terms with the rendering they want (`source → target`). An
 * entry may have other ways it is said or misheard (`aliases`, any script) and a short note for
 * the translator. A translator that uses one (`usesGlossary`) gets only the entries a line needs:
 * those with a source or alias that occurs in the line or the earlier lines given as context,
 * each as the alias that matched (`alias = rendering`). Fewer entries keep the prompt short and
 * keep the model from reaching for a name nobody said.
 *
 * Matching:
 * - Words in scripts written with spaces (Latin, Cyrillic, ...): whole words, any case.
 * - Scripts written without spaces (Chinese, Japanese, Korean, Thai): anywhere in the text,
 *   except that a Korean name of one or two syllables must stand alone or be followed by a
 *   particle, so a short name doesn't match inside a longer word.
 * - Light fuzzy matching for names speech recognition misheard: a source of 3+ characters (5+
 *   letters in spaced scripts) also matches text that is nearly the same, letter by letter
 *   (Korean compared by its letters, jamo, not whole syllables).
 */

export interface GlossaryEntry {
  /** As it is said (or as speech recognition writes it). */
  source: string;
  /** How it should appear in the translation. */
  target: string;
  /** Other ways it is said or written by speech recognition. */
  aliases?: string[];
  /** A short note for the translator ("a band", "a dish"). */
  note?: string;
}

/** One entry a line uses: `source` is the alias (or source) that matched. */
export interface GlossaryHit {
  source: string;
  target: string;
  note?: string;
}

/** The entry's source and aliases, trimmed, empty ones and repeats left out. */
export function entrySources(entry: GlossaryEntry): string[] {
  const out: string[] = [];
  for (const raw of [entry.source, ...(entry.aliases ?? [])]) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Most entries a single line is given. */
export const MAX_GLOSSARY_HITS = 24;

const HANGUL = /[가-힣]/;
/** Scripts written without spaces between words. */
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const NON_WORD = /[^\p{L}\p{N}\p{M}]+/u;

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

/** Which letters `cps` has, hashed into 32 bits. */
function maskOf(cps: Int32Array): number {
  let mask = 0;
  for (let i = 0; i < cps.length; i++) mask |= 1 << ((cps[i] as number) & 31);
  return mask;
}

/** How many letters of `cps` are in `mask`: at least their longest common subsequence. */
function inMask(cps: Int32Array, mask: number): number {
  let n = 0;
  for (let i = 0; i < cps.length; i++) if (mask & (1 << ((cps[i] as number) & 31))) n++;
  return n;
}

/** The text of one request, prepared once for every entry. */
interface Prepared {
  blob: string;
  /** The text in lower case, when that keeps every position (`lowerOf`), and its words. */
  lower?: { text: string; words: Set<string> } | null;
  /** Unspaced fuzzy matching: the text without spaces, decomposed, and its bigrams' positions. */
  squashed?: { cps: Int32Array; bigrams: Map<number, number[]> };
  /**
   * Spaced fuzzy matching: folded words, where each first letter starts one, and the runs of
   * words compared so far (by first word and count), joined by spaces.
   */
  words?: { cps: Int32Array[]; byFirst: Map<number, number[]>; runs: Map<number, Int32Array> };
}

/** Characters that match others only under a regular expression's case folding. */
const FOLD_ONLY = /[\u017f\u212a\u2126\u1e9e\u0130]/u;

/**
 * The text in lower case, or null when lower case changes its length or it holds a character
 * case folding treats otherwise: then `includes` can't stand in for a case-blind search.
 */
function lowerOf(p: Prepared): Prepared['lower'] {
  if (p.lower === undefined) {
    const text = p.blob.toLowerCase();
    p.lower =
      text.length === p.blob.length && !FOLD_ONLY.test(p.blob)
        ? { text, words: new Set(text.split(NON_WORD)) }
        : null;
  }
  return p.lower;
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
    p.words = { cps, byFirst, runs: new Map() };
  }
  return p.words;
}

/** One entry's source, made ready to match against any text. */
interface CompiledSource {
  exact(p: Prepared): boolean;
  fuzzy: ((p: Prepared) => boolean) | null;
}

function compileSource(source: string): CompiledSource {
  let exact: (p: Prepared) => boolean;
  if (HANGUL.test(source) && [...source].length <= 2) {
    exact = (p) => boundedHangulHit(source, p.blob);
  } else if (UNSPACED.test(source)) {
    exact = (p) => p.blob.includes(source);
  } else {
    const re = new RegExp(escapeRegExp(source), 'giu');
    const lowerSource = source.toLowerCase();
    const canFilter = lowerSource.length === source.length && !FOLD_ONLY.test(source);
    // A match starts and ends at word edges, so a source's first word is a whole word there.
    const head = WORD_CHAR.test(lowerSource[0] ?? '') ? (lowerSource.split(NON_WORD)[0] ?? '') : '';
    exact = (p) => {
      // Most sources aren't in the text at all: plain lookups say so far faster.
      const lower = canFilter ? lowerOf(p) : null;
      if (lower) {
        if (head && !lower.words.has(head)) return false;
        if (!lower.text.includes(lowerSource)) return false;
      }
      const text = p.blob;
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
  const n = needle.length;
  const needleMask = maskOf(needle);
  return (p) => {
    const { cps, byFirst, runs } = wordsOf(p);
    // Same first letter: names misheard keep their start far more often than not.
    for (const i of byFirst.get(needle[0] as number) ?? []) {
      if (i + size > cps.length) break;
      let len = size - 1;
      for (let k = i; k < i + size; k++) len += (cps[k] as Int32Array).length;
      // The best a length allows (all of the shorter one in common) falls short.
      if ((2 * Math.min(n, len)) / (n + len) < SPACED_FUZZY) continue;
      let candidate = size === 1 ? (cps[i] as Int32Array) : runs.get(i * 64 + size);
      if (!candidate) {
        candidate = new Int32Array(len);
        let at = 0;
        for (let k = i; k < i + size; k++) {
          if (at > 0) candidate[at++] = 32;
          candidate.set(cps[k] as Int32Array, at);
          at += (cps[k] as Int32Array).length;
        }
        runs.set(i * 64 + size, candidate);
      }
      // A cheap bound first: letters of each that the other has at all.
      const bound = Math.min(inMask(needle, maskOf(candidate)), inMask(candidate, needleMask));
      if ((2 * bound) / (n + len) < SPACED_FUZZY) continue;
      if ((2 * lcsAt(needle, candidate, 0, len)) / (n + len) >= SPACED_FUZZY) {
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
  const prepared: Prepared = { blob: text };
  if (compiled.exact(prepared)) return true;
  return fuzzy && !!compiled.fuzzy?.(prepared);
}

export interface GlossaryMatcher {
  /**
   * The entries `texts` (the line, then its context) use, in glossary order, one per target
   * (other entries for the same rendering collapse to the first that matched), at most
   * `MAX_GLOSSARY_HITS`. Each comes as the alias that matched: the first that occurs exactly,
   * else the first that occurs nearly.
   */
  hits(texts: readonly string[], options?: { fuzzy?: boolean }): GlossaryHit[];
}

interface CompiledEntry {
  target: string;
  note: string;
  sources: (CompiledSource & { text: string })[];
}

/** Prepares every entry once (per glossary), so each request costs about one pass of its text. */
export function compileGlossary(entries: readonly GlossaryEntry[]): GlossaryMatcher {
  const compiled: CompiledEntry[] = [];
  for (const entry of entries) {
    const target = entry.target.trim();
    const sources = entrySources(entry);
    if (sources.length === 0 || !target) continue;
    compiled.push({
      target,
      note: entry.note?.trim() ?? '',
      sources: sources.map((text) => ({ text, ...compileSource(text) })),
    });
  }
  return {
    hits(texts, options = {}) {
      const fuzzy = options.fuzzy ?? true;
      const blob = texts.filter(Boolean).join(' ');
      if (!blob.trim()) return [];
      const prepared: Prepared = { blob };
      const out: GlossaryHit[] = [];
      const targets = new Set<string>();
      for (const entry of compiled) {
        if (targets.has(entry.target)) continue;
        let matched = entry.sources.find((s) => s.exact(prepared));
        if (!matched && fuzzy) matched = entry.sources.find((s) => s.fuzzy?.(prepared));
        if (!matched) continue;
        targets.add(entry.target);
        out.push({
          source: matched.text,
          target: entry.target,
          ...(entry.note ? { note: entry.note } : {}),
        });
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
): GlossaryHit[] {
  return compileGlossary(entries).hits(texts, options);
}
