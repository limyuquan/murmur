/**
 * Stray lines: a word or two of noise (laughter, a shout, music under chatter) that the speech
 * engine heard as some language nobody speaks in the video, shown with that language's tag. A
 * line is stray when all of these hold:
 *
 * - it is short: under `maxSpeechS` of speech, or at most `maxTokens` words;
 * - its language is known and expected nowhere: not one of the spoken languages, not the target
 *   or the language asked for, and not heard on a line shown earlier in the session (so a switch to another language keeps
 *   showing once it has been heard: code-switching is never cut);
 * - the engine is not sure of that language (below `trustConfidence`).
 *
 * Pure: the pipeline keeps the session's languages and drops what this says is stray.
 */
import { type DetectedLanguage, type LanguageTag, UNKNOWN_LANGUAGE } from '@/engines/types';
import { primaryLanguage } from './language';

export const STRAY = {
  maxSpeechS: 1.2,
  maxTokens: 2,
  trustConfidence: 0.9,
} as const;

export interface StrayCheck {
  text: string;
  language: DetectedLanguage | null;
  /** Length of the speech the line covers, seconds. */
  speechS: number;
  /** The spoken languages, the target and the language asked for, if any (any tags). */
  expected: readonly LanguageTag[];
  /** Primary tags of languages on lines shown earlier in the session. */
  heard: ReadonlySet<string>;
}

export function isStray(line: StrayCheck): boolean {
  const lang = line.language ? primaryLanguage(line.language.tag) : '';
  if (!lang || lang === UNKNOWN_LANGUAGE) return false;
  if (line.heard.has(lang) || line.expected.some((t) => primaryLanguage(t) === lang)) return false;
  if (line.language && line.language.confidence >= STRAY.trustConfidence) return false;
  return line.speechS < STRAY.maxSpeechS || countWords(line.text, lang) <= STRAY.maxTokens;
}

const segmenters = new Map<string, Intl.Segmenter>();

/** Words in `text` (scripts without spaces too), punctuation not counted. */
export function countWords(text: string, lang: string): number {
  let segmenter = segmenters.get(lang);
  if (!segmenter) {
    try {
      segmenter = new Intl.Segmenter(lang, { granularity: 'word' });
    } catch {
      segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    }
    segmenters.set(lang, segmenter);
  }
  let n = 0;
  for (const s of segmenter.segment(text)) if (s.isWordLike) n++;
  return n;
}
