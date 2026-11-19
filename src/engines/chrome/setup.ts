/**
 * Language packs for Chrome's built-in engines: what's missing, and starting a download.
 *
 * Chrome downloads speech and translation packs itself (tens to hundreds of MB, minutes each),
 * but only starts one from a user gesture while the pack is `downloadable`. So:
 *
 * - The offscreen document (no gestures) checks with `missingSetup` when an engine loads, and
 *   rejects with `EngineActionRequiredError` listing the `SetupAction`s it needs. A pack that is
 *   already `downloading` is waited for instead (the load reports progress).
 * - A page with a click (popup, options, welcome) calls `runSetupAction(action)` straight from the
 *   click handler, before any `await`: each call uses up the click's activation, so run one action
 *   per click. The download carries on if the page closes; `setupState` tells how far it got.
 *
 * Works in any window-like context (extension pages, offscreen document); not the service worker.
 */
import type { LanguageTag, SetupAction } from '../types';
import {
  type Availability,
  type DownloadMonitor,
  detectorApi,
  recognizerLocale,
  speechRecognition,
  translatorApi,
  translatorLanguage,
} from './api';
import { CHROME_TRANSLATOR_ID, CHROME_WEBSPEECH_ID } from './info';

/** Plain language name ("Korean"), for labels. */
export function languageName(tag: LanguageTag): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** One action for every listed speech pack: `install()` takes them all on one click. */
export function speechAction(languages: readonly LanguageTag[]): SetupAction {
  const locales = [...new Set(languages.map(recognizerLocale))].sort();
  const names = locales.map((l) => languageName(l.split('-')[0] ?? l));
  return {
    id: `speech:${locales.join(',')}`,
    kind: 'speech-pack',
    label: `Download ${list(names)} speech recognition`,
    languages: locales,
  };
}

export function translationAction(source: LanguageTag, target: LanguageTag): SetupAction {
  const s = translatorLanguage(source);
  const t = translatorLanguage(target);
  return {
    id: `translation:${s}>${t}`,
    kind: 'translation-pack',
    label: `Download ${languageName(s)} to ${languageName(t)} translation`,
    languages: [s, t],
  };
}

export const DETECTOR_ACTION: SetupAction = {
  id: 'detector',
  kind: 'language-detector',
  label: 'Download language detection',
  languages: [],
};

/** Where an action's download stands. The least ready pack wins for a multi-pack action. */
export async function setupState(action: SetupAction): Promise<Availability> {
  switch (action.kind) {
    case 'speech-pack': {
      const sr = speechRecognition();
      if (!sr?.available) return 'unavailable';
      const states = await Promise.all(
        action.languages.map((l) =>
          (sr.available as NonNullable<typeof sr.available>)({ langs: [l], processLocally: true }),
        ),
      );
      return leastReady(states);
    }
    case 'translation-pack': {
      const api = translatorApi();
      const [sourceLanguage, targetLanguage] = action.languages;
      if (!api || !sourceLanguage || !targetLanguage) return 'unavailable';
      return api.availability({ sourceLanguage, targetLanguage });
    }
    case 'language-detector': {
      const api = detectorApi();
      return api ? api.availability() : 'unavailable';
    }
  }
}

/**
 * Starts the action's download. Call it synchronously from a click handler (it makes the API
 * call before awaiting anything). Resolves when Chrome reports the pack ready; `onProgress` gets
 * 0–1 where Chrome reports it (translation and detection; speech reports none).
 */
export function runSetupAction(
  action: SetupAction,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const monitor = (m: DownloadMonitor) =>
    m.addEventListener('downloadprogress', (e) => onProgress?.(e.loaded));
  switch (action.kind) {
    case 'speech-pack': {
      const sr = speechRecognition();
      if (!sr?.install) return Promise.reject(new Error('On-device speech is not available.'));
      return sr.install({ langs: [...action.languages], processLocally: true }).then((ok) => {
        if (!ok) throw new Error(`Chrome could not download ${action.label.toLowerCase()}.`);
      });
    }
    case 'translation-pack': {
      const api = translatorApi();
      const [sourceLanguage, targetLanguage] = action.languages;
      if (!api || !sourceLanguage || !targetLanguage) {
        return Promise.reject(new Error('Chrome translation is not available.'));
      }
      return api.create({ sourceLanguage, targetLanguage, monitor }).then((t) => t.destroy());
    }
    case 'language-detector': {
      const api = detectorApi();
      if (!api) return Promise.reject(new Error('Chrome language detection is not available.'));
      return api.create({ monitor }).then((d) => d.destroy());
    }
  }
}

export interface SetupNeeds {
  /** Recognizer languages (on-device speech). */
  speech?: readonly LanguageTag[];
  /** Translation pairs, [source, target]. */
  translation?: readonly (readonly [LanguageTag, LanguageTag])[];
  detector?: boolean;
}

export interface SetupReport {
  /** Downloads only the person can start. */
  actions: SetupAction[];
  /** Downloads under way (wait for these). */
  downloading: SetupAction[];
  /** Packs Chrome doesn't offer on this device at all. */
  unavailable: SetupAction[];
}

/** Sorts what `needs` asks for by availability. Speech packs are checked one language at a time. */
export async function missingSetup(needs: SetupNeeds): Promise<SetupReport> {
  const report: SetupReport = { actions: [], downloading: [], unavailable: [] };
  const sort = (action: SetupAction, state: Availability) => {
    if (state === 'downloadable') report.actions.push(action);
    else if (state === 'downloading') report.downloading.push(action);
    else if (state === 'unavailable') report.unavailable.push(action);
  };
  const speechMissing: LanguageTag[] = [];
  for (const language of needs.speech ?? []) {
    const single = speechAction([language]);
    const state = await setupState(single);
    if (state === 'downloadable') speechMissing.push(language);
    else sort(single, state);
  }
  // One button for every missing speech pack: install() takes them on one click.
  if (speechMissing.length > 0) report.actions.push(speechAction(speechMissing));
  for (const [source, target] of needs.translation ?? []) {
    const action = translationAction(source, target);
    sort(action, await setupState(action));
  }
  if (needs.detector) sort(DETECTOR_ACTION, await setupState(DETECTOR_ACTION));
  return report;
}

/** Polls until none of `actions` is downloading (or `signal` aborts). */
export async function waitForDownloads(
  actions: readonly SetupAction[],
  signal?: AbortSignal,
  intervalMs = 2000,
): Promise<void> {
  for (;;) {
    signal?.throwIfAborted();
    const states = await Promise.all(actions.map(setupState));
    if (!states.includes('downloading')) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, intervalMs);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }
}

function leastReady(states: readonly Availability[]): Availability {
  for (const s of ['unavailable', 'downloadable', 'downloading'] as const) {
    if (states.includes(s)) return s;
  }
  return 'available';
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** Chrome's speech recognition runs one recognizer per language, at most this many. */
export const MAX_RECOGNIZERS = 4;

/**
 * The language packs a session with these engines and languages needs, one action per pack (for
 * the model manager's list): a speech pack per spoken language (the first `MAX_RECOGNIZERS`) with
 * Chrome's speech recognition, a translation pack per spoken language into the target with
 * Chrome's translator.
 */
export function packsFor(options: {
  asr: string;
  translation: string;
  spoken: readonly LanguageTag[];
  target: LanguageTag;
}): SetupAction[] {
  const out: SetupAction[] = [];
  if (options.asr === CHROME_WEBSPEECH_ID) {
    for (const l of options.spoken.slice(0, MAX_RECOGNIZERS)) out.push(speechAction([l]));
  }
  if (options.translation === CHROME_TRANSLATOR_ID) {
    const target = translatorLanguage(options.target);
    for (const l of options.spoken) {
      if (translatorLanguage(l) !== target) out.push(translationAction(l, options.target));
    }
  }
  return out;
}
