/**
 * Does a transcript end a sentence? The segmenter asks this about the text decoded up to a short
 * pause: if the words so far end a sentence, the segment can end there instead of waiting out the
 * full pause (segmenter.ts). Pure, so it's unit-tested.
 *
 * Two kinds of evidence:
 *
 * - `punct`: the text ends with sentence-final punctuation (`. ? ! … 。 ？ ！ ؟ ।` and others) that
 *   is plainly not part of a word: a full stop after a number (`3.`), a single letter (`U.S.`) or
 *   a common abbreviation (`Mr.`) doesn't count. Models that write punctuation (Whisper,
 *   Qwen3-ASR) mark sentence ends this way in every language they write.
 * - `ending`: the last word ends with a sentence-final ending or particle, for languages that end
 *   sentences that way and whose rules are known here: Korean (`-요`, `-ㅂ니다`, `-다` after a
 *   final consonant, `-ㄹ까`, `-죠`, ...), Japanese (`です`, `ます`, `ね`, `よ`, ...) and Chinese
 *   (`吗`, `呢`, `吧`). Only whole endings count, and nouns that merely end in the same syllable
 *   (`바다`, `아까`, `필요`) don't. Other languages get no ending rule: punctuation only.
 *
 * The rules are conservative: a missed sentence end only means the segment waits for the
 * ordinary pause; a false one cuts a sentence in two.
 */
import { primaryLanguage } from './language';

export type SentenceRule = 'punct' | 'ending' | 'either';

export interface SentenceEndOptions {
  /** Which evidence counts. Default `punct`. */
  rule?: SentenceRule;
  /** The text's language (BCP-47), when known: picks the ending rules. */
  language?: string | null;
}

export function isSentenceEnd(text: string, options: SentenceEndOptions = {}): boolean {
  const rule = options.rule ?? 'punct';
  const t = text.trimEnd();
  if (t === '') return false;
  if (rule !== 'ending' && endsWithSentencePunctuation(t, options.language ?? null)) return true;
  if (rule !== 'punct' && endsWithSentenceEnding(t, options.language ?? null)) return true;
  return false;
}

/** Marks that end a sentence wherever they appear at the end of a line. */
const FINAL_MARKS = new Set([
  '?',
  '!',
  '…',
  '‼',
  '⁇',
  '⁈',
  '⁉',
  '。',
  '｡',
  '？',
  '！',
  '؟', // Arabic, Persian
  '۔', // Urdu
  '।', // Devanagari and others
  '॥',
  '։', // Armenian
  '።', // Ethiopic
  '။', // Myanmar
  '᙮', // Canadian syllabics
  '꓿', // Lisu
]);

/** Closing quotes and brackets that may follow the final mark (`"Yes."`, `「はい。」`). */
const CLOSERS = /["'”’»」』）)\]】》〉]+$/u;

/** Words after which a full stop is part of the word, not a sentence end (lowercase). */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'eg',
  'ie',
  'vol',
  'fig',
  'approx',
  'inc',
  'ltd',
  'corp',
  'dept',
  'sgt',
  'capt',
  'lt',
  'gov',
  'sen',
]);

function endsWithSentencePunctuation(text: string, language: string | null): boolean {
  const t = text.replace(CLOSERS, '');
  const last = t.slice(-1);
  if (FINAL_MARKS.has(last)) return true;
  // Greek writes its question mark as `;`.
  if (last === ';' && language !== null && primaryLanguage(language) === 'el') return true;
  if (last === '.' || last === '．') return fullStopEndsSentence(t.slice(0, -1));
  return false;
}

/** `text` is what comes before a final full stop. */
function fullStopEndsSentence(before: string): boolean {
  if (/\.\.$/.test(before)) return true; // an ellipsis written as three dots
  const word = /[\p{L}\p{N}.'’-]*$/u.exec(before)?.[0] ?? '';
  if (word === '') return before.trim() !== '';
  // `3.` (a number, a list item or a decimal still being said).
  if (/\p{N}$/u.test(word)) return false;
  // `U.S.`, `e.g.`, initials: a single letter before the stop.
  const tail = word.split('.').pop() ?? '';
  if (word.includes('.') && /^\p{L}$/u.test(tail)) return false;
  if (/^\p{Lu}$/u.test(word)) return false;
  if (ABBREVIATIONS.has(tail.toLowerCase().replace(/['’-]/g, ''))) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Endings

const PUNCTUATION_TAIL = /[\p{P}\p{S}\s]+$/u;

function endsWithSentenceEnding(text: string, language: string | null): boolean {
  const core = text.replace(PUNCTUATION_TAIL, '');
  const word = /[^\s\p{P}\p{S}]+$/u.exec(core)?.[0] ?? '';
  if (word === '') return false;
  const lang = language ? primaryLanguage(language) : null;
  const known = lang !== null && lang !== 'und';
  const lastChar = word.slice(-1);
  // The script decides when the language isn't known; a known language must match it.
  if (isHangul(lastChar)) return (!known || lang === 'ko') && koreanEnding(word);
  if (isKana(lastChar) || (lang === 'ja' && isHan(lastChar))) {
    return (!known || lang === 'ja') && japaneseEnding(word);
  }
  if (isHan(lastChar)) return lang === 'zh' && chineseEnding(word);
  return false;
}

// Korean ---------------------------------------------------------------------------------------

const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;

function isHangul(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return c >= HANGUL_BASE && c <= HANGUL_LAST;
}

/** Final consonant index of a Hangul syllable (0: none, 4: ㄴ, 8: ㄹ, 17: ㅂ, 20: ㅆ). */
function batchim(ch: string | undefined): number {
  if (!ch || !isHangul(ch)) return -1;
  return ((ch.codePointAt(0) as number) - HANGUL_BASE) % 28;
}

const RIEUL = 8;
const BIEUP = 17;

/** Nouns and adverbs that end in an ending's syllable. */
const KOREAN_NOT_ENDINGS = new Set([
  '필요',
  '불필요',
  '중요',
  '주요',
  '수요',
  '강요',
  '소요',
  '아까',
  '언니네',
  '우리네',
  '그네',
]);

/**
 * Korean sentence-final endings on the last word (an eojeol of at least two syllables, so a
 * single syllable that happens to match isn't taken for an ending):
 * `-요` (polite), `-다` after a final consonant (`했다`, `한다`, `좋다`, `-ㅂ니다`) or as the
 * copula `이다`/`니다`, `-ㅂ니까`/`-습니까`, `-ㄹ까`, `-죠`, `-잖아`, `-네`, `-냐`, `-래`. Plain
 * `-니까` (because) and `-거든` (if) also join clauses, so they don't count.
 */
function koreanEnding(word: string): boolean {
  const syllables = [...word];
  if (syllables.length < 2) return false;
  // Also as the end of a compound (`제일중요`).
  for (const noun of KOREAN_NOT_ENDINGS) if (word.endsWith(noun)) return false;
  const last = syllables[syllables.length - 1] as string;
  const prev = syllables[syllables.length - 2];
  switch (last) {
    case '요':
    case '죠':
    case '냐':
    case '래':
    case '네':
      return true;
    case '다':
      // `했다`, `한다`, `좋다`, `합니다`, `학생이다`; not `바다`, `보다`, `마다`.
      return batchim(prev) > 0 || prev === '니' || prev === '이';
    case '까':
      if (prev === '니') {
        // `합니까`, `습니까` (questions), not `하니까`, `그러니까` (because).
        const before = syllables[syllables.length - 3];
        return before === '습' || batchim(before) === BIEUP;
      }
      // `할까`, `갈까`, `-을까`; not `아까`.
      return batchim(prev) === RIEUL;
    case '아':
      return prev === '잖';
    default:
      return false;
  }
}

// Japanese -------------------------------------------------------------------------------------

function isKana(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (c >= 0x3040 && c <= 0x30ff) || (c >= 0xff66 && c <= 0xff9d);
}

function isHan(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff);
}

const JAPANESE_ENDINGS = [
  'です',
  'ます',
  'ました',
  'でした',
  'ません',
  'ましょう',
  'でしょう',
  'ください',
  '下さい',
  'ですか',
  'ますか',
  'のか',
  'んか',
  'ですね',
  'ますね',
  'よね',
  'いね',
  'だね',
  'たね',
  'よ',
  'ぞ',
  'ぜ',
  'んだ',
  'のだ',
  'そうだ',
] as const;

/**
 * Japanese sentence-final forms: polite `です`/`ます` with their past, negative and question
 * forms, `ください`, `よ`, `ぞ`, `ぜ`, `ね` after `です`/`ます`/`よ`/`い`/`だ`/`た` (not the filler
 * in `あのね`, `それでね`), `か` after `の`/`ん`, and `だ` after `ん`/`の`/`そう`. Not `の` (also a
 * possessive), `か` alone (also "or") or a plain `た` (also ends nouns: `あなた`, `また`).
 */
function japaneseEnding(word: string): boolean {
  return JAPANESE_ENDINGS.some((e) => word.endsWith(e));
}

// Chinese --------------------------------------------------------------------------------------

/** Question and mood particles that end a sentence (`了` and `的` also sit inside one). */
function chineseEnding(word: string): boolean {
  return /[吗嗎呢吧嘛]$/u.test(word);
}
