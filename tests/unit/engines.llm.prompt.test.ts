import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  estimateTokens,
  fitPrompt,
  maxOutputTokens,
  render,
} from '@/engines/llm/prompt';

/**
 * Golden prompts: what the benchmark's own renderer gives for these inputs with prompt v3, with
 * the session's languages and no kind of video. Any change to the wording changes what was
 * measured: re-run the benchmark before updating these.
 */
/** Prompts as the benchmark renderer gives them for the same inputs (generated, not hand-written). */
const GOLDEN = {
  a: {
    system:
      'Translate CURRENT, one line of live video subtitles, into English. Reply with the subtitle only.\nUse natural, casual spoken English and keep the speaker\'s tone.\nLines may mix French and English: translate every part; keep parts already in English.\nCURRENT is an automatic transcript: fix misheard words from the context and glossary, but never invent content. Leave out a word you cannot make sense of instead of guessing a sound-alike. If nothing is intelligible, reply "…".\nNames: official romanised spelling, as in the GLOSSARY, spelt the same as in the earlier lines; never translate a name.',
    user: "GLOSSARY: Camille = Camille; tarte Tatin = tarte Tatin\nEARLIER LINES (context only):\n[fr] Bonjour à tous. => Hello, everyone.\n[?] Merci d'être là. => Thanks for being here.\nCURRENT (French): Aujourd'hui, Camille prépare une tarte.",
  },
  b: {
    system:
      "Translate CURRENT, one line of live video subtitles, into German. Reply with the subtitle only.\nUse natural, casual spoken German and keep the speaker's tone.\nKeep it short enough to read at a glance: at most 2 lines of about 42 characters. Drop fillers (음, 어, 그, 아니, あの, えっと, um), stutters and repeated words, but keep every piece of meaning.\nLines may mix languages: translate every part; keep parts already in German.\nNames: official romanised spelling, spelt the same as in the earlier lines; never translate a name.",
    user: 'CURRENT: Guten Morgen',
  },
  c: {
    system:
      'Translate CURRENT, one line of live video subtitles, into English. Reply with the subtitle only.\nUse natural, casual spoken English and keep the speaker\'s tone.\nLines may mix Korean and English: translate every part; keep parts already in English.\nCURRENT is an automatic transcript: fix misheard words from the context, but never invent content. Leave out a word you cannot make sense of instead of guessing a sound-alike. If nothing is intelligible, reply "…".\nNames: official romanised spelling, spelt the same as in the earlier lines; never translate a name.\nKorean address terms (언니, 오빠, 형, 누나, 선배) are not names: use the person\'s name or leave them out; never write unnie, oppa, hyung or noona.',
    user: 'CURRENT (Korean): 안녕하세요',
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
    expect(p.system).toContain('Lines may mix French, Spanish, Italian and English:');
    expect(p.user).toBe(
      'EARLIER LINES (context only):\n[es] Hola => Hi\nCURRENT (Italian): Ciao a tutti',
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
    expect(prompt.user).toBe('CURRENT (Korean and English): That is so 귀여워 honestly');
    expect(prompt.system).toContain('Lines may mix Korean and English: translate every part;');
    expect(prompt.system).toContain('keep parts already in English.');
    const unknown = buildPrompt({
      text: '이거 진짜 good idea',
      sourceLanguage: 'und',
      targetLanguage: 'ko',
      context: [],
      mixed: ['und', 'ko'],
    });
    expect(unknown.user).toBe('CURRENT (Korean and another language): 이거 진짜 good idea');
  });

  it('renders sections, nested ones and variables, then trims', () => {
    expect(render('{{#a}}A{{#b}}B{{/b}}{{^b}}not B{{/b}}{{/a}} {{x}}\n', { a: true, x: 'y' })).toBe(
      'Anot B y',
    );
    expect(render('{{^a}}none{{/a}}{{missing}}', {})).toBe('none');
    // Values are inserted as they are, even when they look like a template.
    expect(render('{{text}}', { text: '{{#a}}$1 $&{{/a}}' })).toBe('{{#a}}$1 $&{{/a}}');
  });

  it('gives each glossary entry as the alias that matched, with its note', () => {
    const { user } = buildPrompt({
      text: 'On a vu Loumen hier.',
      sourceLanguage: 'fr',
      targetLanguage: 'en',
      context: [],
      glossary: [
        { source: 'Loumen', target: 'Lumen', note: 'a band' },
        { source: 'Camille', target: 'Camille' },
      ],
    });
    expect(user).toBe(
      'GLOSSARY: Loumen = Lumen (a band); Camille = Camille\nCURRENT (French): On a vu Loumen hier.',
    );
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
    expect(fitPrompt(input, 0).user).toBe('CURRENT (French): Bonjour');
  });

  it('allows an answer long enough for the line, within limits', () => {
    expect(maxOutputTokens('Oui')).toBe(48);
    expect(maxOutputTokens('가나다라마바사아자차카타파하')).toBe(14 * 3 + 24);
    expect(maxOutputTokens('word '.repeat(400))).toBe(200);
  });
});
