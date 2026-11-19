import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  estimateTokens,
  fitPrompt,
  maxOutputTokens,
  render,
} from '@/engines/llm/prompt';

/**
 * Golden prompts: what the benchmark's own renderer (prompt v2) gives for these inputs, with
 * Murmur's two generic changes (the session's languages, no fixed kind of video). Any change to
 * the wording changes what was measured: re-run the benchmark before updating these.
 */
/** Prompts as the benchmark renderer gives them for the same inputs (generated, not hand-written). */
const GOLDEN = {
  a: {
    system:
      'You translate live video subtitles into English. Output ONLY the English subtitle for CURRENT: no notes, no quotes, no preamble, no source text.\nStyle: natural, casual spoken English; keep the speaker\'s tone, jokes and attitude; do not explain.\nThe source may mix French and English, even inside one line. Translate every part of CURRENT, whatever its language; never skip a part because it is in another language. If a part is already in English, keep it.\nCURRENT comes from automatic speech recognition and may contain misrecognised words. If a word looks wrong, infer the intended word from the context and the glossary (names are often misheard), but never invent content. If CURRENT is unintelligible, output "…".\nWrite names of people, groups, fandoms and shows with their official romanised spelling, exactly as in the GLOSSARY; never translate a name as a word.',
    user: "GLOSSARY: Camille = Camille; tarte Tatin = tarte Tatin\nCONTEXT (earlier lines, already translated; do not translate again):\n[fr] Bonjour à tous. => Hello, everyone.\n[?] Merci d'être là. => Thanks for being here.\nCURRENT (French, auto-detected): Aujourd'hui, Camille prépare une tarte.",
  },
  b: {
    system:
      "You translate live video subtitles into German. Output ONLY the German subtitle for CURRENT: no notes, no quotes, no preamble, no source text.\nStyle: natural, casual spoken German; keep the speaker's tone, jokes and attitude; do not explain.\nKeep it short enough to read at a glance: at most 2 lines of about 42 characters. Drop fillers (음, 어, 그, 아니, あの, えっと, um), stutters and repeated words, but keep every piece of meaning.\nThe source may mix languages, even inside one line. Translate every part of CURRENT, whatever its language; never skip a part because it is in another language. If a part is already in German, keep it.\nWrite names of people, groups, fandoms and shows with their official romanised spelling; never translate a name as a word.",
    user: 'CURRENT: Guten Morgen',
  },
  c: {
    system:
      'You translate live video subtitles into English. Output ONLY the English subtitle for CURRENT: no notes, no quotes, no preamble, no source text.\nStyle: natural, casual spoken English; keep the speaker\'s tone, jokes and attitude; do not explain.\nThe source may mix Korean and English, even inside one line. Translate every part of CURRENT, whatever its language; never skip a part because it is in another language. If a part is already in English, keep it.\nCURRENT comes from automatic speech recognition and may contain misrecognised words. If a word looks wrong, infer the intended word from the context and the glossary (names are often misheard), but never invent content. If CURRENT is unintelligible, output "…".\nWrite names of people, groups, fandoms and shows with their official romanised spelling; never translate a name as a word.\nTranslate Korean address terms (언니, 오빠, 형, 누나, 선배) naturally: usually the person\'s name or nothing; keep them romanised only when used as a nickname.',
    user: 'CURRENT (Korean, auto-detected): 안녕하세요',
  },
};

describe('LLM prompt', () => {
  it('renders the benchmarked prompt byte for byte', () => {
    expect(
      buildPrompt({
        text: "Aujourd'hui, Camille prépare une tarte.",
        sourceLanguage: 'fr',
        targetLanguage: 'en',
        context: [
          { source: 'Bonjour à tous.', translation: 'Hello, everyone.', language: 'fr' },
          { source: "Merci d'être là.", translation: 'Thanks for being here.', language: 'und' },
        ],
        glossary: [
          { source: 'Camille', target: 'Camille' },
          { source: 'tarte Tatin', target: 'tarte Tatin' },
        ],
        spokenLanguages: ['fr'],
      }),
    ).toEqual(GOLDEN.a);
    // Language not known, one language only, other flags.
    expect(
      buildPrompt({
        text: 'Guten Morgen',
        sourceLanguage: 'und',
        targetLanguage: 'de',
        context: [],
        flags: { brief: true, noisy: false },
      }),
    ).toEqual(GOLDEN.b);
    // Korean among the languages: its sentence on address terms.
    expect(
      buildPrompt({ text: '안녕하세요', sourceLanguage: 'ko', targetLanguage: 'en', context: [] }),
    ).toEqual(GOLDEN.c);
  });

  it('names every language of the session, the line and its context', () => {
    const p = buildPrompt({
      text: 'Ciao a tutti',
      sourceLanguage: 'it',
      targetLanguage: 'en',
      context: [{ source: 'Hola', translation: 'Hi', language: 'es' }],
      spokenLanguages: ['fr', 'xyzzy'],
    });
    expect(p.system).toContain('The source may mix French, Spanish, Italian and English,');
    expect(p.user).toBe(
      'CONTEXT (earlier lines, already translated; do not translate again):\n[es] Hola => Hi\nCURRENT (Italian, auto-detected): Ciao a tutti',
    );
    expect(p.system).not.toContain('Korean');
  });

  it('names every language of a line that mixes them', () => {
    const prompt = buildPrompt({
      text: 'That is so 귀여워 honestly',
      sourceLanguage: 'ko',
      targetLanguage: 'en',
      context: [],
      mixed: ['ko', 'en'],
    });
    expect(prompt.user).toBe(
      'CURRENT (Korean and English, auto-detected): That is so 귀여워 honestly',
    );
    expect(prompt.system).toContain('The source may mix Korean and English, even inside one line.');
    expect(prompt.system).toContain('If a part is already in English, keep it.');
    const unknown = buildPrompt({
      text: '이거 진짜 good idea',
      sourceLanguage: 'und',
      targetLanguage: 'ko',
      context: [],
      mixed: ['und', 'ko'],
    });
    expect(unknown.user).toBe(
      'CURRENT (Korean and another language, auto-detected): 이거 진짜 good idea',
    );
  });

  it('renders sections, nested ones and variables, then trims', () => {
    expect(render('{{#a}}A{{#b}}B{{/b}}{{^b}}not B{{/b}}{{/a}} {{x}}\n', { a: true, x: 'y' })).toBe(
      'Anot B y',
    );
    expect(render('{{^a}}none{{/a}}{{missing}}', {})).toBe('none');
    // Values are inserted as they are, even when they look like a template.
    expect(render('{{text}}', { text: '{{#a}}$1 $&{{/a}}' })).toBe('{{#a}}$1 $&{{/a}}');
  });

  it('drops the oldest context lines, then glossary entries, to fit the token budget', () => {
    const input = {
      text: 'Bonjour',
      sourceLanguage: 'fr',
      targetLanguage: 'en',
      context: [1, 2, 3].map((n) => ({
        source: `ligne ${n} `.repeat(40),
        translation: `line ${n} `.repeat(40),
        language: 'fr',
      })),
      glossary: [{ source: 'Bonjour', target: 'Hello' }],
    };
    const full = buildPrompt(input);
    const budget = estimateTokens(full.system) + estimateTokens(full.user) - 50;
    const fitted = fitPrompt(input, budget);
    expect(fitted.user).not.toContain('ligne 1');
    expect(fitted.user).toContain('ligne 3');
    expect(fitted.user).toContain('GLOSSARY: Bonjour = Hello');
    expect(fitPrompt(input, 0).user).toBe('CURRENT (French, auto-detected): Bonjour');
  });

  it('allows an answer long enough for the line, within limits', () => {
    expect(maxOutputTokens('Oui')).toBe(48);
    expect(maxOutputTokens('가나다라마바사아자차카타파하')).toBe(14 * 3 + 24);
    expect(maxOutputTokens('word '.repeat(400))).toBe(200);
  });
});
