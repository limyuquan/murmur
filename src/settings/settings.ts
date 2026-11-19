/**
 * User settings, one object in `chrome.storage.local` under `SETTINGS_KEY`. Read by the service
 * worker (which engines and languages a session uses), the overlay content script (how subtitles
 * look) and edited by the options page and popup. The offscreen document has no storage access:
 * it gets what it needs in the session's start command.
 *
 * Adding a setting: add it to `Settings` and `DEFAULT_SETTINGS`, and validate it in
 * `mergeSettings`. Stored objects are merged over the defaults on read, so old data keeps working.
 */
import { browser } from 'wxt/browser';
import { DEMO_ASR_ID, DEMO_TRANSLATION_ID, type ProfileChoice } from '@/engines/profiles';
import type { LanguageTag } from '@/engines/types';

export const SETTINGS_KEY = 'settings';

export type CaptionDisplay = 'both' | 'translation' | 'original';
export type CaptionPosition = 'bottom' | 'top';

export interface OverlaySettings {
  /** Which lines to show. `both` puts the original (smaller) above the translation. */
  display: CaptionDisplay;
  position: CaptionPosition;
  /** Multiplies the default size (a share of the video height). 0.5–2. */
  fontScale: number;
  /** Opacity of the box behind each line, 0–1. */
  backgroundOpacity: number;
  /** Show text that may still change, dimmed. */
  showPartials: boolean;
}

export interface Settings {
  /** Language subtitles are translated into. */
  targetLanguage: LanguageTag;
  /** `auto` detects the language of every segment; a tag only hints the engine. */
  sourceLanguage: 'auto' | LanguageTag;
  profile: ProfileChoice;
  /** Engines for `profile: 'custom'`. */
  custom: { asr: string; translation: string };
  /** Translate partial lines as a preview (more work, earlier text). */
  translatePartials: boolean;
  overlay: OverlaySettings;
}

export const DEFAULT_SETTINGS: Settings = {
  targetLanguage: 'en',
  sourceLanguage: 'auto',
  profile: 'balanced',
  custom: { asr: DEMO_ASR_ID, translation: DEMO_TRANSLATION_ID },
  translatePartials: false,
  overlay: {
    display: 'both',
    position: 'bottom',
    fontScale: 1,
    backgroundOpacity: 0.75,
    showPartials: true,
  },
};

export type SettingsPatch = Partial<Omit<Settings, 'overlay' | 'custom'>> & {
  overlay?: Partial<OverlaySettings>;
  custom?: Partial<Settings['custom']>;
};

const TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** Merges a stored (possibly partial, outdated or hand-edited) object over `base`. */
export function mergeSettings(stored: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const s = (isObject(stored) ? stored : {}) as SettingsPatch;
  const o = (isObject(s.overlay) ? s.overlay : {}) as Partial<OverlaySettings>;
  const c = (isObject(s.custom) ? s.custom : {}) as Partial<Settings['custom']>;
  const d = base;
  return {
    targetLanguage: isTag(s.targetLanguage) ? s.targetLanguage : d.targetLanguage,
    sourceLanguage:
      s.sourceLanguage === 'auto' || isTag(s.sourceLanguage) ? s.sourceLanguage : d.sourceLanguage,
    profile: oneOf(s.profile, ['light', 'balanced', 'best', 'custom'] as const, d.profile),
    custom: {
      asr: typeof c.asr === 'string' && c.asr ? c.asr : d.custom.asr,
      translation:
        typeof c.translation === 'string' && c.translation ? c.translation : d.custom.translation,
    },
    translatePartials: bool(s.translatePartials, d.translatePartials),
    overlay: {
      display: oneOf(o.display, ['both', 'translation', 'original'] as const, d.overlay.display),
      position: oneOf(o.position, ['bottom', 'top'] as const, d.overlay.position),
      fontScale: num(o.fontScale, 0.5, 2, d.overlay.fontScale),
      backgroundOpacity: num(o.backgroundOpacity, 0, 1, d.overlay.backgroundOpacity),
      showPartials: bool(o.showPartials, d.overlay.showPartials),
    },
  };
}

/** Applies `patch` to `current` (nested objects merged one level deep), validated. */
export function applyPatch(current: Settings, patch: SettingsPatch): Settings {
  return mergeSettings(
    {
      ...current,
      ...patch,
      overlay: { ...current.overlay, ...patch.overlay },
      custom: { ...current.custom, ...patch.custom },
    },
    current,
  );
}

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  return mergeSettings(stored[SETTINGS_KEY]);
}

export async function saveSettings(patch: SettingsPatch): Promise<Settings> {
  const next = applyPatch(await loadSettings(), patch);
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Calls `listener` with the new settings whenever they change. Returns an unsubscribe. */
export function watchSettings(listener: (settings: Settings) => void): () => void {
  const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string): void => {
    const change = changes[SETTINGS_KEY];
    if (area === 'local' && change) listener(mergeSettings(change.newValue));
  };
  browser.storage.onChanged.addListener(onChanged);
  return () => browser.storage.onChanged.removeListener(onChanged);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isTag(v: unknown): v is string {
  return typeof v === 'string' && TAG.test(v);
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function num(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}
