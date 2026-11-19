/**
 * The translation prompt for the LLM engine (prompt v3, as benchmarked in murmur-notes
 * bench/results/summary_prompt_hillclimb.md): a short system message that says what to do, and a
 * user turn with the glossary entries the line uses, the last few finished lines (each with its
 * language and translation) and the line itself, with the language the speech engine heard it in.
 *
 * v3 over v2: about a third fewer prompt tokens (the same rules, said tersely), a misheard word
 * the model can't place is left out rather than replaced by a sound-alike, names are spelt as in
 * the earlier lines, and Korean address terms are never written as unnie/oppa/hyung/noona (unless
 * the `honorifics` flag asks for them). It is meant for 6 earlier lines (pipeline.ts).
 *
 * Templates use a tiny mustache subset, rendered exactly as the benchmark rendered them:
 * `{{var}}` substitutes, `{{#var}}…{{/var}}` keeps the block when `var` is set, `{{^var}}…{{/var}}`
 * when it isn't, and the result is trimmed.
 *
 * Filled in from the session and the line:
 * - the languages the source may mix are the session's (spoken languages, the line's, the earlier
 *   lines' and the target), not a fixed list; with fewer than two known, just "languages";
 * - the sentence on Korean address terms is there only when Korean is among them;
 * - a revision of a line already translated has the line that finishes its sentence after it
 *   (`NEXT`, for context only);
 * - a line that mixes languages (heard as the target language, partly in another) names them all
 *   as its language: "CURRENT (Korean and English)", so the model translates the other parts and
 *   keeps the target-language ones (the system message says to).
 * With the benchmark's languages (and no `domain`), the prompt is byte for byte the benchmarked one.
 */
import type { LanguageTag } from '../types';
import { UNKNOWN_LANGUAGE } from '../types';

export const SYSTEM_TEMPLATE =
  'Translate CURRENT, one line of live video subtitles{{#domain}} ({{domain}}){{/domain}}, into {{target_lang}}. Reply with the subtitle only.\n' +
  "Use natural, casual spoken {{target_lang}} and keep the speaker's tone.\n" +
  '{{#brief}}Keep it short enough to read at a glance: at most 2 lines of about 42 characters. Drop fillers (음, 어, 그, 아니, あの, えっと, um), stutters and repeated words, but keep every piece of meaning.\n' +
  '{{/brief}}Lines may mix {{languages}}: translate every part; keep parts already in {{target_lang}}.\n' +
  '{{#noisy}}CURRENT is an automatic transcript: fix misheard words from the context{{#glossary}} and glossary{{/glossary}}, but never invent content. Leave out a word you cannot make sense of instead of guessing a sound-alike. If nothing is intelligible, reply "…".\n' +
  '{{/noisy}}Names: official romanised spelling{{#glossary}}, as in the GLOSSARY{{/glossary}}, spelt the same as in the earlier lines; never translate a name.\n' +
  '{{#korean}}{{#honorifics}}Keep Korean address terms romanised (oppa, unnie, hyung, noona, sunbae, maknae).\n' +
  "{{/honorifics}}{{^honorifics}}Korean address terms (언니, 오빠, 형, 누나, 선배) are not names: use the person's name or leave them out; never write unnie, oppa, hyung or noona.\n" +
  '{{/honorifics}}{{/korean}}';

export const USER_TEMPLATE =
  '{{#glossary}}GLOSSARY: {{glossary}}\n' +
  '{{/glossary}}{{#context}}EARLIER LINES (context only):\n' +
  '{{context}}\n' +
  '{{/context}}{{#source_lang}}CURRENT ({{source_lang}}): {{/source_lang}}{{^source_lang}}CURRENT: {{/source_lang}}{{text}}\n' +
  '{{#next}}NEXT (the line right after CURRENT, which finishes its sentence; only for context, do not translate it): {{next}}\n{{/next}}';

type Vars = Record<string, string | boolean | undefined>;

const SECTION = /\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g;
const VAR = /\{\{(\w+)\}\}/g;

/** Renders a template: sections until none is left, then variables, then trims. */
export function render(template: string, vars: Vars): string {
  let out = template;
  let previous: string | null = null;
  while (previous !== out) {
    previous = out;
    out = out.replace(SECTION, (_m, kind: string, name: string, body: string) => {
      const truthy = Boolean(vars[name]);
      return (kind === '#' ? truthy : !truthy) ? body : '';
    });
  }
  return out
    .replace(VAR, (_m, name: string) => {
      const v = vars[name];
      return v === undefined || v === false ? '' : String(v);
    })
    .trim();
}

/** English names the benchmark used, then whatever Chrome calls the language in English. */
const NAMES: Record<string, string> = {
  ko: 'Korean',
  ja: 'Japanese',
  zh: 'Chinese',
  en: 'English',
  yue: 'Cantonese',
};

let displayNames: Intl.DisplayNames | null | undefined;

/** "Korean" for `ko`, "Brazilian Portuguese" for `pt-BR`; the tag itself when unknown. */
export function languageName(tag: LanguageTag): string {
  if (NAMES[tag]) return NAMES[tag] as string;
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
    } catch {
      displayNames = null;
    }
  }
  try {
    return displayNames?.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

function known(tag: LanguageTag | null | undefined): tag is LanguageTag {
  return !!tag && tag !== UNKNOWN_LANGUAGE;
}

const primary = (tag: LanguageTag) => tag.split('-')[0]?.toLowerCase() ?? tag;

/** "A and B", "A, B and C". */
function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** "Korean and English"; "English and another language" when one isn't known. */
function mixedName(tags: readonly LanguageTag[]): string {
  const names: string[] = [];
  for (const tag of tags) {
    const name = known(tag) ? languageName(primary(tag)) : null;
    if (name && !names.includes(name)) names.push(name);
  }
  if (names.length < tags.length || names.length < 2) names.push('another language');
  return listNames(names);
}

export interface PromptFlags {
  /** Subtitle brevity: drop fillers and stutters. Off by default. */
  brief?: boolean;
  /** The line comes from speech recognition and may have misheard words. On by default. */
  noisy?: boolean;
  /** Keep Korean address terms romanised. Off by default. */
  honorifics?: boolean;
}

export interface PromptInput {
  text: string;
  /** The line's language as the speech engine heard it (`und` or null: not known). */
  sourceLanguage: LanguageTag | null;
  targetLanguage: LanguageTag;
  /** Earlier finished lines, oldest first. */
  context: readonly { source: string; translation: string; language?: LanguageTag }[];
  /** Glossary entries the line or its context uses, each as the alias that matched. */
  glossary?: readonly { source: string; target: string; note?: string }[];
  /** Languages the person said they hear, in their order. */
  spokenLanguages?: readonly LanguageTag[];
  /** The languages the line mixes, when it mixes the target language with others. */
  mixed?: readonly LanguageTag[];
  /**
   * The line right after this one, which finishes its sentence: for a revision of a line already
   * translated, now that the rest of the sentence is known.
   */
  next?: string;
  flags?: PromptFlags;
  /** The kind of video, when known ("cooking shows, interviews"). */
  domain?: string;
}

export interface Prompt {
  system: string;
  user: string;
}

export const DEFAULT_FLAGS: Required<PromptFlags> = {
  brief: false,
  noisy: true,
  honorifics: false,
};

export function buildPrompt(input: PromptInput): Prompt {
  const flags = { ...DEFAULT_FLAGS, ...input.flags };
  const source = known(input.sourceLanguage) ? input.sourceLanguage : null;
  const languages: string[] = [];
  const mixed = input.mixed ?? [];
  for (const tag of [
    ...(input.spokenLanguages ?? []),
    ...input.context.map((c) => c.language),
    source,
    ...mixed,
    input.targetLanguage,
  ]) {
    // Only languages with a name: a tag the browser doesn't know says nothing to the model.
    if (!known(tag) || languageName(primary(tag)) === primary(tag)) continue;
    if (!languages.includes(primary(tag))) languages.push(primary(tag));
  }
  const context = input.context
    .map((c) => `[${known(c.language) ? c.language : '?'}] ${c.source} => ${c.translation}`)
    .join('\n');
  const glossary = (input.glossary ?? [])
    .map((g) => `${g.source} = ${g.target}${g.note ? ` (${g.note})` : ''}`)
    .join('; ');
  const vars: Vars = {
    text: input.text,
    target_lang: languageName(input.targetLanguage),
    source_lang: mixed.length > 0 ? mixedName(mixed) : source ? languageName(source) : '',
    context,
    glossary,
    languages: languages.length >= 2 ? listNames(languages.map(languageName)) : 'languages',
    korean: languages.includes('ko'),
    domain: input.domain ?? '',
    next: input.next ?? '',
    brief: flags.brief,
    noisy: flags.noisy,
    honorifics: flags.honorifics,
  };
  return { system: render(SYSTEM_TEMPLATE, vars), user: render(USER_TEMPLATE, vars) };
}

/**
 * A rough token count: one per CJK, kana or Hangul character, one per 3 others (Gemma's
 * tokenizer gives about one per 4 Latin characters; this errs high).
 */
export function estimateTokens(text: string): number {
  let wide = 0;
  let narrow = 0;
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) >= 0x2e80) wide++;
    else narrow++;
  }
  return wide + Math.ceil(narrow / 3);
}

/** The longest answer to allow for `text`: room for a wordy translation, not for a runaway. */
export function maxOutputTokens(text: string): number {
  return Math.min(200, Math.max(48, estimateTokens(text) * 3 + 24));
}

/**
 * The prompt for `input`, within `budget` tokens of prompt: the oldest context lines go first,
 * then glossary entries, if it would be longer.
 */
export function fitPrompt(input: PromptInput, budget: number): Prompt {
  let context = [...input.context];
  let glossary = [...(input.glossary ?? [])];
  for (;;) {
    const prompt = buildPrompt({ ...input, context, glossary });
    if (estimateTokens(prompt.system) + estimateTokens(prompt.user) <= budget) return prompt;
    if (context.length > 0) context = context.slice(1);
    else if (glossary.length > 0) glossary = glossary.slice(0, -1);
    else return prompt;
  }
}
