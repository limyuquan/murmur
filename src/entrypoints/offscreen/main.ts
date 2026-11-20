/**
 * The offscreen document (reason USER_MEDIA): capture, models, pipeline. Only `runtime` is
 * available here, so commands arrive by message and status goes back the same way; settings come
 * inside the start command. Wires every listener synchronously.
 */
import { browser } from 'wxt/browser';
import { isPlayheadReport, isTeeWire } from '@/lookahead/protocol';
import {
  isOffscreenCommand,
  type OffscreenReply,
  OVERLAY_PORT,
  type OverlayToHost,
} from '@/messaging/protocol';
import { isExtensionContext } from '@/messaging/senders';
import {
  describeError,
  OffscreenHost,
  type HostDeps as OffscreenHostDeps,
  type OverlayPort,
} from '@/offscreen/host';
import { IS_E2E, type OffscreenE2eLog, type OffscreenTestLog } from '@/shared/e2e';
import { LOG_PREFIX } from '@/shared/ids';

const host = new OffscreenHost({
  send: (event) => browser.runtime.sendMessage(event),
  ...(IS_E2E ? e2eTaps() : {}),
});

/**
 * e2e builds: every cue (with when it was sent), every Chrome speech arbitration, every
 * segment decode (engines that report them), every segment boundary and the speech detector
 * with its cost, on
 * `globalThis.__murmurLog`, for real-model checks driven over CDP.
 */
function e2eTaps(): Pick<
  OffscreenHostDeps,
  | 'onCue'
  | 'onEngines'
  | 'onVad'
  | 'onSegment'
  | 'onLookaheadCue'
  | 'onStartup'
  | 'onStepDown'
  | 'onSlow'
> {
  const log: OffscreenTestLog = {
    cues: [],
    lookaheadCues: [],
    lookahead: () => host.lookaheadSnapshot(),
    arbitrations: [],
    decodes: [],
    engines: null,
    memory: [],
    segments: [],
    vad: null,
    startup: {},
  };
  globalThis.__murmurLog = log;
  const now = () => performance.timeOrigin + performance.now();
  return {
    onCue: (cue) => log.cues.push({ at: now(), cue }),
    onLookaheadCue: (cue) => log.lookaheadCues.push({ at: now(), cue }),
    onSegment: (event) => log.segments.push({ at: now(), event }),
    onStartup: (step) => {
      log.startup[step] = now();
    },
    onStepDown: (engine, error, next) =>
      log.memory.push({ at: now(), engine, message: error.message, next }),
    // Falling behind steps down too (for the next session): logged with the memory step downs.
    onSlow: (found, next) =>
      log.memory.push({
        at: now(),
        engine: found.engine,
        message: `slow: ${JSON.stringify(found)}`,
        next,
      }),
    onVad: (vad) => {
      log.vad = vad ? { detector: 'silero', cost: vad.cost } : { detector: 'energy', cost: null };
    },
    onEngines: (asr, translator) => {
      log.engines = { asr: asr.info.id, translation: translator.info.id };
      if ('onArbitration' in asr) {
        (asr as { onArbitration: unknown }).onArbitration = (record: unknown) =>
          log.arbitrations.push({ at: now(), record });
      }
      if ('onDecode' in asr) {
        (asr as { onDecode: unknown }).onDecode = (record: unknown) =>
          log.decodes.push({ at: now(), record });
      }
    },
  };
}

const ext = { id: browser.runtime.id, base: browser.runtime.getURL('/') };

browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Commands come from the service worker, never from a tab (content scripts have one).
  if (!isOffscreenCommand(message) || !isExtensionContext(sender, ext)) return;
  if (IS_E2E && (message as { type: string }).type === 'e2e-log') {
    const log = globalThis.__murmurLog;
    sendResponse({
      cues: log?.cues.length ?? 0,
      liveCues: log?.cues.slice(-200) ?? [],
      lookaheadCues: log?.lookaheadCues ?? [],
      lookahead: log?.lookahead() ?? null,
    } satisfies OffscreenE2eLog);
    return;
  }
  const work =
    message.type !== 'start'
      ? host.stop()
      : message.config.source.kind === 'tone' && !IS_E2E
        ? Promise.reject(new Error('The test tone is for e2e builds only.'))
        : host.start(message.config);
  work.then(
    (): void => sendResponse({ ok: true } satisfies OffscreenReply),
    (err: unknown): void =>
      sendResponse({ ok: false, error: describeError(err) } satisfies OffscreenReply),
  );
  return true;
});

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== OVERLAY_PORT || port.sender?.id !== browser.runtime.id) return;
  // Overlays run in pages: a port only ever gets its own tab's cues and status.
  if (port.sender.tab?.id === undefined) return;
  const overlay = port as unknown as OverlayPort;
  let counted = false;
  port.onMessage.addListener((message: OverlayToHost) => {
    // Wait for the hello so a port is only counted once its frame is listening.
    if (message?.type === 'hello' && !counted) {
      counted = true;
      host.addOverlay(overlay, typeof message.frameUrl === 'string' ? message.frameUrl : '');
    } else if (message?.type === 'video' && counted) {
      host.setOverlayVideo(overlay, message.present === true);
    } else if (message?.type === 'visible' && counted) {
      host.setOverlayVisible(overlay, message.visible === true);
    } else if (message?.type === 'tee' && counted && isTeeWire(message.wire)) {
      host.onLookahead(overlay, message);
    } else if (message?.type === 'playhead' && counted && isPlayheadReport(message.report)) {
      host.onLookahead(overlay, message);
    }
  });
});

console.debug(LOG_PREFIX, 'offscreen document ready');
