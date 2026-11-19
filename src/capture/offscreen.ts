/**
 * Service-worker side of capture: the single offscreen document and the tab stream ID.
 *
 * Only one offscreen document can exist per extension (per profile). It hosts the audio graph and
 * the models, so Murmur runs one session at a time. Create the document first, then mint the
 * stream ID: an ID is single-use and expires a few seconds after it's minted.
 */
import { browser } from 'wxt/browser';

export const OFFSCREEN_PATH = '/offscreen.html';

let creating: Promise<void> | null = null;

export async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await browser.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [browser.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

/** Creates the offscreen document unless it exists. Safe to call concurrently. */
export async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  creating ??= browser.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA'],
      justification: 'Captures the tab audio to turn speech into subtitles, on this device.',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

/** Closes the offscreen document: stops capture, frees the models. No-op when there is none. */
export async function closeOffscreenDocument(): Promise<void> {
  if (creating) await creating.catch(() => {});
  if (await hasOffscreenDocument()) await browser.offscreen.closeDocument();
}

/**
 * A stream ID for `tabId`'s audio, usable by the offscreen document. Needs the `activeTab` grant
 * for that tab (a toolbar click or the shortcut on it).
 */
export function mintTabStreamId(tabId: number): Promise<string> {
  return browser.tabCapture.getMediaStreamId({ targetTabId: tabId });
}
