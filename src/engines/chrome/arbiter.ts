/**
 * Picks which recognizer heard a segment. Chrome's on-device recognizers are one language each,
 * so `chrome-webspeech` runs one per spoken language on the same audio and, per speech segment,
 * keeps the transcript of the recognizer whose language was spoken. Pure, unit-tested.
 *
 * What was measured (Chrome 157, ko/ja/en/zh recognizers on mixed-language clips): the reported
 * confidence is always 1, so it says nothing. What does separate them:
 * - Activity: the right recognizer revises its text several times a second all through the
 *   speech (27–57 distinct interim texts over 6–16 s); wrong ones mostly emit a few fragments and
 *   stall (0–8), except Japanese and Korean, which hear each other's speech as plausible words.
 * - Coverage: the right transcript has about as many syllables / characters / letters as the
 *   speech is long; wrong ones are short ("예", "哇", "Which one").
 * - Script: wrong recognizers often fall back to other scripts (the Chinese recognizer writes
 *   English words for English or Korean speech).
 * - The text's language (Chrome's LanguageDetector), when the detector is there: separates
 *   Chinese from Japanese (shared characters). It can't spot a wrong recognizer's own-script
 *   output: Korean written for Japanese speech ("소토가와가" for 外側が) still reads as Korean 1.00.
 * - Japanese is counted in morae (kanji ≈ 2, katakana discounted): a Japanese recognizer hearing
 *   Korean writes katakana strings ("メキシコアリペラスポ"); real Japanese is mostly kanji and kana.
 * - Korean has final consonants (받침) on 35–50% of syllables; Korean written for Japanese speech
 *   has almost none (Japanese syllables are open: "음모와 소토가와가 그리 이로데" 1 in 17).
 * - Continuity: people mostly keep to one language, so the previous line's language gets a small
 *   edge when two recognizers are close.
 */
import { primaryLanguage } from '@/pipeline/language';

export interface Candidate {
  /** Recognizer language (BCP-47). */
  language: string;
  text: string;
  /** Distinct interim texts seen for this segment. */
  updates: number;
  /** What the text looks like to the language detector, when one ran. */
  detected?: { language: string; confidence: number } | null | undefined;
}

export interface Scored extends Candidate {
  score: number;
  coverage: number;
  activity: number;
  script: number;
}

/** Expected units per second of speech (syllables, morae, characters or letters), by language. */
const RATES: Record<string, number> = {
  ko: 5.5,
  ja: 7.5,
  zh: 4.5,
  th: 9,
  default: 13,
};

/** Interim updates per second at which activity counts as full. */
const FULL_ACTIVITY = 3;
/** Below this score nobody heard words (music, noise). */
export const MIN_SCORE = 0.12;
/** Edge for the previous line's language. */
const CONTINUITY = 1.05;

/**
 * Recognizers' text tidied for subtitles: the Japanese and Chinese recognizers put spaces between
 * words ("イラン で は"), which those languages don't use.
 */
export function cleanTranscript(text: string, language: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  const p = primaryLanguage(language);
  if (p !== 'ja' && p !== 'zh') return t;
  // Drop spaces next to CJK characters, keep them between Latin words.
  return t.replace(
    /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー、。])\s+|\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー、。])/gu,
    '',
  );
}

/** Share of Hangul syllables with a final consonant (받침), and how many syllables there are. */
export function finalConsonantShare(text: string): { share: number; syllables: number } {
  let syllables = 0;
  let closed = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0xac00 || code > 0xd7a3) continue;
    syllables++;
    if ((code - 0xac00) % 28 !== 0) closed++;
  }
  return { share: syllables ? closed / syllables : 0, syllables };
}

/**
 * How much a Korean line looks like Korean rather than another language's sounds written in
 * Hangul: 1 from 30% closed syllables, down to 0.3 at 16% or fewer. Short lines aren't judged.
 */
export function koreanShape(text: string): number {
  const { share, syllables } = finalConsonantShare(text);
  if (syllables < 6) return 1;
  return Math.min(1, Math.max(0.3, (share - 0.1) / 0.2));
}

/** Whether `language` is written with spaces between words. */
export function spacedScript(language: string): boolean {
  return !['ja', 'zh', 'th', 'lo', 'km', 'my'].includes(primaryLanguage(language));
}

/**
 * Units of speech in `text` written in `language`'s own script: syllables (Korean), characters
 * (Chinese), letters, or for Japanese approximate morae (kanji 2, hiragana 1, katakana 0.75).
 */
export function speechUnits(text: string, language: string): number {
  const p = primaryLanguage(language);
  let n = 0;
  for (const ch of text) {
    if (!inScript(ch, p)) continue;
    if (p === 'ja')
      n += /\p{Script=Han}/u.test(ch) ? 2 : /\p{Script=Katakana}/u.test(ch) ? 0.75 : 1;
    else n++;
  }
  return n;
}

/** Share of the letters in `text` that are in `language`'s script (1 when there are none). */
export function scriptShare(text: string, language: string): number {
  const p = primaryLanguage(language);
  let letters = 0;
  let own = 0;
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    letters++;
    if (inScript(ch, p)) own++;
  }
  return letters === 0 ? 1 : own / letters;
}

function inScript(ch: string, p: string): boolean {
  switch (p) {
    case 'ko':
      return /\p{Script=Hangul}/u.test(ch);
    case 'ja':
      return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]/u.test(ch);
    case 'zh':
      return /\p{Script=Han}/u.test(ch);
    case 'th':
      return /\p{Script=Thai}/u.test(ch);
    case 'ru':
    case 'uk':
      return /\p{Script=Cyrillic}/u.test(ch);
    case 'ar':
      return /\p{Script=Arabic}/u.test(ch);
    case 'hi':
      return /\p{Script=Devanagari}/u.test(ch);
    default:
      return /\p{Script=Latin}/u.test(ch);
  }
}

export function scoreCandidate(c: Candidate, speechMs: number, previous?: string | null): Scored {
  const p = primaryLanguage(c.language);
  const seconds = Math.max(0.5, speechMs / 1000);
  const expected = (RATES[p] ?? RATES.default ?? 13) * seconds;
  const coverage = Math.min(1.2, speechUnits(c.text, c.language) / expected);
  const activity = Math.min(1, c.updates / seconds / FULL_ACTIVITY);
  const script = scriptShare(c.text, c.language);
  let score = (0.55 * Math.min(1, coverage) + 0.45 * activity) * script;
  if (p === 'ko') score *= koreanShape(c.text);
  if (c.detected && c.detected.language !== 'und') {
    const agrees = primaryLanguage(c.detected.language) === p;
    if (agrees) score *= 1 + 0.15 * c.detected.confidence;
    else score *= 1 - 0.6 * c.detected.confidence;
  }
  if (previous && primaryLanguage(previous) === p) score *= CONTINUITY;
  if (c.text.trim() === '') score = 0;
  return { ...c, score, coverage, activity, script };
}

/** The candidate whose language was spoken, or null when none heard words. */
export function pickCandidate(
  candidates: readonly Candidate[],
  speechMs: number,
  /** The language of the previous line, if any. */
  previous: string | null = null,
): { winner: Scored | null; scored: Scored[] } {
  const scored = candidates
    .map((c) => scoreCandidate(c, speechMs, previous))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  return { winner: best && best.score >= MIN_SCORE ? best : null, scored };
}

/**
 * Where the not-yet-used text starts in `current`, a recognizer result whose start (`given`) was
 * already used for an earlier segment. Recognizers keep revising a result, so the end of `given`
 * is found by edit distance on letters and digits (case, spaces and punctuation ignored); when
 * the old start was rewritten altogether (a wrong-language guess the recognizer later replaced
 * with the real words) the whole result is unused; and in `spaced` scripts a cut inside a word
 * moves past it (its start was shown with the earlier line). Japanese, Chinese and Thai interims
 * have no spaces to find a word's end by.
 */
export function unusedFrom(current: string, given: string, spaced = true): number {
  const isWord = (ch: string) => /[\p{L}\p{N}]/u.test(ch);
  const want = [...given].filter(isWord).map((ch) => ch.toLowerCase());
  if (want.length === 0) return 0;
  const chars = [...current];
  // Positions of the letters and digits in `current`.
  const at: number[] = [];
  const have: string[] = [];
  chars.forEach((ch, i) => {
    if (isWord(ch)) {
      at.push(i);
      have.push(ch.toLowerCase());
    }
  });
  // Edit distance of `want` against every prefix of `have`; keep the best prefix.
  const n = want.length;
  let prev = Array.from({ length: n + 1 }, (_, k) => k);
  let best = { cost: n, prefix: 0 };
  for (let j = 1; j <= have.length; j++) {
    const row = [j];
    for (let k = 1; k <= n; k++) {
      const same = want[k - 1] === have[j - 1] ? 0 : 1;
      row[k] = Math.min(
        (prev[k] as number) + 1,
        (row[k - 1] as number) + 1,
        (prev[k - 1] as number) + same,
      );
    }
    prev = row;
    const cost = row[n] as number;
    if (cost < best.cost) best = { cost, prefix: j };
    if (j > n * 2 + 8) break;
  }
  if (best.prefix === 0 || best.cost > n * 0.4) return 0;
  let pos = (at[best.prefix - 1] as number) + 1;
  // Past the rest of a word cut in the middle.
  while (
    spaced &&
    pos < chars.length &&
    isWord(chars[pos] as string) &&
    isWord(chars[pos - 1] as string)
  ) {
    pos++;
  }
  return chars.slice(0, pos).join('').length;
}

/** When a candidate's text was written: from 20% to 80% of its final length, in samples. */
export interface Span {
  from: number;
  to: number;
}

/** The sample by which a candidate's text first reached `share` of its final length. */
export function textSpan(history: readonly { sample: number; length: number }[]): Span | null {
  const total = history.at(-1)?.length ?? 0;
  if (total === 0) return null;
  const reach = (share: number) => history.find((h) => h.length >= total * share)?.sample;
  const from = reach(0.2);
  const to = reach(0.8);
  return from === undefined || to === undefined ? null : { from, to };
}

/**
 * Whether `other` is a second language spoken in the same segment (a switch inside it that the
 * segmenter couldn't cut) rather than a wrong recognizer's take on the winner's speech:
 * - its text was written at another time than the winner's (mostly before or after it);
 * - together the two lines don't claim more speech than there was (a wrong recognizer writes
 *   over the same speech, so the coverages add up past the segment);
 * - it is substantial in its own script.
 */
export function isSwitch(
  winner: { coverage: number; span: Span | null },
  other: { coverage: number; script: number; updates: number; span: Span | null },
): boolean {
  const a = winner.span;
  const b = other.span;
  if (!a || !b) return false;
  if (other.coverage < 0.2 || other.script < 0.8 || other.updates < 4) return false;
  if (Math.min(1, winner.coverage) + other.coverage > 1.15) return false;
  const overlap = Math.min(a.to, b.to) - Math.max(a.from, b.from);
  const shorter = Math.max(1, Math.min(a.to - a.from, b.to - b.from));
  return overlap / shorter < 0.3;
}
