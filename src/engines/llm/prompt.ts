/**
 * The translation prompt for the LLM engine (prompt v2, as benchmarked): a system message that
 * says what to do, and a user turn with the glossary entries the line uses, the last few finished
 * lines (each with its language and translation) and the line itself, with the language the
 * speech engine heard it in.
 *
 * Templates use a tiny mustache subset, rendered exactly as the benchmark rendered them:
 * `{{var}}` substitutes, `{{#var}}…{{/var}}` keeps the block when `var` is set, `{{^var}}…{{/var}}`
 * when it isn't, and the result is trimmed.
 *
 * Murmur's wording differs from the benchmarked one in two places, both filled in from the line:
 * - the languages the source may mix are the session's (spoken languages, the line's, the earlier
 *   lines' and the target), not a fixed list; with fewer than two known, just "languages";
 * - the sentence on Korean address terms is there only when Korean is among them.
 * With the benchmark's languages (and its kind of video as `domain`), the prompt is byte for byte
 * the benchmarked one.
 */
import type { LanguageTag } from '../types';
import { UNKNOWN_LANGUAGE } from '../types';

export const SYSTEM_TEMPLATE =
  'You translate live video subtitles{{#domain}} ({{domain}}){{/domain}} into {{target_lang}}. Output ONLY the {{target_lang}} subtitle for CURRENT: no notes, no quotes, no preamble, no source text.\n' +
  "Style: natural, casual spoken {{target_lang}}; keep the speaker's tone, jokes and attitude; do not explain.\n" +
  '{{#brief}}Keep it short enough to read at a glance: at most 2 lines of about 42 characters. Drop fillers (음, 어, 그, 아니, あの, えっと, um), stutters and repeated words, but keep every piece of meaning.\n' +
  '{{/brief}}The source may mix {{languages}}, even inside one line. Translate every part of CURRENT, whatever its language; never skip a part because it is in another language. If a part is already in {{target_lang}}, keep it.\n' +
  '{{#noisy}}CURRENT comes from automatic speech recognition and may contain misrecognised words. If a word looks wrong, infer the intended word from the context and the glossary (names are often misheard), but never invent content. If CURRENT is unintelligible, output "…".\n' +
  '{{/noisy}}Write names of people, groups, fandoms and shows with their official romanised spelling{{#glossary}}, exactly as in the GLOSSARY{{/glossary}}; never translate a name as a word.\n' +
  '{{#korean}}{{#honorifics}}Keep Korean address terms the fans know as romanised words (oppa, unnie, hyung, noona, sunbae, maknae).\n' +
  "{{/honorifics}}{{^honorifics}}Translate Korean address terms (언니, 오빠, 형, 누나, 선배) naturally: usually the person's name or nothing; keep them romanised only when used as a nickname.\n" +
  '{{/honorifics}}{{/korean}}\n';

export const USER_TEMPLATE =
  '{{#glossary}}GLOSSARY: {{glossary}}\n' +
  '{{/glossary}}{{#context}}CONTEXT (earlier lines, already translated; do not translate again):\n' +
  '{{context}}\n' +
  '{{/context}}{{#source_lang}}CURRENT ({{source_lang}}, auto-detected): {{/source_lang}}{{^source_lang}}CURRENT: {{/source_lang}}{{text}}\n';

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
  /** Glossary entries the line or its context uses. */
  glossary?: readonly { source: string; target: string }[];
  /** Languages the person said they hear, in their order. */
  spokenLanguages?: readonly LanguageTag[];
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
  for (const tag of [
    ...(input.spokenLanguages ?? []),
    ...input.context.map((c) => c.language),
    source,
    input.targetLanguage,
  ]) {
    // Only languages with a name: a tag the browser doesn't know says nothing to the model.
    if (!known(tag) || languageName(primary(tag)) === primary(tag)) continue;
    if (!languages.includes(primary(tag))) languages.push(primary(tag));
  }
  const context = input.context
    .map((c) => `[${known(c.language) ? c.language : '?'}] ${c.source} => ${c.translation}`)
    .join('\n');
  const glossary = (input.glossary ?? []).map((g) => `${g.source} = ${g.target}`).join('; ');
  const vars: Vars = {
    text: input.text,
    target_lang: languageName(input.targetLanguage),
    source_lang: source ? languageName(source) : '',
    context,
    glossary,
    languages: languages.length >= 2 ? listNames(languages.map(languageName)) : 'languages',
    korean: languages.includes('ko'),
    domain: input.domain ?? '',
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
