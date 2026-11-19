/**
 * Chrome's built-in on-device AI, typed narrowly: on-device Web Speech (`SpeechRecognition` with
 * `processLocally`), `Translator` and `LanguageDetector`. Found on window-like globals only
 * (extension pages and the offscreen document, not the service worker). Every accessor returns
 * `null` when the API is missing, so callers can fail closed.
 *
 * Measured on Chrome 157 (Windows): see the engines' docs. Downloads of language packs need a
 * user gesture while their availability is `downloadable`; once `available`, the offscreen
 * document creates recognizers and translators without one.
 */
import type { LanguageTag } from '../types';

export type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

// ---------------------------------------------------------------------------------------------
// Web Speech

export interface SpeechAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

export interface SpeechResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechAlternative;
}

export interface SpeechResultEvent extends Event {
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [index: number]: SpeechResult };
}

export interface SpeechErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

export interface Recognizer extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  /** On-device only. Chrome 139+; absent means the browser can't promise on-device. */
  processLocally?: boolean;
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

export interface RecognizerOptions {
  langs: string[];
  processLocally: boolean;
}

export interface RecognizerClass {
  new (): Recognizer;
  available?(options: RecognizerOptions): Promise<Availability>;
  install?(options: RecognizerOptions): Promise<boolean>;
}

/** The unprefixed `SpeechRecognition` with the on-device statics, or null. */
export function speechRecognition(): RecognizerClass | null {
  const g = globalThis as { SpeechRecognition?: RecognizerClass };
  const ctor = g.SpeechRecognition;
  if (!ctor || typeof ctor.available !== 'function' || typeof ctor.install !== 'function') {
    return null;
  }
  return ctor;
}

/** Whether a fresh recognizer can be pinned to on-device recognition. */
export function canPinOnDevice(ctor: RecognizerClass): boolean {
  try {
    const r = new ctor();
    if (!('processLocally' in r)) return false;
    r.processLocally = true;
    return r.processLocally === true;
  } catch {
    return false;
  }
}

/**
 * The recognizer locale for a language: on-device packs are per locale (`ko-KR`), so a bare
 * primary tag gets its usual region. Tags that already have one are kept.
 */
export function recognizerLocale(tag: LanguageTag): string {
  if (tag.includes('-')) return tag;
  return DEFAULT_LOCALES[tag.toLowerCase()] ?? tag;
}

const DEFAULT_LOCALES: Record<string, string> = {
  ar: 'ar-SA',
  de: 'de-DE',
  en: 'en-US',
  es: 'es-ES',
  fr: 'fr-FR',
  hi: 'hi-IN',
  id: 'id-ID',
  it: 'it-IT',
  ja: 'ja-JP',
  ko: 'ko-KR',
  nl: 'nl-NL',
  pl: 'pl-PL',
  pt: 'pt-BR',
  ru: 'ru-RU',
  th: 'th-TH',
  tr: 'tr-TR',
  uk: 'uk-UA',
  vi: 'vi-VN',
  zh: 'zh-CN',
};

// ---------------------------------------------------------------------------------------------
// Translator / LanguageDetector

export interface DownloadMonitor {
  addEventListener(type: 'downloadprogress', cb: (event: { loaded: number }) => void): void;
}

export interface CreateOptions {
  signal?: AbortSignal;
  monitor?: (m: DownloadMonitor) => void;
}

export interface TranslatorInstance {
  translate(text: string, options?: { signal?: AbortSignal }): Promise<string>;
  translateStreaming?(text: string, options?: { signal?: AbortSignal }): ReadableStream<string>;
  destroy(): void;
}

export interface TranslatorClass {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>;
  create(
    options: { sourceLanguage: string; targetLanguage: string } & CreateOptions,
  ): Promise<TranslatorInstance>;
}

export interface DetectorInstance {
  detect(text: string): Promise<{ detectedLanguage: string; confidence: number }[]>;
  destroy(): void;
}

export interface DetectorClass {
  availability(options?: { expectedInputLanguages?: string[] }): Promise<Availability>;
  create(
    options?: CreateOptions & { expectedInputLanguages?: string[] },
  ): Promise<DetectorInstance>;
}

export function translatorApi(): TranslatorClass | null {
  return (globalThis as { Translator?: TranslatorClass }).Translator ?? null;
}

export function detectorApi(): DetectorClass | null {
  return (globalThis as { LanguageDetector?: DetectorClass }).LanguageDetector ?? null;
}

/**
 * The tag the Translator API wants: a primary subtag, except Chinese, where script matters
 * (`zh` = Simplified, `zh-Hant` = Traditional).
 */
export function translatorLanguage(tag: LanguageTag): string {
  const lower = tag.toLowerCase();
  if (lower.startsWith('zh')) {
    return /hant|-tw|-hk|-mo/.test(lower) ? 'zh-Hant' : 'zh';
  }
  return lower.split('-')[0] ?? lower;
}
