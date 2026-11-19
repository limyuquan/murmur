/**
 * Overlay entry, run by the injected `overlay.js` in every frame of the captured tab. Connects to
 * the offscreen document, draws what it sends, and removes itself when the port closes (the
 * session stopped). Injecting again while one is running is a no-op.
 */
import { browser } from 'wxt/browser';
import { OVERLAY_PORT, type OverlayHello, type OverlayMessage } from '@/messaging/protocol';
import { DEFAULT_SETTINGS, loadSettings, watchSettings } from '@/settings/settings';
import { LOG_PREFIX } from '@/shared/ids';
import { OverlayController } from './controller';

declare global {
  /** Isolated-world guard: the running overlay in this frame. */
  var __earshotOverlay: { stop(): void } | undefined;
}

export function startOverlay(): void {
  if (globalThis.__earshotOverlay) return;
  const controller = new OverlayController(window);
  const port = browser.runtime.connect({ name: OVERLAY_PORT });
  let unwatch = (): void => {};

  const stop = (): void => {
    unwatch();
    controller.destroy();
    port.onMessage.removeListener(onMessage);
    if (globalThis.__earshotOverlay === handle) globalThis.__earshotOverlay = undefined;
  };
  const handle = { stop };
  globalThis.__earshotOverlay = handle;

  const onMessage = (message: OverlayMessage): void => {
    if (message.type === 'cue') controller.applyCue(message.cue);
    else if (message.type === 'reset') controller.reset();
  };
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(stop);
  port.postMessage({ type: 'hello', frameUrl: location.href } satisfies OverlayHello);

  // Start with the defaults so early cues have somewhere to go; stored settings follow.
  controller.start(DEFAULT_SETTINGS.overlay);
  loadSettings().then(
    (settings) => {
      if (globalThis.__earshotOverlay !== handle) return;
      controller.setSettings(settings.overlay);
      unwatch = watchSettings((next) => controller.setSettings(next.overlay));
    },
    (err: unknown) => console.error(LOG_PREFIX, 'could not read settings', err),
  );
}
