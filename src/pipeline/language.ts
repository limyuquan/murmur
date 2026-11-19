/** Language-tag helpers. Tags are BCP-47; comparisons use the primary subtag only. */
import { type LanguageTag, UNKNOWN_LANGUAGE } from '@/engines/types';

/** "pt-BR" → "pt". */
export function primaryLanguage(tag: LanguageTag): string {
  return tag.split('-')[0]?.toLowerCase() ?? '';
}

/** Same language for translation purposes. Unknown is never the same as anything. */
export function sameLanguage(a: LanguageTag | null, b: LanguageTag | null): boolean {
  if (!a || !b || a === UNKNOWN_LANGUAGE || b === UNKNOWN_LANGUAGE) return false;
  return primaryLanguage(a) === primaryLanguage(b);
}
