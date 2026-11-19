/**
 * Overlay entry, run by the injected `overlay.js` in every frame of the captured tab. Connects to
 * the offscreen document, draws what it sends, and removes itself when the port closes (the
 * session stopped). Injecting again while one is running is a no-op.
 */
import { browser } from 'wxt/browser';
import { OVERLAY_PORT, type OverlayHello, type OverlayMessage } from '@/messaging/protocol';
import type { Cue } from '@/pipeline/types';
import { loadPosition, savePosition, siteKey, watchPositions } from '@/settings/positions';
import { DEFAULT_SETTINGS, loadSettings, watchSettings } from '@/settings/settings';
import { IS_E2E } from '@/shared/e2e';
import { LOG_PREFIX } from '@/shared/ids';
import { OverlayController } from './controller';

declare global {
  /** Isolated-world guard: the running overlay in this frame. */
  var __earshotOverlay: { stop(): void } | undefined;
}

/** e2e builds only: a page event that feeds the overlay directly (JSON in `detail`). */
export const E2E_EVENT = 'earshot-e2e';
export type E2eCommand =
  | { cue: Cue }
  | { reset: true }
  /** Ignore what the session sends from now on, so a test controls every cue. */
  | { hold: true }
  | { message: OverlayMessage };

export function startOverlay(): void {
  if (globalThis.__earshotOverlay) return;
  const site = siteKey(location.href);
  const controller = new OverlayController(window, document, {
    onPositionChange: (offset) => {
      if (site) savePosition(site, offset).catch(() => {});
    },
  });
  const port = browser.runtime.connect({ name: OVERLAY_PORT });
  const unwatch: (() => void)[] = [];
  let held = false;

  const stop = (): void => {
    for (const u of unwatch) u();
    controller.destroy();
    port.onMessage.removeListener(onMessage);
    if (globalThis.__earshotOverlay === handle) globalThis.__earshotOverlay = undefined;
  };
  const handle = { stop };
  globalThis.__earshotOverlay = handle;

  const apply = (message: OverlayMessage): void => {
    if (message.type === 'cue') controller.applyCue(message.cue);
    else if (message.type === 'reset') controller.reset();
    else if (message.type === 'status') controller.setStatus(message.status);
  };
  const onMessage = (message: OverlayMessage): void => {
    if (!held) apply(message);
  };
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(stop);
  port.postMessage({ type: 'hello', frameUrl: location.href } satisfies OverlayHello);

  if (IS_E2E) {
    const onTest = (e: Event): void => {
      const command = JSON.parse(String((e as CustomEvent).detail)) as E2eCommand;
      if ('hold' in command) {
        held = true;
        controller.reset();
      } else if ('reset' in command) controller.reset();
      else if ('cue' in command) controller.applyCue(command.cue);
      else apply(command.message);
    };
    document.addEventListener(E2E_EVENT, onTest);
    unwatch.push(() => document.removeEventListener(E2E_EVENT, onTest));
  }

  // Start with the defaults so early cues have somewhere to go; stored settings follow.
  controller.start(DEFAULT_SETTINGS.overlay);
  const live = () => globalThis.__earshotOverlay === handle;
  loadSettings().then(
    (settings) => {
      if (!live()) return;
      controller.setSettings(settings.overlay);
      unwatch.push(watchSettings((next) => controller.setSettings(next.overlay)));
    },
    (err: unknown) => console.error(LOG_PREFIX, 'could not read settings', err),
  );
  if (site) {
    loadPosition(site).then(
      (offset) => {
        if (!live()) return;
        controller.setOffset(offset);
        unwatch.push(watchPositions((all) => controller.setOffset(all[site] ?? null)));
      },
      () => {},
    );
  }
}
