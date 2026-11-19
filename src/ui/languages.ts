/** Languages offered as targets and hints, and their names in the browser's language. */

export const LANGUAGES = [
  'ar',
  'de',
  'en',
  'es',
  'fr',
  'hi',
  'id',
  'it',
  'ja',
  'ko',
  'nl',
  'pl',
  'pt',
  'ru',
  'sv',
  'th',
  'tr',
  'uk',
  'vi',
  'zh',
] as const;

let names: Intl.DisplayNames | null = null;

/** "fr" → "French" (in the browser's language). Falls back to the tag. */
export function languageName(tag: string): string {
  try {
    names ??= new Intl.DisplayNames([navigator.language], { type: 'language' });
    return names.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** Offered languages by name, sorted. */
export function languageOptions(): { tag: string; name: string }[] {
  return LANGUAGES.map((tag) => ({ tag, name: languageName(tag) })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/** A good first target: the browser's language when offered, else English. */
export function defaultTarget(): string {
  const primary = navigator.language.split('-')[0]?.toLowerCase() ?? 'en';
  return (LANGUAGES as readonly string[]).includes(primary) ? primary : 'en';
}

/** "French, German and Spanish". */
export function listNames(tags: readonly string[]): string {
  const list = tags.map(languageName);
  try {
    return new Intl.ListFormat([navigator.language], { type: 'conjunction' }).format(list);
  } catch {
    return list.join(', ');
  }
}
