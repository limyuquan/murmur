/**
 * Lines that mix languages. A line the speech engine heard as the target language may still be
 * partly in another one (a speaker switching mid-sentence): such a line is translated, not shown
 * as it is. Pure, so it's unit-tested.
 *
 * - By script (`foreignPart`, at once): letters in scripts the target language isn't written in
 *   (Hangul for an English target; Latin for a Korean one; Hangul, Latin or kana for Chinese)
 *   make up a meaningful share of the line. Wide characters (Hangul, kana, Han) count double, as
 *   one carries about as much as two Latin letters. For a target not written in Latin, Latin
 *   words with a capital (names, brands: YouTube, iPhone) don't count, and it takes two others.
 * - By detector (`detectForeign`, async): for a line in the target's own script (French in an
 *   English line), Chrome's `LanguageDetector`, when the page has it, finds another language with
 *   a meaningful confidence.
 *
 * A line wholly in the target language stays untranslated.
 */
import { type LanguageTag, UNKNOWN_LANGUAGE } from '@/engines/types';
import { primaryLanguage, sameLanguage } from './language';

export type Script =
  | 'latin'
  | 'hangul'
  | 'kana'
  | 'han'
  | 'cyrillic'
  | 'greek'
  | 'arabic'
  | 'hebrew'
  | 'thai'
  | 'devanagari';

/** The script of a letter, or null for anything else (digits, punctuation, other scripts). */
export function scriptOf(ch: string): Script | null {
  const cp = ch.codePointAt(0) ?? 0;
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return 'latin';
  if (cp >= 0xc0 && cp <= 0x24f && cp !== 0xd7 && cp !== 0xf7) return 'latin';
  if (cp >= 0x1e00 && cp <= 0x1eff) return 'latin';
  if ((cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0x1100 && cp <= 0x11ff)) return 'hangul';
  if (cp >= 0x3131 && cp <= 0x318e) return 'hangul';
  if ((cp >= 0x3041 && cp <= 0x309f) || (cp >= 0x30a0 && cp <= 0x30ff && cp !== 0x30fb)) {
    return 'kana';
  }
  if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) return 'han';
  if (cp >= 0xf900 && cp <= 0xfaff) return 'han';
  if (cp >= 0x400 && cp <= 0x4ff) return 'cyrillic';
  if (cp >= 0x370 && cp <= 0x3ff) return 'greek';
  if (cp >= 0x600 && cp <= 0x6ff) return 'arabic';
  if (cp >= 0x590 && cp <= 0x5ff) return 'hebrew';
  if (cp >= 0xe00 && cp <= 0xe7f) return 'thai';
  if (cp >= 0x900 && cp <= 0x97f) return 'devanagari';
  return null;
}

const SCRIPTS_OF: Record<string, readonly Script[]> = {
  ko: ['hangul'],
  ja: ['kana', 'han'],
  zh: ['han'],
  yue: ['han'],
  ru: ['cyrillic'],
  uk: ['cyrillic'],
  be: ['cyrillic'],
  bg: ['cyrillic'],
  sr: ['cyrillic', 'latin'],
  mk: ['cyrillic'],
  kk: ['cyrillic'],
  mn: ['cyrillic'],
  el: ['greek'],
  ar: ['arabic'],
  fa: ['arabic'],
  ur: ['arabic'],
  he: ['hebrew'],
  yi: ['hebrew'],
  th: ['thai'],
  hi: ['devanagari'],
  mr: ['devanagari'],
  ne: ['devanagari'],
};

/** Scripts `language` is written in (Latin unless known otherwise). */
export function scriptsOf(language: LanguageTag): readonly Script[] {
  return SCRIPTS_OF[primaryLanguage(language)] ?? ['latin'];
}

/** The language a script means on its own, when it means just one. */
const ONLY_LANGUAGE: Partial<Record<Script, LanguageTag>> = {
  hangul: 'ko',
  kana: 'ja',
  greek: 'el',
  hebrew: 'he',
  thai: 'th',
};

const WIDE: ReadonlySet<Script> = new Set(['hangul', 'kana', 'han']);

/** Share of a line's letters (wide ones counted double) that must be foreign. */
export const MIXED_SHARE = 0.2;
/** Least foreign weight that counts: two wide characters, or four letters. */
export const MIXED_MIN_WEIGHT = 4;

export interface ForeignPart {
  /** The language of the foreign part, or `und` when the script doesn't say. */
  language: LanguageTag;
  /** Its share of the line's letters (wide ones counted double). */
  share: number;
}

/**
 * The part of `text` written in scripts `target` isn't written in, when it is a meaningful share
 * of the line; null otherwise. `spoken` (the languages the person hears) names the part's
 * language when its script alone doesn't.
 */
export function foreignPart(
  text: string,
  target: LanguageTag,
  spoken: readonly LanguageTag[] = [],
): ForeignPart | null {
  const own = new Set(scriptsOf(target));
  // Latin words in a line whose target isn't written in Latin: names (YouTube, iPhone, BTS)
  // don't count, and it takes two other words to count at all.
  const skipped = own.has('latin') ? null : brandLetters(text);
  const weights = new Map<Script, number>();
  let total = 0;
  for (const ch of skipped?.text ?? text) {
    const script = scriptOf(ch);
    if (!script) continue;
    const w = WIDE.has(script) ? 2 : 1;
    total += w;
    if (!own.has(script)) weights.set(script, (weights.get(script) ?? 0) + w);
  }
  if (skipped && skipped.words < 2) weights.delete('latin');
  let foreign = 0;
  let main: Script | null = null;
  for (const [script, w] of weights) {
    foreign += w;
    if (!main || w > (weights.get(main) ?? 0)) main = script;
  }
  if (!main || foreign < MIXED_MIN_WEIGHT || foreign / total < MIXED_SHARE) return null;
  return { language: languageOfScript(main, weights, target, spoken), share: foreign / total };
}

/** A Latin word with a capital after its first letter (iPhone, YouTube, BTS) or a name. */
const BRAND = /^(?:\p{Lu}.*|.+\p{Lu}.*)$/u;
const LATIN_WORD = /[A-Za-z\u00c0-\u024f\u1e00-\u1eff]+(?:['’][A-Za-z]+)*/g;

/**
 * `text` without its Latin words that look like names or brands (any capital letter: YouTube,
 * iPhone, Netflix, BTS), and how many other Latin words it has.
 */
function brandLetters(text: string): { text: string; words: number } {
  let words = 0;
  const rest = text.replace(LATIN_WORD, (word) => {
    if (BRAND.test(word)) return ' ';
    words++;
    return word;
  });
  return { text: rest, words };
}

function languageOfScript(
  script: Script,
  weights: ReadonlyMap<Script, number>,
  target: LanguageTag,
  spoken: readonly LanguageTag[],
): LanguageTag {
  if (script === 'han' && weights.has('kana')) return 'ja';
  const only = ONLY_LANGUAGE[script];
  if (only) return only;
  // A spoken language written in that script, other than the target.
  const named = spoken.find((l) => !sameLanguage(l, target) && scriptsOf(l).includes(script));
  if (named) return named;
  if (script === 'han') return 'zh';
  return UNKNOWN_LANGUAGE;
}

/** Ranked guesses for a text's language (Chrome's `LanguageDetector`). */
export type DetectLanguages = (
  text: string,
) => Promise<readonly { language: LanguageTag; confidence: number }[]>;

/** Confidence at which the detector's other language counts as part of the line. */
export const DETECTOR_SHARE = 0.3;
/** Fewer letters than this say too little for a detector. */
export const DETECTOR_MIN_LETTERS = 12;

/**
 * Another language the detector hears in `text`, a line in the target's own script; null when it
 * finds only the target (or the line is too short to tell).
 */
export async function detectForeign(
  text: string,
  target: LanguageTag,
  detect: DetectLanguages,
): Promise<LanguageTag | null> {
  let letters = 0;
  for (const ch of text) if (scriptOf(ch)) letters++;
  if (letters < DETECTOR_MIN_LETTERS) return null;
  const ranked = await detect(text);
  const other = ranked.find(
    (r) =>
      r.language !== UNKNOWN_LANGUAGE &&
      !sameLanguage(r.language, target) &&
      r.confidence >= DETECTOR_SHARE,
  );
  return other?.language ?? null;
}
