import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { dispatch } from '@/background/api';
import { models } from '@/background/models';
import {
  installSessionListeners,
  onOffscreenStatus,
  reconcile,
  startSession,
  stopSession,
  toggleSession,
} from '@/background/session';
import { DEMO_ASR_ID, DEMO_TRANSLATION_ID } from '@/engines/profiles';
import { isOffscreenEvent, isRequest, type Response } from '@/messaging/protocol';
import { loadSettings, saveSettings } from '@/settings/settings';
import { COMMANDS } from '@/shared/commands';
import { IS_E2E } from '@/shared/e2e';
import { LOG_PREFIX } from '@/shared/ids';
import { defaultTarget } from '@/ui/languages';

/** Wires every listener synchronously, so Chrome can wake the worker for any of them. */
export default defineBackground(() => {
  reconcile().catch((err: unknown) => console.error(LOG_PREFIX, 'reconcile failed', err));
  models.reconcile().catch(() => {});
  installSessionListeners();

  // First install: the welcome page (what Earshot does, pick a model, download). Not in e2e
  // builds, where a surprise tab would get in the tests' way.
  browser.runtime.onInstalled.addListener(({ reason }) => {
    if (reason !== 'install') return;
    // Start with the browser's language as the target, when it's offered.
    void saveSettings({ targetLanguage: defaultTarget() }).finally(() => {
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

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id) return;
    if (isOffscreenEvent(message)) {
      void onOffscreenStatus(message.status);
      return;
    }
    if (!isRequest(message)) return;
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
    globalThis.__earshot = {
      async start(tabId, source = 'tone', engines = 'demo') {
        const status = await startSession(tabId, {
          source,
          ...(engines === 'demo'
            ? { engines: { asr: DEMO_ASR_ID, translation: DEMO_TRANSLATION_ID } }
            : {}),
        });
        if (status.state === 'error') throw new Error(status.message);
      },
      async stop() {
        await stopSession();
      },
    };
  }
});
