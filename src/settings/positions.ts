/**
 * Where subtitles were dragged to, per site, in `chrome.storage.local` under `POSITIONS_KEY`.
 * Kept apart from `Settings` so dragging on one site never rewrites the whole settings object.
 *
 * A position is relative to the video picture, so it holds across player sizes and fullscreen:
 * `x` is the centre of the subtitles as a share of the picture width, `y` their bottom edge as a
 * share of the picture height (from the top).
 */
import { browser } from 'wxt/browser';

export const POSITIONS_KEY = 'positions';

export interface CaptionOffset {
  x: number;
  y: number;
}

export type SitePositions = Record<string, CaptionOffset>;

/** The key a page is stored under: its host name (`www.` dropped). Null for pages without one. */
export function siteKey(url: string): string | null {
  try {
    const { protocol, hostname } = new URL(url);
    if (!/^https?:$/.test(protocol) || !hostname) return null;
    return hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Keeps the subtitles' anchor inside the picture, with a margin. */
export function clampOffset(p: CaptionOffset): CaptionOffset {
  const clamp = (v: number, lo: number, hi: number) =>
    Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : (lo + hi) / 2;
  return { x: clamp(p.x, 0.1, 0.9), y: clamp(p.y, 0.1, 0.98) };
}

function parse(stored: unknown): SitePositions {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
  const out: SitePositions = {};
  for (const [site, value] of Object.entries(stored)) {
    const v = value as Partial<CaptionOffset> | null;
    if (v && typeof v.x === 'number' && typeof v.y === 'number')
      out[site] = clampOffset(v as CaptionOffset);
  }
  return out;
}

export async function loadPositions(): Promise<SitePositions> {
  const stored = await browser.storage.local.get(POSITIONS_KEY);
  return parse(stored[POSITIONS_KEY]);
}

export async function loadPosition(site: string): Promise<CaptionOffset | null> {
  return (await loadPositions())[site] ?? null;
}

/** Saves `offset` for `site`, or forgets it when `offset` is null. */
export async function savePosition(site: string, offset: CaptionOffset | null): Promise<void> {
  const all = await loadPositions();
  if (offset) all[site] = clampOffset(offset);
  else delete all[site];
  await browser.storage.local.set({ [POSITIONS_KEY]: all });
}

export async function clearPositions(): Promise<void> {
  await browser.storage.local.remove(POSITIONS_KEY);
}

/** Calls `listener` with every site's position whenever one changes. Returns an unsubscribe. */
export function watchPositions(listener: (positions: SitePositions) => void): () => void {
  const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string): void => {
    const change = changes[POSITIONS_KEY];
    if (area === 'local' && change) listener(parse(change.newValue));
  };
  browser.storage.onChanged.addListener(onChanged);
  return () => browser.storage.onChanged.removeListener(onChanged);
}
