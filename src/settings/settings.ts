/**
 * User settings, one object in `chrome.storage.local` under `SETTINGS_KEY`. Read by the service
 * worker (which engines and languages a session uses), the overlay content script (how subtitles
 * look) and edited by the options page and popup. The offscreen document has no storage access:
 * it gets what it needs in the session's start command.
 *
 * Adding a setting: add it to `Settings` and `DEFAULT_SETTINGS`, and validate it in
 * `mergeSettings`. Stored objects are merged over the defaults on read, so old data keeps working.
 * Changing a default: every save stores the whole object, so a stored value equal to the old
 * default may never have been chosen. Bump `SETTINGS_VERSION` and decide in `migrate`.
 *
 * Writing: only through `saveSettings`, with the fields changed (or a function of the current
 * settings). It reads, patches and stores under a Web Lock shared by every extension context, so
 * two contexts writing at once never undo each other's change.
 */
import { browser } from 'wxt/browser';
// Not the ids from engines/profiles.ts: the overlay bundles settings, and shouldn't bundle the
// engine catalog with them.
import { DEMO_ASR_ID, DEMO_TRANSLATION_ID } from '@/engines/demo/ids';
import type { GlossaryEntry } from '@/engines/glossary';
import type { ProfileChoice } from '@/engines/profiles';
import type { LanguageTag } from '@/engines/types';

export const SETTINGS_KEY = 'settings';

/**
 * Version of the stored object (its `version` field; none before 2).
 * 2: subtitles show the translation only by default, no longer the original too.
 */
export const SETTINGS_VERSION = 2;

export type CaptionDisplay = 'both' | 'translation' | 'original';
export type CaptionPosition = 'bottom' | 'top';
/** Where the original goes relative to the translation in `both` mode. */
export type OriginalPlacement = 'above' | 'below';
/** What keeps text readable over the picture. */
export type CaptionBackground = 'box' | 'shadow' | 'outline';

export interface OverlaySettings {
  /**
   * Which lines to show (`translation` by default). `both` adds the original, smaller, next to
   * the translation. A line that needs no translation shows as said in every mode.
   */
  display: CaptionDisplay;
  position: CaptionPosition;
  originalPlacement: OriginalPlacement;
  /** Multiplies the default size (a share of the video height). 0.5–2. */
  fontScale: number;
  background: CaptionBackground;
  /** Opacity of the box behind each line (`box`), or of the shadow (`shadow`), 0–1. */
  backgroundOpacity: number;
  /** Show text that may still change, dimmed. */
  showPartials: boolean;
  /** Tag a line with its language when it differs from what is mostly being spoken. */
  languageTags: boolean;
  /** Move subtitles up while the player's controls or its own captions are showing. */
  avoidControls: boolean;
}

export interface Settings {
  /** Language subtitles are translated into. */
  targetLanguage: LanguageTag;
  /**
   * Languages the person expects to hear, in the order chosen (primary tags). Chrome's speech
   * recognition runs one recognizer for each of the first `MAX_SPOKEN_FOR_CHROME`; translation
   * packs are checked for each. Empty: the browser's languages (`spokenLanguages()`).
   */
  spokenLanguages: LanguageTag[];
  /**
   * Only these languages are spoken: engines that detect languages pick among them. Off (the
   * default), they detect any language for each line.
   */
  onlySpoken: boolean;
  profile: ProfileChoice;
  /**
   * Balanced runs the smaller speech model (Qwen3-ASR 0.6B, 1.1 GB) instead of the larger one
   * (1.7B, 2.3 GB): a smaller download, a little less accurate.
   */
  smallerSpeech: boolean;
  /** Engines for `profile: 'custom'`. */
  custom: { asr: string; translation: string };
  /** Translate partial lines as a preview (more work, earlier text). */
  translatePartials: boolean;
  /**
   * Names and terms with the rendering to keep (`source` as said, other ways it is said or
   * misheard in `aliases`, `target` as written, an optional `note`). Engines that take a
   * glossary get the entries each line uses.
   */
  glossary: GlossaryEntry[];
  overlay: OverlaySettings;
  /** Subtitles ahead of time (beta): see src/lookahead/README.md. */
  lookahead: LookaheadSettings;
  /**
   * Offers the person answered "Not now" to, by key (`better:<model ids>` for the popup's offer of
   * a better translation model), so they aren't made again.
   */
  dismissed: string[];
}

export interface LookaheadSettings {
  /**
   * Sites (`siteKey`: host name without `www.`) where Murmur reads the audio the page's player
   * has buffered, to make subtitles before the speech plays. Off everywhere until the person
   * turns it on for a site.
   */
  sites: string[];
  /** Off everywhere, whatever `sites` says (the kill switch). */
  off: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  targetLanguage: 'en',
  spokenLanguages: [],
  onlySpoken: false,
  profile: 'balanced',
  smallerSpeech: false,
  custom: { asr: DEMO_ASR_ID, translation: DEMO_TRANSLATION_ID },
  translatePartials: false,
  glossary: [],
  overlay: {
    display: 'translation',
    position: 'bottom',
    originalPlacement: 'above',
    fontScale: 1,
    background: 'box',
    backgroundOpacity: 0.75,
    showPartials: true,
    languageTags: true,
    avoidControls: true,
  },
  lookahead: { sites: [], off: false },
  dismissed: [],
};

/** Most dismissed offers kept. */
export const MAX_DISMISSED = 20;

/** Most sites with lookahead on. */
export const MAX_LOOKAHEAD_SITES = 100;
const SITE = /^[a-z0-9.-]{1,253}$/;

/** Chrome's speech recognition runs at most this many recognizers (engines/chrome/webspeech.ts). */
export const MAX_SPOKEN_FOR_CHROME = 4;
/** Most spoken languages kept. */
const MAX_SPOKEN = 12;
/** Most glossary entries kept, and the longest text on either side (each alias, the note). */
export const MAX_GLOSSARY = 500;
export const MAX_GLOSSARY_TEXT = 100;
/** Most ways one entry is said (its source and aliases). */
export const MAX_GLOSSARY_ALIASES = 8;

/**
 * The languages a session listens for: the chosen ones, or else the browser's own (its language
 * list, as primary tags among `offered`), or English.
 */
export function spokenLanguages(
  settings: Pick<Settings, 'spokenLanguages'>,
  browserLanguages: readonly string[] = globalThis.navigator?.languages ?? [],
  offered?: readonly string[],
): LanguageTag[] {
  if (settings.spokenLanguages.length > 0) return [...settings.spokenLanguages];
  const primary = browserLanguages
    .map((l) => l.split('-')[0]?.toLowerCase() ?? '')
    .filter((l) => l && (!offered || offered.includes(l)));
  const unique = [...new Set(primary)].slice(0, MAX_SPOKEN_FOR_CHROME);
  return unique.length > 0 ? unique : ['en'];
}

/** Sizes offered as quick choices (popup), as `fontScale`. */
export const SIZE_PRESETS = [
  { id: 'small', label: 'S', name: 'Small', scale: 0.8 },
  { id: 'medium', label: 'M', name: 'Medium', scale: 1 },
  { id: 'large', label: 'L', name: 'Large', scale: 1.3 },
] as const;

export type SettingsPatch = Partial<Omit<Settings, 'overlay' | 'custom' | 'lookahead'>> & {
  overlay?: Partial<OverlaySettings>;
  custom?: Partial<Settings['custom']>;
  lookahead?: Partial<LookaheadSettings>;
};

const TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** Merges a stored (possibly partial, outdated or hand-edited) object over `base`. */
export function mergeSettings(stored: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const s = (isObject(stored) ? stored : {}) as SettingsPatch;
  const o = (isObject(s.overlay) ? s.overlay : {}) as Partial<OverlaySettings>;
  const c = (isObject(s.custom) ? s.custom : {}) as Partial<Settings['custom']>;
  const l = (isObject(s.lookahead) ? s.lookahead : {}) as Partial<LookaheadSettings>;
  const d = base;
  return {
    targetLanguage: isTag(s.targetLanguage) ? s.targetLanguage : d.targetLanguage,
    spokenLanguages: Array.isArray(s.spokenLanguages)
      ? [...new Set(s.spokenLanguages.filter(isTag))].slice(0, MAX_SPOKEN)
      : d.spokenLanguages,
    onlySpoken: bool(s.onlySpoken, d.onlySpoken),
    profile: oneOf(s.profile, ['light', 'balanced', 'best', 'custom'] as const, d.profile),
    smallerSpeech: bool(s.smallerSpeech, d.smallerSpeech),
    custom: {
      asr: typeof c.asr === 'string' && c.asr ? c.asr : d.custom.asr,
      translation:
        typeof c.translation === 'string' && c.translation ? c.translation : d.custom.translation,
    },
    translatePartials: bool(s.translatePartials, d.translatePartials),
    glossary: Array.isArray(s.glossary) ? cleanGlossary(s.glossary) : d.glossary,
    overlay: {
      display: oneOf(o.display, ['both', 'translation', 'original'] as const, d.overlay.display),
      position: oneOf(o.position, ['bottom', 'top'] as const, d.overlay.position),
      originalPlacement: oneOf(
        o.originalPlacement,
        ['above', 'below'] as const,
        d.overlay.originalPlacement,
      ),
      fontScale: num(o.fontScale, 0.5, 2, d.overlay.fontScale),
      background: oneOf(o.background, ['box', 'shadow', 'outline'] as const, d.overlay.background),
      backgroundOpacity: num(o.backgroundOpacity, 0, 1, d.overlay.backgroundOpacity),
      showPartials: bool(o.showPartials, d.overlay.showPartials),
      languageTags: bool(o.languageTags, d.overlay.languageTags),
      avoidControls: bool(o.avoidControls, d.overlay.avoidControls),
    },
    lookahead: {
      sites: Array.isArray(l.sites)
        ? [
            ...new Set(l.sites.filter((x): x is string => typeof x === 'string' && SITE.test(x))),
          ].slice(0, MAX_LOOKAHEAD_SITES)
        : d.lookahead.sites,
      off: bool(l.off, d.lookahead.off),
    },
    dismissed: Array.isArray(s.dismissed)
      ? [
          ...new Set(
            s.dismissed.filter((x): x is string => typeof x === 'string' && x.length <= 200),
          ),
        ].slice(-MAX_DISMISSED)
      : d.dismissed,
  };
}

/**
 * The site key (host name, `www.` dropped) for what the person typed: an address or a host name.
 * Null when it isn't one (only http and https sites; a single-label name only for `localhost`).
 */
export function siteFromInput(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (!t || /\s/.test(t)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(t) ? t : `https://${t}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.replace(/^www\./, '');
  if (!SITE.test(host) || host.startsWith('.') || host.endsWith('.')) return null;
  return host.includes('.') || host === 'localhost' ? host : null;
}

/** Whether lookahead is on for `site`. */
export function lookaheadOn(settings: Pick<Settings, 'lookahead'>, site: string | null): boolean {
  return !!site && !settings.lookahead.off && settings.lookahead.sites.includes(site);
}

/** Applies `patch` to `current` (nested objects merged one level deep), validated. */
export function applyPatch(current: Settings, patch: SettingsPatch): Settings {
  return mergeSettings(
    {
      ...current,
      ...patch,
      overlay: { ...current.overlay, ...patch.overlay },
      custom: { ...current.custom, ...patch.custom },
      lookahead: { ...current.lookahead, ...patch.lookahead },
    },
    current,
  );
}

/**
 * Settings from the object stored under `SETTINGS_KEY`, brought up to `SETTINGS_VERSION` first.
 * Not for patches: a `Settings` object carries no version.
 */
export function readStoredSettings(stored: unknown): Settings {
  return mergeSettings(migrate(stored));
}

/**
 * Before version 2 every save wrote `display: 'both'`, the default then, whether or not the
 * person chose it; such a value is taken as unset, so it becomes the new default. Any other
 * display was a choice and stays.
 */
function migrate(stored: unknown): unknown {
  if (!isObject(stored)) return stored;
  const version = typeof stored.version === 'number' ? stored.version : 1;
  if (version < 2 && isObject(stored.overlay) && stored.overlay.display === 'both') {
    const { display: _old, ...overlay } = stored.overlay;
    return { ...stored, overlay };
  }
  return stored;
}

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  return readStoredSettings(stored[SETTINGS_KEY]);
}

/**
 * A change to settings: a patch of the fields changed, or a function that makes one from the
 * stored settings at the time of writing (for a change that depends on them, like adding to a
 * list), so a change made meanwhile in another context is never written back over.
 */
export type SettingsChange = SettingsPatch | ((current: Settings) => SettingsPatch);

/** The Web Lock every settings write holds (one origin: pages and service worker share it). */
export const SETTINGS_LOCK = 'murmur-settings';

/** Writes in a context without Web Locks, one at a time. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs `work` holding the settings lock: a read-modify-write of the stored object in one context
 * (popup, options page, service worker) never interleaves with one in another, so neither loses
 * the other's change.
 */
function withSettingsLock<T>(work: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (locks) return locks.request(SETTINGS_LOCK, work);
  const run = queue.then(work, work);
  queue = run.catch(() => {});
  return run;
}

/**
 * Applies `change` to the stored settings and stores them. Only the fields the change names are
 * written: the rest come from storage as it is now, under the settings lock.
 */
export function saveSettings(change: SettingsChange): Promise<Settings> {
  return withSettingsLock(async () => {
    const current = await loadSettings();
    const patch = typeof change === 'function' ? change(current) : change;
    const next = applyPatch(current, patch);
    await browser.storage.local.set({ [SETTINGS_KEY]: { ...next, version: SETTINGS_VERSION } });
    return next;
  });
}

/** `change` applied to `current` (what a page shows before storage confirms it). */
export function applyChange(current: Settings, change: SettingsChange): Settings {
  return applyPatch(current, typeof change === 'function' ? change(current) : change);
}

/** Calls `listener` with the new settings whenever they change. Returns an unsubscribe. */
export function watchSettings(listener: (settings: Settings) => void): () => void {
  const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string): void => {
    const change = changes[SETTINGS_KEY];
    if (area === 'local' && change) listener(readStoredSettings(change.newValue));
  };
  browser.storage.onChanged.addListener(onChanged);
  return () => browser.storage.onChanged.removeListener(onChanged);
}

/**
 * `text` on one line: control characters and line breaks become spaces, runs of white space one.
 * Glossary text goes into the translation model's prompt, where a line break could start a line
 * of its own.
 */
export function oneLine(text: string): string {
  return text
    .replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Valid entries of a stored glossary: target and every alias text on one line (`oneLine`), not
 * empty, at
 * most `MAX_GLOSSARY_TEXT` characters (a longer alias is left out, a longer note cut), at most
 * `MAX_GLOSSARY_ALIASES` ways said per entry and `MAX_GLOSSARY` entries; an alias already in an
 * earlier entry is left out, and an entry left with none goes. `|` separates aliases, so an
 * alias never holds one.
 */
export function cleanGlossary(list: readonly unknown[]): GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!isObject(item)) continue;
    const target = typeof item.target === 'string' ? oneLine(item.target) : '';
    if (!target || target.length > MAX_GLOSSARY_TEXT) continue;
    const said: string[] = [];
    const raw = [item.source, ...(Array.isArray(item.aliases) ? item.aliases : [])];
    for (const value of raw) {
      if (typeof value !== 'string') continue;
      for (const part of value.split('|')) {
        const alias = oneLine(part);
        if (!alias || alias.length > MAX_GLOSSARY_TEXT || seen.has(alias)) continue;
        if (said.length >= MAX_GLOSSARY_ALIASES) break;
        said.push(alias);
        seen.add(alias);
      }
    }
    const [source, ...aliases] = said;
    if (!source) continue;
    // `;` separates the prompt's glossary entries.
    const note =
      typeof item.note === 'string'
        ? oneLine(item.note.replaceAll(';', ',')).slice(0, MAX_GLOSSARY_TEXT).trim()
        : '';
    out.push({
      source,
      target,
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(note ? { note } : {}),
    });
    if (out.length >= MAX_GLOSSARY) break;
  }
  return out;
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
