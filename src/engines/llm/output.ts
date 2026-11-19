/**
 * Turning what the model wrote into a subtitle, and deciding when not to trust it.
 *
 * Cleaning (as the benchmark did, plus what a streaming subtitle needs): drop thinking blocks,
 * labels ("Translation:", "English:"), a `[xx] source =>` echo of the context format, one pair of
 * enclosing quotes, and keep the first non-empty line. An empty answer is "…" (what the prompt
 * asks for when a line is unintelligible).
 *
 * Checking: an answer is rejected (and the line goes to another translator) when it repeats an
 * earlier line's translation (models given context sometimes translate the context again): that
 * translation followed by more, or a long one said again whole for different words. Short lines
 * that mean the same ("Really?") pass. Also when it is far longer than the line could need (a
 * runaway that hit the token limit). Rejections carry no subtitle text (they reach logs).
 */

const THINK = /<think>[\s\S]*?<\/think>/g;
/** "Translation:", "English (US):", "Subtitle -" at the start. */
const LABEL =
  /^\s*(?:\*\*)?(?:translation|translated|subtitle|current|output|answer|english|[A-Z][a-z]+(?: [A-Z][a-z]+)?)(?: \([^)]{1,20}\))?(?:\*\*)?\s*[:：]\s*/i;
const LANGUAGE_TAG = /^\s*\[[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*\]\s*/;
const QUOTES: Record<string, string> = {
  '"': '"',
  "'": "'",
  '“': '”',
  '„': '“',
  '«': '»',
  '「': '」',
  '『': '』',
};

/** Removes a leading label, but only a known one or a language name followed by a colon. */
function stripLabel(text: string, labels: readonly string[]): string {
  const m = LABEL.exec(text);
  if (!m) return text;
  const word = m[0]
    .replace(/[*:：\s]/g, '')
    .replace(/\(.*\)/, '')
    .toLowerCase();
  const generic = ['translation', 'translated', 'subtitle', 'current', 'output', 'answer'];
  if (generic.includes(word) || labels.some((l) => l.toLowerCase().replace(/\s/g, '') === word)) {
    return text.slice(m[0].length);
  }
  return text;
}

export interface CleanOptions {
  /** Names a model may put before its answer as a label: the target language's ("English"). */
  labels?: readonly string[];
}

/**
 * The subtitle in `raw`. `partial`: the answer is still coming, so an opening quote may not have
 * its closing one yet, and an empty answer stays empty.
 */
export function cleanOutput(raw: string, options: CleanOptions = {}, partial = false): string {
  let t = raw.replace(THINK, '');
  if (t.includes('</think>')) t = t.slice(t.indexOf('</think>') + '</think>'.length);
  if (partial && t.includes('<think>')) return '';
  t = t.replace('<think>', '');
  const labels = options.labels ?? [];
  // The first line with text: a model sometimes adds a note on the next.
  const lines = t.split('\n').map((l) => l.trim());
  t = lines.find((l) => l !== '') ?? '';
  t = stripLabel(t, labels).trim();
  t = t.replace(LANGUAGE_TAG, '');
  // "source => translation": the context's format, echoed.
  const arrow = t.lastIndexOf('=>');
  if (arrow >= 0) t = t.slice(arrow + 2).trim();
  t = stripLabel(t, labels).trim();
  const open = t[0];
  const close = open ? QUOTES[open] : undefined;
  if (close) {
    if (t.length >= 2 && t.endsWith(close)) t = t.slice(1, -1).trim();
    // An apostrophe opens words ("'Cause"), not only quotes: only a matched pair goes.
    else if (open !== "'" && (partial || !t.slice(1).includes(close))) t = t.slice(1).trim();
  }
  if (!partial && t === '') return '…';
  return t;
}

export type OutputCheck = { ok: true } | { ok: false; reason: 'echo' | 'length'; detail: string };

export interface CheckInput {
  /** The line that was translated. */
  source: string;
  /** Earlier lines given as context. */
  context: readonly { source: string; translation: string }[];
  /** The generation stopped at its token limit. */
  hitLimit: boolean;
}

/** Letters and digits only, lower case: what "the same text" means here. */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Characters an answer may reasonably take for `source`: generous, but not unbounded. */
export function maxOutputChars(source: string): number {
  return Math.max(80, [...source].length * 8);
}

/**
 * An earlier translation said again whole, rather than a line that means the same: two short
 * lines often translate alike ("Really?", "That's right."), so only a long one counts.
 */
export const ECHO_MIN_CHARS = 20;

export function checkOutput(text: string, input: CheckInput): OutputCheck {
  const out = normalize(text);
  const src = normalize(input.source);
  for (const c of input.context) {
    const prev = normalize(c.translation);
    // Too short to tell an echo from a line that really says the same ("Yes.").
    if (prev.length < 6) continue;
    const prevSource = normalize(c.source);
    // The same words said again (or nearly) translate the same: not an echo.
    if (prevSource !== '' && (src.includes(prevSource) || changeShare(src, prevSource) < 0.3)) {
      continue;
    }
    // The real pattern: the earlier translation, then this line's (or more of it).
    const echoedPlus = prev.length >= 12 && out.length > prev.length && out.includes(prev);
    const echoedWhole = out === prev && prev.length >= ECHO_MIN_CHARS;
    if (echoedPlus || echoedWhole) {
      // No text in the detail: it goes to logs and the popup.
      return { ok: false, reason: 'echo', detail: 'repeated an earlier line' };
    }
  }
  if (input.hitLimit) {
    return { ok: false, reason: 'length', detail: 'ran on to its length limit' };
  }
  if ([...text].length > maxOutputChars(input.source)) {
    return { ok: false, reason: 'length', detail: 'wrote far more than the line says' };
  }
  return { ok: true };
}

/** How much two texts differ: the edit distance of their letters and digits, over the longer. */
export function changeShare(a: string, b: string): number {
  const x = [...normalize(a)];
  const y = [...normalize(b)];
  if (x.length === 0 && y.length === 0) return 0;
  let row = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const next = [i];
    for (let j = 1; j <= y.length; j++) {
      next[j] = Math.min(
        (row[j] as number) + 1,
        (next[j - 1] as number) + 1,
        (row[j - 1] as number) + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return (row[y.length] as number) / Math.max(x.length, y.length);
}

/** Least change (`changeShare`) for a revision to replace a line on screen. */
export const REVISION_MIN_CHANGE = 0.2;

/**
 * Whether `revised`, a new translation of a line already shown as `before`, is worth showing: it
 * changes the line materially, and doesn't take in the next line's translation (`next`) too.
 */
export function worthRevising(revised: string, before: string, next: string): boolean {
  const out = normalize(revised);
  if (out === '' || changeShare(revised, before) < REVISION_MIN_CHANGE) return false;
  const following = normalize(next);
  if (following.length >= 6 && out.includes(following)) return false;
  return out.length <= normalize(before).length * 2 + 16;
}
