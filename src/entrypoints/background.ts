import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { dispatch } from '@/background/api';
import { setLookaheadSite, syncLookaheadScripts } from '@/background/lookahead';
import { models } from '@/background/models';
import {
  installSessionListeners,
  onMemoryFit,
  onOffscreenStatus,
  reconcile,
  startSession,
  stopSession,
  toggleSession,
} from '@/background/session';
import { OFFSCREEN_PATH } from '@/capture/offscreen';
import { DEMO_ASR_ID, DEMO_TRANSLATION_ID } from '@/engines/profiles';
import { isOffscreenEvent, isRequest, type Response } from '@/messaging/protocol';
import { isExtensionPage, isOffscreenDocument } from '@/messaging/senders';
import { loadSettings, saveSettings, spokenLanguages, watchSettings } from '@/settings/settings';
import { COMMANDS } from '@/shared/commands';
import { IS_E2E } from '@/shared/e2e';
import { LOG_PREFIX } from '@/shared/ids';
import { defaultTarget, LANGUAGES } from '@/ui/languages';

/** Wires every listener synchronously, so Chrome can wake the worker for any of them. */
export default defineBackground(() => {
  reconcile().catch((err: unknown) => console.error(LOG_PREFIX, 'reconcile failed', err));
  models.reconcile().catch(() => {});
  installSessionListeners();
  // Lookahead's page scripts follow the settings and the access the person gave.
  void syncLookaheadScripts().catch(() => {});
  watchSettings(() => void syncLookaheadScripts().catch(() => {}));
  browser.permissions.onRemoved.addListener(() => void syncLookaheadScripts().catch(() => {}));

  // First install: the welcome page (what Murmur does, pick a model, download). Not in e2e
  // builds, where a surprise tab would get in the tests' way.
  browser.runtime.onInstalled.addListener(({ reason }) => {
    if (reason !== 'install') return;
    // Start with the browser's language as the target, when it's offered, and its languages as
    // the ones spoken.
    void saveSettings({
      targetLanguage: defaultTarget(),
      spokenLanguages: spokenLanguages({ spokenLanguages: [] }, navigator.languages, LANGUAGES),
    }).finally(() => {
      if (!IS_E2E) void browser.tabs.create({ url: browser.runtime.getURL('/welcome.html') });
    });
  });

  // Keyboard shortcuts (chrome://extensions/shortcuts). A shortcut grants activeTab like a click.
  browser.commands.onCommand.addListener((command, tab) => {
    if (command === COMMANDS.toggle && tab?.id !== undefined) {
      void toggleSession(tab.id);
    } else if (command === COMMANDS.original) {
      void loadSettings().then((s) =>
        saveSettings({
          overlay: { display: s.overlay.display === 'both' ? 'translation' : 'both' },
        }),
      );
    }
  });

  const ext = { id: browser.runtime.id, base: browser.runtime.getURL('/') };
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (isOffscreenEvent(message)) {
      if (!isOffscreenDocument(sender, ext, OFFSCREEN_PATH)) return;
      if (message.type === 'session-status') void onOffscreenStatus(message.status);
      else void onMemoryFit(message).catch(() => {});
      return;
    }
    // Content scripts pass the id check too: requests come from extension pages only.
    if (!isRequest(message) || !isExtensionPage(sender, ext)) return;
    dispatch(message.op, message.args).then(
      (result): void => sendResponse({ ok: true, result } satisfies Response),
      (err: unknown): void =>
        sendResponse({
          ok: false,
          error: { message: err instanceof Error ? err.message : String(err) },
        } satisfies Response),
    );
    return true;
  });

  if (IS_E2E) {
    globalThis.__murmur = {
      async start(tabId, source = 'tone', engines = 'demo', simulateOutOfMemory) {
        const status = await startSession(tabId, {
          source,
          ...(simulateOutOfMemory ? { simulateOutOfMemory } : {}),
          ...(engines === 'demo'
            ? { engines: { asr: DEMO_ASR_ID, translation: DEMO_TRANSLATION_ID } }
            : engines === 'settings'
              ? {}
              : { engines }),
        });
        if (status.state === 'error') throw new Error(status.message);
      },
      async stop() {
        await stopSession();
      },
      async lookahead(site, on) {
        await setLookaheadSite(site, on);
      },
      async offscreenLog() {
        try {
          return (
            (await browser.runtime.sendMessage({ target: 'offscreen', type: 'e2e-log' })) ?? null
          );
        } catch {
          return null;
        }
      },
    };
  }
});
