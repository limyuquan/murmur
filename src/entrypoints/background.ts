import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { dispatch } from '@/background/api';
import {
  installSessionListeners,
  onOffscreenStatus,
  reconcile,
  startSession,
  stopSession,
} from '@/background/session';
import { isOffscreenEvent, isRequest, type Response } from '@/messaging/protocol';
import { IS_E2E } from '@/shared/e2e';
import { LOG_PREFIX } from '@/shared/ids';

/** Wires every listener synchronously, so Chrome can wake the worker for any of them. */
export default defineBackground(() => {
  reconcile().catch((err: unknown) => console.error(LOG_PREFIX, 'reconcile failed', err));
  installSessionListeners();

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
      async start(tabId, source = 'tone') {
        const status = await startSession(tabId, { source });
        if (status.state === 'error') throw new Error(status.message);
      },
      async stop() {
        await stopSession();
      },
    };
  }
});
