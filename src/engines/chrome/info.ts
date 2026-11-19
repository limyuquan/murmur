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
    "Chrome's own on-device speech recognition. Nothing to download from Earshot; Chrome fetches a pack per language.",
  runtime: 'chrome',
  // Runs in Chrome's speech service, not on Earshot's GPU or CPU budget.
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

export const CHROME_TRANSLATOR_INFO: TranslationEngineInfo = {
  kind: 'translation',
  id: CHROME_TRANSLATOR_ID,
  label: 'Chrome translation (on this device)',
  description:
    "Chrome's built-in translator. Fast; Chrome fetches a small pack per language pair. Plain, literal translations.",
  runtime: 'chrome',
  requirements: { backends: ['none'] },
  inputs: ['text'],
  sources: 'any',
  targets: 'any',
  streaming: false,
  usesContext: false,
  homepage: 'https://developer.chrome.com/docs/ai/translator-api',
};
