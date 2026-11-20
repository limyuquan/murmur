/**
 * Turning lookahead on for a site: the popup asks for access, and Chrome may close the popup
 * while it asks; the service worker then finishes the job once access is given.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { finishPendingLookahead, PENDING_MS, setLookaheadSite } from '@/background/lookahead';
import { LOOKAHEAD_PENDING_KEY } from '@/messaging/protocol';
import { loadSettings, saveSettings } from '@/settings/settings';

let granted: string[] = [];

beforeEach(() => {
  granted = [];
  vi.spyOn(browser.permissions, 'contains').mockImplementation((async (p: { origins?: string[] }) =>
    (p.origins ?? []).every((o) => granted.includes(o))) as never);
  vi.spyOn(browser.scripting, 'getRegisteredContentScripts').mockImplementation(
    (async () => []) as never,
  );
  vi.spyOn(browser.scripting, 'registerContentScripts').mockImplementation(
    (async () => {}) as never,
  );
  vi.spyOn(browser.scripting, 'unregisterContentScripts').mockImplementation(
    (async () => {}) as never,
  );
});

describe('lookahead sites', () => {
  it('turning a site on or off keeps the other settings and sites', async () => {
    await saveSettings({
      spokenLanguages: ['en', 'ko', 'ja'],
      lookahead: { sites: ['a.example'] },
    });
    await Promise.all([
      setLookaheadSite('b.example', true),
      saveSettings({ overlay: { fontScale: 1.3 } }),
      setLookaheadSite('a.example', false),
    ]);
    const s = await loadSettings();
    expect(s.lookahead.sites).toEqual(['b.example']);
    expect(s.spokenLanguages).toEqual(['en', 'ko', 'ja']);
    expect(s.overlay.fontScale).toBe(1.3);
  });

  it('finishes turning a site on once its access is given, if the popup could not', async () => {
    await browser.storage.session.set({
      [LOOKAHEAD_PENDING_KEY]: { site: 'video.example.com', at: Date.now() },
    });
    // Not given yet: nothing changes, and it is still waited for.
    await finishPendingLookahead();
    expect((await loadSettings()).lookahead.sites).toEqual([]);
    granted = ['*://video.example.com/*', '*://www.video.example.com/*'];
    await finishPendingLookahead();
    expect((await loadSettings()).lookahead.sites).toEqual(['video.example.com']);
    expect((await browser.storage.session.get(LOOKAHEAD_PENDING_KEY))[LOOKAHEAD_PENDING_KEY]).toBe(
      undefined,
    );
  });

  it('forgets an old request', async () => {
    granted = ['*://video.example.com/*', '*://www.video.example.com/*'];
    await browser.storage.session.set({
      [LOOKAHEAD_PENDING_KEY]: { site: 'video.example.com', at: Date.now() - PENDING_MS - 1 },
    });
    await finishPendingLookahead();
    expect((await loadSettings()).lookahead.sites).toEqual([]);
  });
});
