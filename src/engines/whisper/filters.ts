/**
 * Guards against Whisper's known failure modes, applied to every decode before it becomes a
 * subtitle. Pure, so they're unit-tested.
 *
 * - Silence and music: Whisper still writes something. A segment is dropped when the model itself
 *   says there's no speech (`<|nospeech|>` probability at the first step) and its text is
 *   improbable, the rule openai/whisper uses (no-speech > 0.6 and average log-prob < −1), or when
 *   the no-speech probability alone is very high, or the audio is too quiet to hold words.
 * - Stock phrases: lines Whisper learned from subtitle credits ("Thanks for watching",
 *   "구독과 좋아요", "ご視聴ありがとうございました") are dropped when they are the whole line.
 * - Repetition loops: a phrase repeated over and over is cut back to two copies.
 */
import { primaryLanguage } from '@/pipeline/language';

export interface DecodeStats {
  text: string;
  /** Detected language (primary subtag). */
  language: string;
  /** P(`<|nospeech|>`) at the first decoding step. */
  noSpeechProb: number;
  /** Mean log-probability of the generated tokens (incl. end of text). */
  avgLogprob: number;
  /** Loudness of the segment's loudest 100 ms, dBFS. */
  peakDb: number;
}

export type DropReason = 'no-speech' | 'quiet' | 'stock-phrase' | 'low-confidence' | 'empty';

export interface FilterResult {
  text: string;
  dropped: DropReason | null;
}

export const FILTER_DEFAULTS = {
  noSpeech: 0.6,
  logprob: -1,
  /** No-speech probability that drops a segment whatever the text's probability. */
  noSpeechAlone: 0.9,
  /** Average log-prob below which a line is too unsure to show. */
  minLogprob: -1.6,
  /** Peak loudness below which there's nothing to transcribe, dBFS. */
  minPeakDb: -55,
};

export function filterDecode(stats: DecodeStats, opts = FILTER_DEFAULTS): FilterResult {
  const collapsed = collapseRepeats(stats.text.trim());
  if (stats.peakDb < opts.minPeakDb) return { text: '', dropped: 'quiet' };
  if (
    (stats.noSpeechProb > opts.noSpeech && stats.avgLogprob < opts.logprob) ||
    stats.noSpeechProb > opts.noSpeechAlone
  ) {
    return { text: '', dropped: 'no-speech' };
  }
  if (isStockPhrase(collapsed, stats.language)) return { text: '', dropped: 'stock-phrase' };
  if (
    WEAK.some((p) => normalize(p) === normalize(collapsed)) &&
    (stats.noSpeechProb > WEAK_NO_SPEECH || stats.avgLogprob < WEAK_LOGPROB)
  ) {
    return { text: '', dropped: 'stock-phrase' };
  }
  if (stats.avgLogprob < opts.minLogprob) return { text: '', dropped: 'low-confidence' };
  if (normalize(collapsed) === '') return { text: '', dropped: 'empty' };
  return { text: collapsed, dropped: null };
}

/**
 * Cuts a phrase repeated more than twice in a row back to two copies ("네 네 네 네 네" → "네 네",
 * "ありがとうありがとうありがとう…" → "ありがとうありがとう"). Works on words and, for scripts written
 * without spaces, on characters.
 */
export function collapseRepeats(text: string, keep = 2): string {
  // A unit of 1–60 characters followed by the same unit (optionally after a separator) 2+ times.
  const re = /(.{1,60}?)(?:[\s,、。.!?！？]*\1){2,}/gsu;
  let out = text;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(re, (match: string, unit: string) => {
      if (unit.trim() === '') return match;
      // Keep the copies apart the way the first two were (`no, no`, `Yeah. Yeah`, `네 네`).
      const sep = /^[\s,、。.!?！？]*/u.exec(match.slice(unit.length))?.[0] ?? '';
      return Array.from({ length: keep }, () => unit)
        .join(sep)
        .replace(/(\s)\s+/gu, '$1');
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Lowercase, without punctuation, symbols or spaces: for phrase matching. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

/**
 * Lines Whisper is known to make up on silence and music (from subtitle credits in its training
 * data), by language. Matched against the whole line, normalised, so real speech that merely
 * contains the words is kept.
 */
const STOCK: Record<string, readonly string[]> = {
  en: [
    'thanks for watching',
    'thank you for watching',
    'thank you so much for watching',
    'please subscribe',
    'subscribe to my channel',
    'like and subscribe',
    'you',
  ],
  ko: [
    '시청해주셔서 감사합니다',
    '시청해 주셔서 감사합니다',
    '구독과 좋아요 부탁드립니다',
    '구독과 좋아요',
    '좋아요와 구독',
    '자막 제공 및 자막 편집',
  ],
  ja: [
    'ご視聴ありがとうございました',
    'ご清聴ありがとうございました',
    'チャンネル登録よろしくお願いします',
    'チャンネル登録お願いします',
  ],
  zh: [
    '谢谢观看',
    '请不吝点赞订阅转发打赏支持明镜与点点栏目',
    '字幕由amaraorg社区提供',
    '优优独播剧场youtv',
  ],
};

/**
 * Short lines people really say, but that Whisper also makes up on silence: dropped only when the
 * model wasn't sure there was speech (`WEAK_NO_SPEECH`) or of the words (`WEAK_LOGPROB`).
 */
const WEAK: readonly string[] = [
  'thank you',
  'thank you very much',
  'bye',
  'see you next time',
  '감사합니다',
  '고맙습니다',
  'ありがとうございました',
  'おやすみなさい',
  '谢谢',
  '谢谢大家',
];
const WEAK_NO_SPEECH = 0.25;
const WEAK_LOGPROB = -0.7;

/** Credit lines in any language: dropped when the line contains them at all. */
const CREDIT_MARKERS = ['amaraorg', '字幕by', '字幕提供', '자막제공', 'mbc뉴스', '번역자막'];

export function isStockPhrase(text: string, language: string): boolean {
  const n = normalize(text);
  if (n === '') return false;
  if (CREDIT_MARKERS.some((m) => n.includes(m))) return true;
  const lists = [STOCK[primaryLanguage(language)] ?? [], ...Object.values(STOCK)];
  return lists.some((list) => list.some((phrase) => normalize(phrase) === n));
}

/** Peak loudness over 100 ms windows, dBFS (−Infinity for digital silence). */
export function peakDb(samples: Float32Array, sampleRate = 16_000): number {
  const win = Math.max(1, Math.round(sampleRate / 10));
  let best = 0;
  for (let start = 0; start < samples.length; start += win) {
    const end = Math.min(samples.length, start + win);
    let sum = 0;
    for (let i = start; i < end; i++) sum += (samples[i] as number) ** 2;
    best = Math.max(best, sum / (end - start));
  }
  return best > 0 ? 10 * Math.log10(best) : -Infinity;
}
