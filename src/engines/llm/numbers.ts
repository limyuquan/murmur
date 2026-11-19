/**
 * Number words to digits, for the translation model's input only (the subtitle shows what was
 * said). Speech recognition often writes numbers as words (백오십, 십오 위, 三百), and the model
 * then gets them wrong ("At eighty-five"); digits it copies. Pure, so it's unit-tested.
 *
 * Conservative: a number word is converted only where it is plainly a number, since the same
 * syllables are everyday words (일 "work", 이 "this", 사이 "between", 천사 "angel", 十分 "very",
 * 一样 "same"). A missed number costs what it did before; a wrong one changes the meaning.
 *
 * Korean (Sino-Korean numerals, standing alone after a non-Hangul character):
 * - two or more syllables with a unit (십 백 천 만 억 조), followed by a counter, a particle or
 *   the end of the word: 백오십에서 → 150에서, 십오위 → 15위, 이천이십사 년 → 2024 년;
 * - one syllable (일, 삼, 백, ...) only before a counter after a space: 십 분 → 10 분, 삼 위 → 3 위.
 *   이 only before counters it can't mean "this" with (퍼센트, 개월, ...: not 이 위에 "on this").
 * Native Korean numbers (한, 두, 세, ..., 스물, 열두) only before a counter: 두 명 → 2 명,
 * 스무 살 → 20 살 (not 한 번 "once, a try", nor 네 번 "your turn").
 *
 * Japanese and Chinese:
 * - two or more numerals with a unit (十 百 千 万 億), followed by a counter or by anything but
 *   a Han character: 三百で → 300で, 八十五歳 → 85歳 (not 八百屋, 五十嵐);
 * - one numeral only before a counter: 三人 → 3人, 两个 → 2个. 一 only before counters where
 *   it can't be idiomatic (月, 年, 円, ...), and never right after another Han character
 *   (唯一, 统一);
 * - numerals without a unit only as a year: 二〇二四年 → 2024年.
 * A numeral that a colloquial reading makes ambiguous (一百五: 150 in Chinese, 105 in Japanese)
 * is left alone.
 */

// ---------------------------------------------------------------------------------------------
// Korean

const KO_DIGITS: Record<string, number> = {
  일: 1,
  이: 2,
  삼: 3,
  사: 4,
  오: 5,
  육: 6,
  칠: 7,
  팔: 8,
  구: 9,
};
const KO_SMALL: Record<string, number> = { 십: 10, 백: 100, 천: 1000 };
const KO_BIG: Record<string, number> = { 만: 1e4, 억: 1e8, 조: 1e12 };

/**
 * First syllables of the particles and endings that may follow a number or its counter within
 * the word (원이면, 위를, 명도, 살까지), and that rarely start a longer word after a counter.
 */
const KO_PARTICLE_STARTS = new Set([...'이가은는을를의에도만까부로으와과랑나쯤째씩였인짜밖예입']);

/** Counters after Sino-Korean numbers. Longest first. */
const KO_SINO_COUNTERS = [
  '킬로그램',
  '퍼센트',
  '페이지',
  '개월',
  '주년',
  '킬로',
  '미터',
  '센티',
  '달러',
  '시간',
  '프로',
  '위',
  '등',
  '층',
  '년',
  '월',
  '일',
  '분',
  '초',
  '원',
  '회',
  '호',
  '세',
  '점',
  '명',
  '장',
  '권',
  '번',
  '대',
];
/** The only counters a lone 이 converts before (with others it means "this"). */
const KO_I_COUNTERS = new Set(['퍼센트', '달러', '개월', '주년', '킬로', '미터', '센티']);

/** Counters after native Korean numbers. Longest first. */
const KO_NATIVE_COUNTERS = [
  '군데',
  '가지',
  '마리',
  '시간',
  '명',
  '개',
  '살',
  '시',
  '달',
  '잔',
  '병',
  '권',
  '장',
  '번',
  '대',
];

/** Words written with numeral syllables that usually aren't numbers. */
const KO_NOT_NUMBERS = new Set(['천사', '이천', '사천', '오만', '이만', '백조']);

const NATIVE_TENS: Record<string, number> = {
  열: 10,
  스물: 20,
  스무: 20,
  서른: 30,
  마흔: 40,
  쉰: 50,
  예순: 60,
  일흔: 70,
  여든: 80,
  아흔: 90,
};
const NATIVE_ONES: Record<string, number> = {
  한: 1,
  두: 2,
  세: 3,
  네: 4,
  다섯: 5,
  여섯: 6,
  일곱: 7,
  여덟: 8,
  아홉: 9,
};
const NATIVE_NUMBER = new RegExp(
  `^(?:(${Object.keys(NATIVE_TENS).join('|')})(${Object.keys(NATIVE_ONES).join('|')})?|(${Object.keys(NATIVE_ONES).join('|')}))`,
);

const isHangul = (ch: string | undefined) => !!ch && /[가-힣]/.test(ch);

/** The value of a whole Sino-Korean numeral, or null when it isn't one. */
export function parseSinoKorean(word: string): number | null {
  let total = 0;
  let group = 0;
  let digit: number | null = null;
  let lastSmall = Infinity;
  let lastBig = Infinity;
  for (const ch of word) {
    if (ch in KO_DIGITS) {
      if (digit !== null) return null;
      digit = KO_DIGITS[ch] as number;
    } else if (ch in KO_SMALL) {
      const unit = KO_SMALL[ch] as number;
      if (unit >= lastSmall) return null;
      group += (digit ?? 1) * unit;
      digit = null;
      lastSmall = unit;
    } else if (ch in KO_BIG) {
      const unit = KO_BIG[ch] as number;
      if (unit >= lastBig) return null;
      const g = group + (digit ?? 0);
      total += (g === 0 ? 1 : g) * unit;
      group = 0;
      digit = null;
      lastSmall = Infinity;
      lastBig = unit;
    } else {
      return null;
    }
  }
  return total + group + (digit ?? 0);
}

/** The counter that `rest` starts with, when the word ends with it (or a particle after it). */
function counterAt(rest: string, counters: readonly string[]): string | null {
  for (const c of counters) {
    if (rest.startsWith(c) && endsWord(rest.slice(c.length))) return c;
  }
  return null;
}

/** `rest` ends the word: nothing more of it, or a particle or ending. */
function endsWord(rest: string): boolean {
  return !isHangul(rest[0]) || KO_PARTICLE_STARTS.has(rest[0] as string);
}

function koreanToDigits(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    const atWordStart = !isHangul(text[i - 1]);
    if (atWordStart && isHangul(ch)) {
      const converted = sinoAt(text, i) ?? nativeAt(text, i);
      if (converted) {
        out += converted.digits;
        i += converted.length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

const KO_NUMERAL = /[일이삼사오육칠팔구십백천만억조]/;

/** A Sino-Korean numeral starting at `i`, as digits, with how much of the text it covers. */
function sinoAt(text: string, i: number): { digits: string; length: number } | null {
  let run = 0;
  while (KO_NUMERAL.test(text[i + run] ?? '')) run++;
  for (let n = run; n >= 1; n--) {
    const word = text.slice(i, i + n);
    const value = parseSinoKorean(word);
    if (value === null) continue;
    const rest = text.slice(i + n);
    const hasUnit = /[십백천만억조]/.test(word);
    if (n >= 2 && hasUnit) {
      const counter = counterAt(rest.replace(/^ /, ''), KO_SINO_COUNTERS);
      // 천사 "angel", 오만 "arrogance": numbers only before a counter (이만 원).
      if (counter || (endsWord(rest) && !KO_NOT_NUMBERS.has(word))) {
        return { digits: String(value), length: n };
      }
      continue;
    }
    if (n === 1 && rest.startsWith(' ')) {
      const counter = counterAt(rest.slice(1), KO_SINO_COUNTERS);
      if (counter && (word !== '이' || KO_I_COUNTERS.has(counter))) {
        return { digits: String(value), length: 1 };
      }
    }
  }
  return null;
}

/** A native Korean number before a counter, as digits. */
function nativeAt(text: string, i: number): { digits: string; length: number } | null {
  const m = NATIVE_NUMBER.exec(text.slice(i));
  if (!m) return null;
  const [word, tens, ones, alone] = m;
  if (tens === '스무' && ones) return null;
  if (tens === '스물' && !ones) return null;
  const total = (tens ? (NATIVE_TENS[tens] ?? 0) : 0) + (NATIVE_ONES[ones ?? alone ?? ''] ?? 0);
  const rest = text.slice(i + word.length);
  const after = rest.startsWith(' ') ? rest.slice(1) : rest;
  const counter = counterAt(after, KO_NATIVE_COUNTERS);
  if (!counter) return null;
  // 한 번 ("once", "give it a try") and 네 번 ("your turn") say more than a number.
  if (counter === '번' && (word === '한' || word === '네')) return null;
  return { digits: String(total), length: word.length };
}

// ---------------------------------------------------------------------------------------------
// Japanese and Chinese

const CJ_DIGITS: Record<string, number> = {
  〇: 0,
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  兩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const CJ_SMALL: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const CJ_BIG: Record<string, number> = { 万: 1e4, 萬: 1e4, 億: 1e8, 亿: 1e8 };
const CJ_NUMERAL = /[〇零一二两兩三四五六七八九十百千万萬億亿]/;
const CJ_UNIT = /[十百千万萬億亿]/;

/** Counters after a Japanese or Chinese numeral. Longest first. */
const CJ_COUNTERS = [
  '个月',
  '小时',
  '分钟',
  '年级',
  '人',
  '位',
  '名',
  '個',
  '个',
  '回',
  '次',
  '年',
  '月',
  '日',
  '天',
  '時',
  '时',
  '点',
  '分',
  '秒',
  '歳',
  '岁',
  '円',
  '元',
  '块',
  '号',
  '番',
  '階',
  '层',
  '楼',
  '本',
  '枚',
  '匹',
  '只',
  '杯',
  '度',
  '倍',
  '周',
  '週',
  '件',
  '台',
  '冊',
  '页',
  '頁',
  '米',
  '%',
  '％',
];
/** The only counters a lone 一 converts before (others make idioms: 一度, 一点, 一人). */
const CJ_ONE_COUNTERS = new Set([
  '月',
  '年',
  '歳',
  '岁',
  '円',
  '元',
  '号',
  '階',
  '层',
  '楼',
  '秒',
  '分钟',
  '个月',
  '小时',
  '年级',
  '%',
  '％',
]);
/** Numerals with what follows that usually aren't numbers. */
const CJ_NOT_NUMBERS = [
  '十分',
  '千万',
  '万一',
  '十八番',
  '二度と',
  '三日月',
  '二日酔',
  '五分五分',
  '八百屋',
  '八百長',
  '万人',
];
/** Han characters that may come right before a numeral (第三, 约五百). */
const CJ_PREFIXES = new Set(['第', '約', '约', '毎', '每', '共', '近', '超']);

const isHan = (ch: string | undefined) => !!ch && /[㐀-䶿一-鿿豈-﫿]/.test(ch);

/**
 * The value of a whole Japanese or Chinese numeral, or null when it isn't one or a colloquial
 * reading makes it ambiguous (一百五).
 */
export function parseHanNumeral(word: string): number | null {
  let total = 0;
  let group = 0;
  let digit: number | null = null;
  let lastSmall = Infinity;
  let lastBig = Infinity;
  let zero = false;
  let lastUnit = 0;
  for (const ch of word) {
    if (ch in CJ_DIGITS) {
      const d = CJ_DIGITS[ch] as number;
      if (d === 0) {
        if (digit !== null) return null;
        zero = true;
        continue;
      }
      if (digit !== null) return null;
      digit = d;
    } else if (ch in CJ_SMALL) {
      const unit = CJ_SMALL[ch] as number;
      if (unit >= lastSmall) return null;
      group += (digit ?? 1) * unit;
      digit = null;
      zero = false;
      lastSmall = unit;
      lastUnit = unit;
    } else if (ch in CJ_BIG) {
      const unit = CJ_BIG[ch] as number;
      if (unit >= lastBig) return null;
      const g = group + (digit ?? 0);
      total += (g === 0 ? 1 : g) * unit;
      group = 0;
      digit = null;
      zero = false;
      lastSmall = Infinity;
      lastBig = unit;
      lastUnit = unit;
    } else {
      return null;
    }
  }
  // 一百五, 三万五: 150 and 35000 in Chinese speech, 105 and 30005 when read literally.
  if (digit !== null && lastUnit >= 100 && !zero) return null;
  return total + group + (digit ?? 0);
}

function hanToDigits(text: string): string {
  const chars = [...text];
  let out = '';
  let i = 0;
  while (i < chars.length) {
    if (!CJ_NUMERAL.test(chars[i] as string)) {
      out += chars[i];
      i++;
      continue;
    }
    let n = 0;
    while (i + n < chars.length && CJ_NUMERAL.test(chars[i + n] as string)) n++;
    const word = chars.slice(i, i + n).join('');
    const converted = hanNumber(word, chars[i - 1], chars.slice(i + n, i + n + 4).join(''));
    out += converted ?? word;
    i += n;
  }
  return out;
}

/** `word` (a whole run of numerals) as digits, or null to leave it. */
function hanNumber(word: string, before: string | undefined, after: string): string | null {
  if (CJ_NOT_NUMBERS.some((w) => w.startsWith(word) && (word + after).startsWith(w))) return null;
  const counter = CJ_COUNTERS.find((c) => after.startsWith(c)) ?? null;
  const looseBefore = !isHan(before) || CJ_PREFIXES.has(before ?? '');
  // 一 right after another Han character is part of a word: 唯一, 统一, 一样.
  if (word.startsWith('一') && !looseBefore) return null;
  if (CJ_UNIT.test(word)) {
    const value = parseHanNumeral(word);
    if (value === null) return null;
    if ([...word].length === 1) {
      // 十, 百, 千 alone: only before a counter. 万, 億 alone: never (万人 "everyone").
      return counter && !/[万萬億亿]/.test(word) ? String(value) : null;
    }
    return counter || !isHan(after[0]) ? String(value) : null;
  }
  // Numerals without a unit: a year written digit by digit, or one numeral before a counter.
  if ([...word].length >= 2) {
    return after.startsWith('年') && [...word].length === 4
      ? [...word].map((c) => CJ_DIGITS[c]).join('')
      : null;
  }
  const value = CJ_DIGITS[word];
  if (value === undefined || value === 0 || !counter) return null;
  if (value === 1 && (word !== '一' || !CJ_ONE_COUNTERS.has(counter))) return null;
  return String(value);
}

// ---------------------------------------------------------------------------------------------

/** `text` with the number words that are plainly numbers written as digits. */
export function numeralsToDigits(text: string): string {
  let out = text;
  if (/[가-힣]/.test(out)) out = koreanToDigits(out);
  if (CJ_NUMERAL.test(out)) out = hanToDigits(out);
  return out;
}
