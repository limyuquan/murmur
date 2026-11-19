/**
 * Overlay entry, run by the injected `overlay.js` in every frame of the captured tab. Connects to
 * the offscreen document, draws what it sends, and removes itself when the port closes (the
 * session stopped). Injecting again while one is running is a no-op.
 */
import { browser } from 'wxt/browser';
import { toBase64 } from '@/lookahead/bytes';
import { lookaheadSiteFor, videoTimeline } from '@/lookahead/sites';
import { OVERLAY_PORT, type OverlayMessage, type OverlayToHost } from '@/messaging/protocol';
import type { Cue } from '@/pipeline/types';
import { loadPosition, savePosition, siteKey, watchPositions } from '@/settings/positions';
import { DEFAULT_SETTINGS, loadSettings, watchSettings } from '@/settings/settings';
import { IS_E2E } from '@/shared/e2e';
import { LOG_PREFIX } from '@/shared/ids';
import { OverlayController } from './controller';

declare global {
  /** Isolated-world guard: the running overlay in this frame. */
  var __murmurOverlay: { stop(): void } | undefined;
}

/** e2e builds only: a page event that feeds the overlay directly (JSON in `detail`). */
export const E2E_EVENT = 'murmur-e2e';
export type E2eCommand =
  | { cue: Cue }
  | { reset: true }
  /** Ignore what the session sends from now on, so a test controls every cue. */
  | { hold: true }
  | { message: OverlayMessage };

/**
 * The page's site, for dragged positions: the tab's (top frame's) site even in a player inside
 * a frame from another site, as the popup shows and resets it.
 */
export function topSiteKey(
  loc: Pick<Location, 'href'> & { ancestorOrigins?: DOMStringList },
): string | null {
  const ancestors = loc.ancestorOrigins;
  const top = ancestors && ancestors.length > 0 ? ancestors.item(ancestors.length - 1) : null;
  return siteKey(top ?? loc.href);
}

export function startOverlay(): void {
  if (globalThis.__murmurOverlay) return;
  const site = topSiteKey(location);
  const port = browser.runtime.connect({ name: OVERLAY_PORT });
  const post = (message: OverlayToHost): void => {
    try {
      port.postMessage(message);
    } catch {
      // Disconnected: the overlay is going away.
    }
  };
  // Lookahead: the relay is here only on sites where it's on (src/lookahead/relay.ts).
  const relay = globalThis.__murmurTee;
  const lookaheadSite = lookaheadSiteFor(location.hostname);
  const controller = new OverlayController(window, document, {
    onPositionChange: (offset) => {
      if (site) savePosition(site, offset).catch(() => {});
    },
    // So the top frame knows a player here shows the subtitles.
    onVideo: (present) => post({ type: 'video', present }),
    ...(relay
      ? {
          timelineOf: (video: HTMLVideoElement) =>
            videoTimeline(
              video,
              {
                byUrl: (url) => relay.mediaSourceOf(url),
                byBuffered: (ranges, time) => relay.mediaSourceFor(ranges, time),
              },
              lookaheadSite,
              location,
            ),
          onPlayhead: (report: import('@/lookahead/protocol').PlayheadReport) =>
            post({ type: 'playhead', report }),
        }
      : {}),
  });
  const unwatch: (() => void)[] = [];
  let held = false;

  /** A progressive source on this page's origin, read with the page's access. */
  const fetchFor = (message: Extract<OverlayMessage, { type: 'fetch' }>): void => {
    if (!relay) return;
    relay.fetchRange(message.url, message.start, message.end).then(
      ({ bytes, total }) =>
        post({
          type: 'tee',
          wire: { t: 'fetched', id: message.id, bytes: toBase64(bytes), total },
        }),
      (err: unknown) =>
        post({
          type: 'tee',
          wire: {
            t: 'fetched',
            id: message.id,
            error: err instanceof Error ? err.message : String(err),
          },
        }),
    );
  };

  const stop = (): void => {
    for (const u of unwatch) u();
    controller.destroy();
    port.onMessage.removeListener(onMessage);
    if (globalThis.__murmurOverlay === handle) globalThis.__murmurOverlay = undefined;
  };
  const handle = { stop };
  globalThis.__murmurOverlay = handle;

  const apply = (message: OverlayMessage): void => {
    if (message.type === 'cue') controller.applyCue(message.cue);
    else if (message.type === 'reset') controller.reset();
    else if (message.type === 'status') controller.setStatus(message.status);
    else if (message.type === 'frames') controller.setVideoInFrame(message.videoInFrame);
    else if (message.type === 'lookahead') {
      // Only frames where lookahead can read the player follow the playhead.
      if (relay) controller.setLookahead(message.lagS);
    } else if (message.type === 'coverage') controller.setCoverage(message.timeline, message.spans);
    else if (message.type === 'drop')
      controller.dropCues(message.timeline, message.start, message.end, message.keep ?? false);
    else if (message.type === 'fetch') fetchFor(message);
  };
  const onMessage = (message: OverlayMessage): void => {
    // A test that holds the session's cues still wants to know about the frames.
    if (!held || message.type === 'frames') apply(message);
  };
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(stop);
  port.postMessage({ type: 'hello', frameUrl: location.href } satisfies OverlayToHost);
  // Lookahead can read this page: what the player did so far, then as it happens (after the
  // hello, which the session counts the port by), and where the video is.
  if (relay) {
    unwatch.push(relay.attach((wire) => post({ type: 'tee', wire })));
    post({
      type: 'playhead',
      report: {
        timeline: null,
        key: null,
        ad: false,
        time: 0,
        rate: 1,
        paused: true,
        at: Date.now(),
      },
    });
  }

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
  const live = () => globalThis.__murmurOverlay === handle;
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
