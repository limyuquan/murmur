/**
 * Static info for Chrome's built-in engines, apart from their code so the registry can list them
 * without loading them.
 */
import type { AsrEngineInfo, TranslationEngineInfo } from '../types';

export const CHROME_WEBSPEECH_ID = 'chrome-webspeech';
export const CHROME_TRANSLATOR_ID = 'chrome-translator';

export const CHROME_WEBSPEECH_INFO: AsrEngineInfo = {
  kind: 'asr',
  id: CHROME_WEBSPEECH_ID,
  label: 'Chrome speech recognition (on this device)',
  description:
    'Chrome’s own on-device speech recognition. Nothing to download from Murmur; Chrome fetches a pack per language.',
  runtime: 'chrome',
  // Runs in Chrome's speech service, not on Murmur's GPU or CPU budget.
  requirements: { backends: ['none'] },
  // Locales Chrome offers on-device packs for; each is checked when a session starts.
  languages: [
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
    'th',
    'tr',
    'uk',
    'vi',
    'zh',
  ],
  streaming: true,
  // One recognizer per spoken language; each line goes to the one that heard it best.
  detectsLanguage: true,
  codeSwitching: false,
  audioInput: 'track',
  homepage: 'https://developer.chrome.com/docs/web-platform/web-speech-on-device',
};

/**
 * Languages Chrome's on-device translator offers (Chrome's Translator API documentation, Chrome
 * 138+), as it names them: `iw` stays Hebrew's old code in some builds, so both are listed.
 * Whether a pair is ready is checked per pair at run time; a pair Chrome reports `unavailable`
 * marks its language unsupported for the session.
 */
export const CHROME_TRANSLATOR_LANGUAGES = [
  'ar',
  'bg',
  'bn',
  'cs',
  'da',
  'de',
  'el',
  'en',
  'es',
  'fi',
  'fr',
  'he',
  'hi',
  'hr',
  'hu',
  'id',
  'it',
  'iw',
  'ja',
  'kn',
  'ko',
  'lt',
  'mr',
  'nl',
  'no',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sl',
  'sv',
  'ta',
  'te',
  'th',
  'tr',
  'uk',
  'vi',
  'zh',
  'zh-Hant',
] as const;

export const CHROME_TRANSLATOR_INFO: TranslationEngineInfo = {
  kind: 'translation',
  id: CHROME_TRANSLATOR_ID,
  label: 'Chrome translation (on this device)',
  description:
    'Chrome’s built-in translator. Fast; Chrome fetches a small pack per language pair. Plain, literal translations.',
  runtime: 'chrome',
  requirements: { backends: ['none'] },
  inputs: ['text'],
  sources: CHROME_TRANSLATOR_LANGUAGES,
  targets: CHROME_TRANSLATOR_LANGUAGES,
  streaming: false,
  usesContext: false,
  homepage: 'https://developer.chrome.com/docs/ai/translator-api',
};
