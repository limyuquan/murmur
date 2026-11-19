/**
 * Who may send what. `sender.id === runtime.id` holds for content scripts too, and the overlay
 * runs inside other people's pages, so privileged messages also check where they come from:
 *
 * - Requests to the service worker (start, stop, downloads): extension pages only (popup,
 *   options, welcome), whose URL is inside the extension.
 * - Status events: the offscreen document only.
 * - Commands to the offscreen document: the service worker (or an extension page), never a tab.
 * - Content scripts only open the overlay port, which carries the overlay's own messages.
 *
 * Pure, so the rules are unit-tested; callers pass `runtime.id` and `runtime.getURL('')`.
 */

/** The parts of `runtime.MessageSender` checked here. */
export interface SenderInfo {
  id?: string;
  url?: string;
  tab?: unknown;
}

export interface Extension {
  id: string;
  /** `runtime.getURL('')`: `chrome-extension://<id>/`. */
  base: string;
}

function inside(url: string | undefined, ext: Extension): boolean {
  return typeof url === 'string' && url.startsWith(ext.base);
}

/** An extension page: popup, options or welcome (in a tab or not). Not a content script. */
export function isExtensionPage(sender: SenderInfo, ext: Extension): boolean {
  return sender.id === ext.id && inside(sender.url, ext);
}

/** The offscreen document at `path` (`/offscreen.html`). */
export function isOffscreenDocument(sender: SenderInfo, ext: Extension, path: string): boolean {
  if (sender.id !== ext.id || typeof sender.url !== 'string') return false;
  const url = sender.url.split(/[?#]/)[0];
  return url === new URL(path, ext.base).href;
}

/**
 * The service worker or an extension page outside any tab: what may command the offscreen
 * document. Content scripts always come with a tab.
 */
export function isExtensionContext(sender: SenderInfo, ext: Extension): boolean {
  if (sender.id !== ext.id || sender.tab !== undefined) return false;
  return sender.url === undefined || inside(sender.url, ext);
}
