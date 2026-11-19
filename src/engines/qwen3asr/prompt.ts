/**
 * Qwen3-ASR's prompt and answer, as token ids (pure, so it's unit-tested).
 *
 * Prompt (the official chat template with an empty system prompt):
 *
 *   <|im_start|>system\n<|im_end|>\n<|im_start|>user\n<|audio_start|> [A × <|audio_pad|>]
 *   <|audio_end|><|im_end|>\n<|im_start|>assistant\n
 *
 * The A pad rows are replaced by the audio encoder's output. The model answers
 * `language <Name><asr_text><text>`, or `language None` when it hears no speech. Text forced after
 * the prompt (a language, or the start of an earlier answer) is generated as if the model wrote
 * it, so decoding carries on from there.
 */
import type { TokenDecoder } from './tokenizer';

export const PREFIX = [151644, 9125, 198, 151645, 198, 151644, 882, 198, 151669] as const;
export const SUFFIX = [151670, 151645, 198, 151644, 77091, 198] as const;
export const AUDIO_PAD = 151676;
export const ASR_TEXT = 151704;
/** `language`. */
export const LANGUAGE = 11528;
/** ` None`: the model's answer when there is no speech. */
export const NONE = 2240;
/** `<|endoftext|>`, `<|im_end|>`. */
export const EOS: ReadonlySet<number> = new Set([151643, 151645]);

/**
 * Each language's name tokens after `language` (` Korean`, ` Canton` + `ese`): their first tokens
 * are all different, so the logits at the name step give a probability per language.
 */
export const LANGUAGE_TOKENS: Readonly<Record<string, readonly number[]>> = {
  zh: [8453],
  en: [6364],
  yue: [72366, 2367],
  ar: [34117],
  de: [5938],
  fr: [8585],
  es: [15154],
  pt: [42188],
  id: [58829],
  it: [14811],
  ko: [16134],
  ru: [8522],
  th: [26392],
  vi: [48477],
  ja: [10769],
  tr: [23734],
  hi: [43980],
  ms: [79140],
  nl: [23234],
  sv: [30109],
  da: [43680],
  fi: [57853],
  pl: [31984],
  cs: [33150],
  fil: [62417],
  fa: [49861],
  el: [17860],
  ro: [73597],
  hu: [56769],
  mk: [56452, 75491],
};

/** The model's language names (as it writes them) → tags. */
export const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  Chinese: 'zh',
  English: 'en',
  Cantonese: 'yue',
  Arabic: 'ar',
  German: 'de',
  French: 'fr',
  Spanish: 'es',
  Portuguese: 'pt',
  Indonesian: 'id',
  Italian: 'it',
  Korean: 'ko',
  Russian: 'ru',
  Thai: 'th',
  Vietnamese: 'vi',
  Japanese: 'ja',
  Turkish: 'tr',
  Hindi: 'hi',
  Malay: 'ms',
  Dutch: 'nl',
  Swedish: 'sv',
  Danish: 'da',
  Finnish: 'fi',
  Polish: 'pl',
  Czech: 'cs',
  Filipino: 'fil',
  Persian: 'fa',
  Greek: 'el',
  Romanian: 'ro',
  Hungarian: 'hu',
  Macedonian: 'mk',
};

/** Tags people may use for a language the model knows by another (`tl` → `fil`). */
const ALIASES: Readonly<Record<string, string>> = { tl: 'fil' };

/** The model's tags for these languages (primary subtags), ignoring ones it doesn't know. */
export function modelLanguages(tags: readonly string[]): string[] {
  const out = new Set<string>();
  for (const tag of tags) {
    const primary = tag.split('-')[0]?.toLowerCase() ?? '';
    const code = ALIASES[primary] ?? primary;
    if (LANGUAGE_TOKENS[code]) out.add(code);
  }
  return [...out];
}

/** `language <Name><asr_text>` for a tag the model knows. */
export function languageIds(tag: string): number[] {
  const name = LANGUAGE_TOKENS[tag];
  if (!name) throw new Error(`Qwen3-ASR doesn't know the language ${tag}.`);
  return [LANGUAGE, ...name, ASR_TEXT];
}

/** The prompt for `audioTokens` audio rows, then any forced answer tokens. */
export function promptIds(audioTokens: number, forced: readonly number[] = []): number[] {
  return [...PREFIX, ...new Array<number>(audioTokens).fill(AUDIO_PAD), ...SUFFIX, ...forced];
}

/** Where the audio rows start in the prompt. */
export const AUDIO_OFFSET = PREFIX.length;

export interface ParsedAnswer {
  /** The language tag, or null when the model heard no speech (or named no known language). */
  language: string | null;
  /** The name as written (`Korean`, `None`). */
  languageName: string;
  text: string;
  /** Index in the answer of the first text token (after `<asr_text>`), or -1. */
  textStart: number;
}

/** Splits an answer (`language <Name><asr_text><text>`) into its language and text. */
export function parseAnswer(ids: readonly number[], tokenizer: TokenDecoder): ParsedAnswer {
  const k = ids.indexOf(ASR_TEXT);
  if (ids[0] !== LANGUAGE) {
    // No language header (not expected): all of it is text.
    const text = tokenizer.decode(k >= 0 ? ids.slice(k + 1) : [...ids]).trim();
    return { language: null, languageName: '', text, textStart: k >= 0 ? k + 1 : 0 };
  }
  const nameEnd = k >= 0 ? k : ids.length;
  const languageName = tokenizer.decode(ids.slice(1, nameEnd)).trim();
  const text = k >= 0 ? tokenizer.decode(ids.slice(k + 1)).trim() : '';
  return {
    language: LANGUAGE_NAMES[languageName] ?? null,
    languageName,
    text,
    textStart: k >= 0 ? k + 1 : -1,
  };
}

/**
 * The answer to force when re-decoding a segment that grew: the last answer's header and text
 * minus its last `rollback` tokens (they may change with more audio), so only the tail is
 * decoded again. Null when the last answer has no header (decode from scratch).
 */
export function rollbackPrefix(ids: readonly number[], rollback: number): number[] | null {
  const k = ids.indexOf(ASR_TEXT);
  if (ids[0] !== LANGUAGE || k < 0) return null;
  const keep = Math.max(k + 1, ids.length - rollback);
  return ids.slice(0, keep).filter((id) => !EOS.has(id));
}

/** Most answer tokens for `seconds` of audio: plenty for any language, and a cap on loops. */
export function maxAnswerTokens(seconds: number): number {
  return Math.min(256, Math.ceil(24 + seconds * 12));
}

/**
 * Copies of a run of tokens at the end of the text that make a decoding loop: greedy decoding
 * that starts repeating itself never stops before the token cap. A single token 8 times, a run
 * of 2–4 tokens 6 times, a longer one (up to 16) 4 times: more than people say in a row (and
 * the guards cut any repeat to two copies anyway, whisper/filters.ts).
 */
const LOOP_COPIES = (unit: number) => (unit === 1 ? 8 : unit <= 4 ? 6 : 4);
const LOOP_MAX_UNIT = 16;

/** True when `ids[from..]` (the answer's text) ends in a decoding loop (`LOOP_COPIES`). */
export function endsInLoop(ids: readonly number[], from = 0): boolean {
  const n = ids.length - from;
  for (let unit = 1; unit <= LOOP_MAX_UNIT; unit++) {
    const copies = LOOP_COPIES(unit);
    if (unit * copies > n) continue;
    let same = true;
    for (let i = 1; i < copies && same; i++) {
      for (let j = 0; j < unit; j++) {
        if (ids[ids.length - 1 - j] !== ids[ids.length - 1 - j - i * unit]) {
          same = false;
          break;
        }
      }
    }
    if (same) return true;
  }
  return false;
}
