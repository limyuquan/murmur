import { describe, expect, it } from 'vitest';
import { isExtensionContext, isExtensionPage, isOffscreenDocument } from '@/messaging/senders';

const ext = { id: 'abc', base: 'chrome-extension://abc/' };
const page = { id: 'abc', url: 'chrome-extension://abc/popup.html?tab=3' };
const optionsTab = { id: 'abc', url: 'chrome-extension://abc/options.html', tab: { id: 4 } };
const offscreen = { id: 'abc', url: 'chrome-extension://abc/offscreen.html' };
const worker = { id: 'abc', url: 'chrome-extension://abc/background.js' };
/** A content script (the overlay) in a page: same extension id, the page's URL, a tab. */
const content = { id: 'abc', url: 'https://example.com/watch', tab: { id: 5 } };
const other = { id: 'zzz', url: 'chrome-extension://zzz/popup.html' };

describe('message senders', () => {
  it('takes requests from extension pages only', () => {
    expect(isExtensionPage(page, ext)).toBe(true);
    expect(isExtensionPage(optionsTab, ext)).toBe(true);
    expect(isExtensionPage(content, ext)).toBe(false);
    expect(isExtensionPage({ id: 'abc' }, ext)).toBe(false);
    expect(isExtensionPage(other, ext)).toBe(false);
  });

  it('takes status events from the offscreen document only', () => {
    expect(isOffscreenDocument(offscreen, ext, '/offscreen.html')).toBe(true);
    expect(isOffscreenDocument(page, ext, '/offscreen.html')).toBe(false);
    expect(isOffscreenDocument(content, ext, '/offscreen.html')).toBe(false);
    // A page can't pass for it with a look-alike URL.
    expect(
      isOffscreenDocument({ id: 'abc', url: 'https://x/offscreen.html' }, ext, '/offscreen.html'),
    ).toBe(false);
  });

  it('takes offscreen commands from the service worker, never from a tab', () => {
    expect(isExtensionContext(worker, ext)).toBe(true);
    expect(isExtensionContext({ id: 'abc' }, ext)).toBe(true);
    expect(isExtensionContext(content, ext)).toBe(false);
    expect(isExtensionContext(optionsTab, ext)).toBe(false);
    expect(isExtensionContext({ id: 'abc', url: 'https://example.com/' }, ext)).toBe(false);
    expect(isExtensionContext(other, ext)).toBe(false);
  });
});
