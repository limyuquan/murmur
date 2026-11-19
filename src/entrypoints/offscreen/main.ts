/**
 * The offscreen document (reason USER_MEDIA): capture, models, pipeline. Only `runtime` is
 * available here, so commands arrive by message and status goes back the same way; settings come
 * inside the start command. Wires every listener synchronously.
 */
import { browser } from 'wxt/browser';
import {
  isOffscreenCommand,
  type OffscreenReply,
  OVERLAY_PORT,
  type OverlayHello,
} from '@/messaging/protocol';
import {
  OffscreenHost,
  type HostDeps as OffscreenHostDeps,
  type OverlayPort,
} from '@/offscreen/host';
import { IS_E2E, type OffscreenTestLog } from '@/shared/e2e';
import { LOG_PREFIX } from '@/shared/ids';

const host = new OffscreenHost({
  send: (event) => browser.runtime.sendMessage(event),
  ...(IS_E2E ? e2eTaps() : {}),
});

/**
 * e2e builds: every cue (with when it was sent) and every Chrome speech arbitration, on
 * `globalThis.__murmurLog`, for real-model checks driven over CDP.
 */
function e2eTaps(): Pick<OffscreenHostDeps, 'onCue' | 'onEngines'> {
  const log: OffscreenTestLog = { cues: [], arbitrations: [], engines: null };
  globalThis.__murmurLog = log;
  const now = () => performance.timeOrigin + performance.now();
  return {
    onCue: (cue) => log.cues.push({ at: now(), cue }),
    onEngines: (asr, translator) => {
      log.engines = { asr: asr.info.id, translation: translator.info.id };
      if ('onArbitration' in asr) {
        (asr as { onArbitration: unknown }).onArbitration = (record: unknown) =>
          log.arbitrations.push({ at: now(), record });
      }
    },
  };
}

browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== browser.runtime.id || !isOffscreenCommand(message)) return;
  const work = message.type === 'start' ? host.start(message.config) : host.stop();
  work.then(
    (): void => sendResponse({ ok: true } satisfies OffscreenReply),
    (err: unknown): void =>
      sendResponse({
        ok: false,
        error: { message: err instanceof Error ? err.message : String(err) },
      } satisfies OffscreenReply),
  );
  return true;
});

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== OVERLAY_PORT || port.sender?.id !== browser.runtime.id) return;
  // Wait for the hello so a port is only counted once its frame is listening.
  const onHello = (message: OverlayHello): void => {
    if (message?.type !== 'hello') return;
    port.onMessage.removeListener(onHello);
    host.addOverlay(port as unknown as OverlayPort);
  };
  port.onMessage.addListener(onHello);
});

console.debug(LOG_PREFIX, 'offscreen document ready');
