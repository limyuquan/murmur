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

/** `source` as a whole word (or words) in `text`, any case. */
function wordHit(source: string, text: string): boolean {
  const re = new RegExp(escapeRegExp(source), 'giu');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text[m.index - 1];
    const after = text[m.index + m[0].length];
    if ((!before || !WORD_CHAR.test(before)) && (!after || !WORD_CHAR.test(after))) return true;
    re.lastIndex = m.index + 1;
  }
  return false;
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

/** Whether text nearly says `source` (a misheard name). */
function fuzzyHit(source: string, text: string): boolean {
  if (UNSPACED.test(source)) {
    if ([...source].length < 3) return false;
    // Korean by its letters: two names a vowel apart differ in one letter, not one syllable.
    const squashed = text.replace(/\s+/g, '').normalize('NFD');
    return partialSimilarity(source.replace(/\s+/g, '').normalize('NFD'), squashed) >= 0.8;
  }
  const s = fold(source);
  if ([...s.replace(/[^\p{L}]/gu, '')].length < 5) return false;
  const size = s.split(/\s+/).length;
  const words = fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  for (let i = 0; i + size <= words.length; i++) {
    const candidate = words.slice(i, i + size).join(' ');
    // Same first letter: names misheard keep their start far more often than not.
    if (candidate[0] === s[0] && similarity(s, candidate) >= 0.85) return true;
  }
  return false;
}

/** Whether `source` occurs in `text` (see the rules above). */
export function glossaryMatch(source: string, text: string, fuzzy = true): boolean {
  const s = source.trim();
  if (!s || !text) return false;
  let hit: boolean;
  if (HANGUL.test(s) && [...s].length <= 2) hit = boundedHangulHit(s, text);
  else if (UNSPACED.test(s)) hit = text.includes(s);
  else hit = wordHit(s, text);
  return hit || (fuzzy && fuzzyHit(s, text));
}

/**
 * The entries `texts` (the line, then its context) use, in glossary order, one per target (other
 * spellings of the same name collapse to the first that matched), at most `MAX_GLOSSARY_HITS`.
 */
export function glossaryHits(
  entries: readonly GlossaryEntry[],
  texts: readonly string[],
  options: { fuzzy?: boolean } = {},
): GlossaryEntry[] {
  const fuzzy = options.fuzzy ?? true;
  const blob = texts.filter(Boolean).join(' ');
  if (!blob.trim()) return [];
  const out: GlossaryEntry[] = [];
  const targets = new Set<string>();
  for (const entry of entries) {
    const source = entry.source.trim();
    const target = entry.target.trim();
    if (!source || !target || targets.has(target)) continue;
    if (!glossaryMatch(source, blob, fuzzy)) continue;
    targets.add(target);
    out.push({ source, target });
    if (out.length >= MAX_GLOSSARY_HITS) break;
  }
  return out;
}
