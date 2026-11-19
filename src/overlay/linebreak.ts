/**
 * Subtitle line breaking and reading time, pure. Follows the usual timed-text rules:
 *
 * - At most two lines on screen; a line holds about 42 characters, or 16 full-width (CJK) ones.
 *   Full-width characters weigh `FULLWIDTH_UNITS`, so one budget covers every script.
 * - Text that fits on one line stays on one line.
 * - Two lines are balanced, a little bottom-heavy, and prefer to break after punctuation. Never
 *   between a word and the punctuation that follows it, and in CJK text never before closing
 *   punctuation or small kana, or after opening brackets.
 * - Text that is still growing (a partial result) is filled greedily instead, so words already on
 *   screen never move as more arrive; only the last two lines are shown.
 * - Finished text longer than two lines is split into pages, at sentence ends where possible, each
 *   held for its reading time.
 *
 * Word boundaries come from `Intl.Segmenter`, which also handles scripts written without spaces.
 */

/** Line budget in units: one unit per narrow character. */
export const MAX_LINE_UNITS = 42;
/** Weight of a full-width character: 16 of them fill a line. */
export const FULLWIDTH_UNITS = MAX_LINE_UNITS / 16;
export const MAX_LINES = 2;

/** Width of `text` in px (or any unit `maxWidth` uses). */
export type Measure = (text: string) => number;

export interface FitOptions {
  /** Units per line, at most `MAX_LINE_UNITS`. */
  maxUnits: number;
  /** Optional rendered-width limit, in the measure's unit. */
  maxWidth?: number;
  measure?: Measure;
  /** BCP-47 tag of the text, for word segmentation. */
  lang?: string;
}

// ---------------------------------------------------------------------------------------------
// Character classes

/** CJK ideographs, kana, Hangul, full-width forms and CJK punctuation. */
const FULLWIDTH = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;
/** Scripts written without spaces between words: a line may break between any two words. */
const NO_SPACE = /[⺀-〾ぁ-㏿㐀-䶿一-鿿豈-﫿＀-｠฀-๿຀-໿က-႟ក-៿]/u;
/** Never at the start of a line (closing punctuation, small kana, prolonged sound mark). */
const NO_START =
  /^[)\]}>,.!?:;%'"”’»›、。，．・：；？！ー〜～」』）】〕〉》〙〗｝ゝゞヽヾぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ々〻‐゠–]/u;
/** Never at the end of a line (opening brackets and quotes). */
const NO_END = /[([{<"'“‘«‹「『（【〔〈《〘〖｛]$/u;
const SENTENCE_END = /[.!?…。！？]["'”’」』）)]*$/u;
const CLAUSE_END = /[,;:、，；：—–-]["'”’」』）)]*$/u;

/** Display width of `text` in units. */
export function textUnits(text: string): number {
  let units = 0;
  for (const ch of text) units += FULLWIDTH.test(ch) ? FULLWIDTH_UNITS : 1;
  return units;
}

// ---------------------------------------------------------------------------------------------
// Atoms: unbreakable pieces of text with the separator that goes before them on a line

interface Atom {
  text: string;
  /** `' '` when a space separates it from the previous atom, `''` when they touch. */
  sep: string;
}

const segmenters = new Map<string, Intl.Segmenter | null>();

function segmenter(lang: string | undefined): Intl.Segmenter | null {
  const key = lang ?? '';
  if (!segmenters.has(key)) {
    let s: Intl.Segmenter | null = null;
    try {
      s = new Intl.Segmenter(lang && lang !== 'und' ? lang : undefined, { granularity: 'word' });
    } catch {
      s = null;
    }
    segmenters.set(key, s);
  }
  return segmenters.get(key) ?? null;
}

/** Collapses whitespace runs to one space and trims. */
export function normalizeSpace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** Splits text into atoms: a line may break only between two atoms. */
function toAtoms(text: string, lang: string | undefined): Atom[] {
  const clean = normalizeSpace(text);
  if (!clean) return [];
  const seg = segmenter(lang);
  const pieces: string[] = seg
    ? Array.from(seg.segment(clean), (s) => s.segment)
    : clean.split(/(\s)/u).flatMap((p) => (NO_SPACE.test(p) ? Array.from(p) : [p]));

  const atoms: Atom[] = [];
  let pendingSpace = false;
  for (const piece of pieces) {
    if (piece === '') continue;
    if (/^\s+$/u.test(piece)) {
      pendingSpace = atoms.length > 0;
      continue;
    }
    const prev = atoms[atoms.length - 1];
    if (prev && !pendingSpace && !canBreakBetween(prev.text, piece)) {
      prev.text += piece;
    } else {
      atoms.push({ text: piece, sep: pendingSpace ? ' ' : '' });
    }
    pendingSpace = false;
  }
  return atoms;
}

/**
 * Whether a line may break between two touching pieces (no space between them): only where one
 * side is in a script written without spaces, and never against punctuation that must stay put.
 */
function canBreakBetween(before: string, after: string): boolean {
  if (NO_START.test(after) || NO_END.test(before)) return false;
  const last = Array.from(before).pop() ?? '';
  const first = Array.from(after)[0] ?? '';
  return NO_SPACE.test(last) || NO_SPACE.test(first);
}

function join(atoms: readonly Atom[], from: number, to: number): string {
  let out = '';
  for (let i = from; i < to; i++) {
    const a = atoms[i] as Atom;
    out += i === from ? a.text : a.sep + a.text;
  }
  return out;
}

function fits(line: string, o: FitOptions): boolean {
  if (textUnits(line) > o.maxUnits) return false;
  if (o.measure && o.maxWidth !== undefined && o.measure(line) > o.maxWidth) return false;
  return true;
}

/** Splits atoms that can't fit on a line by themselves (long URLs, compounds) into characters. */
function splitOversize(atoms: Atom[], o: FitOptions): Atom[] {
  const out: Atom[] = [];
  for (const a of atoms) {
    if (fits(a.text, o)) {
      out.push(a);
      continue;
    }
    let chunk = '';
    let sep = a.sep;
    for (const ch of a.text) {
      if (chunk && !fits(chunk + ch, o)) {
        out.push({ text: chunk, sep });
        chunk = '';
        sep = '';
      }
      chunk += ch;
    }
    if (chunk) out.push({ text: chunk, sep });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Line layouts

/**
 * Greedy fill: every line takes as many atoms as fit. Adding text at the end never changes
 * earlier lines, so growing (partial) text doesn't jump around.
 */
export function greedyLines(text: string, o: FitOptions): string[] {
  const atoms = splitOversize(toAtoms(text, o.lang), o);
  const lines: string[] = [];
  let start = 0;
  for (let i = 1; i <= atoms.length; i++) {
    if (i === atoms.length || !fits(join(atoms, start, i + 1), o)) {
      lines.push(join(atoms, start, i));
      start = i;
    }
  }
  return lines;
}

/** The last `MAX_LINES` lines of greedy fill: what a growing line shows. */
export function tailLines(text: string, o: FitOptions): string[] {
  return greedyLines(text, o).slice(-MAX_LINES);
}

/**
 * The best one- or two-line layout of `atoms[from, to)`, or null when it needs more than two lines.
 */
function bestTwo(atoms: readonly Atom[], from: number, to: number, o: FitOptions): string[] | null {
  const whole = join(atoms, from, to);
  if (fits(whole, o)) return [whole];
  let best: string[] | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  const total = textUnits(whole);
  for (let k = from + 1; k < to; k++) {
    const top = join(atoms, from, k);
    const bottom = join(atoms, k, to);
    if (!fits(top, o) || !fits(bottom, o)) continue;
    const t = textUnits(top);
    const b = textUnits(bottom);
    let cost = Math.abs(t - b) / Math.max(1, total);
    // Bottom-heavy reads better (the eye lands on the longer line last); a little only.
    if (t > b) cost += 0.08;
    // Keep phrases together: break after punctuation when there is some, and not right after a
    // short lowercase word (articles, prepositions: "the", "at", "de").
    if (SENTENCE_END.test(top)) cost -= 0.5;
    else if (CLAUSE_END.test(top)) cost -= 0.4;
    else if (/(^|\s)\p{Ll}{1,3}$/u.test(top)) cost += 0.12;
    // Avoid a lone short word on either line.
    if (k - from === 1 && t < 8) cost += 0.3;
    if (to - k === 1 && b < 8) cost += 0.3;
    if (cost < bestCost) {
      bestCost = cost;
      best = [top, bottom];
    }
  }
  return best;
}

/** Finished text that fits in two lines, laid out for reading. Null when it needs more. */
export function balancedLines(text: string, o: FitOptions): string[] | null {
  const atoms = splitOversize(toAtoms(text, o.lang), o);
  if (atoms.length === 0) return [];
  return bestTwo(atoms, 0, atoms.length, o);
}

/**
 * Finished text as pages of at most two lines. Chooses the cuts with the fewest pages and the most
 * natural ends: a sentence end is best, then a clause end; very short pages cost a little extra.
 */
export function paginate(text: string, o: FitOptions): string[][] {
  const atoms = splitOversize(toAtoms(text, o.lang), o);
  const n = atoms.length;
  if (n === 0) return [];
  // cost[i]: best cost of paging atoms[i, n); next[i]: where the first page from i ends.
  const cost = new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY);
  const next = new Array<number>(n + 1).fill(n);
  cost[n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = i + 1; j <= n; j++) {
      // Pages only get harder to fit as they grow.
      if (!bestTwo(atoms, i, j, o)) break;
      const end = (atoms[j - 1] as Atom).text;
      const endCost = j === n || SENTENCE_END.test(end) ? 0 : CLAUSE_END.test(end) ? 0.6 : 3;
      const short = textUnits(join(atoms, i, j)) < 20 && j < n ? 0.5 : 0;
      const c = 1 + endCost + short + (cost[j] as number);
      if (c < (cost[i] as number)) {
        cost[i] = c;
        next[i] = j;
      }
    }
  }
  const pages: string[][] = [];
  for (let i = 0; i < n; i = next[i] as number) {
    const j = next[i] as number;
    pages.push(bestTwo(atoms, i, j, o) ?? [join(atoms, i, j)]);
  }
  return pages;
}

// ---------------------------------------------------------------------------------------------
// Reading time

/** Characters per second by script: rough adult reading speeds for subtitles. */
const READING_CPS = { han: 9, kana: 6, hangul: 12, other: 17 } as const;
const HAN = /[⺀-⿟々㐀-䶿一-鿿豈-﫿]/u;
const KANA = /[ぁ-ヿㇰ-ㇿｦ-ﾟ]/u;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/u;

export const MIN_DISPLAY_MS = 1000;
export const MAX_DISPLAY_MS = 7000;
/** Time to find the text and start reading. */
const SETTLE_MS = 300;

/** How long `text` needs on screen to be read: at least 1 s, at most 7 s. */
export function readingMs(text: string): number {
  let seconds = 0;
  for (const ch of normalizeSpace(text)) {
    if (HAN.test(ch)) seconds += 1 / READING_CPS.han;
    else if (KANA.test(ch)) seconds += 1 / READING_CPS.kana;
    else if (HANGUL.test(ch)) seconds += 1 / READING_CPS.hangul;
    else seconds += 1 / READING_CPS.other;
  }
  return Math.round(Math.min(MAX_DISPLAY_MS, Math.max(MIN_DISPLAY_MS, SETTLE_MS + seconds * 1000)));
}

/** Line budget for a box `widthPx` wide at `fontPx`: the guideline, or fewer if the box is narrow. */
export function unitsForWidth(widthPx: number, fontPx: number): number {
  // A narrow character averages about half an em in common UI fonts.
  const fit = Math.floor(widthPx / (fontPx * 0.5));
  return Math.max(8, Math.min(MAX_LINE_UNITS, fit));
}
