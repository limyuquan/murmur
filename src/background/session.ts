/**
 * The one session (subtitles on one tab), owned by the service worker. Its status lives in
 * `storage.session`, so it survives the worker being stopped and restarted while the offscreen
 * document keeps running; the popup reads it from there too.
 *
 * Start: offscreen document → overlay injected (all frames) → stream ID minted → offscreen opens
 * the capture and answers, then loads the engines, reporting progress (and any failure) by event.
 * Stop: close the offscreen document, which ends capture, frees the models and disconnects the
 * overlays (they remove themselves). A stop cuts short a start under way; status writes are
 * serialised and checked against the session id, so a late report never brings a session back.
 */
import { browser } from 'wxt/browser';
import {
  closeOffscreenDocument,
  ensureOffscreenDocument,
  hasOffscreenDocument,
  mintTabStreamId,
} from '@/capture/offscreen';
import { gpuKey } from '@/engines/hardware';
import { untilAborted } from '@/engines/loading';
import { ladderFromStart, type ResolvedEngines, resolveEngines } from '@/engines/profiles';
import type { SimulatedFailure } from '@/engines/types';
import type {
  ActiveSessionStatus,
  CaptureSourceSpec,
  OffscreenCommand,
  OffscreenReply,
  SessionConfig,
  SessionErrorCode,
  SessionFailure,
  SessionLadder,
  SessionStatus,
} from '@/messaging/protocol';
import { modelsFor, splitMissing } from '@/models/catalog';
import { saveMemoryFit } from '@/settings/memoryfit';
import { loadSettings, type Settings, spokenLanguages } from '@/settings/settings';
import { IS_E2E } from '@/shared/e2e';
import { LOG_PREFIX } from '@/shared/ids';
import { LANGUAGES } from '@/ui/languages';
import { showBadge } from './badge';
import { deviceHardware, deviceResolveOptions, registry } from './engines';
import { modelStore } from './models';

const SESSION_KEY = 'session';
/** The origin the session's tab was on, to notice a navigation to another site. */
const ORIGIN_KEY = 'sessionOrigin';
/** How long a page reached by navigation has to show a video before the session stops. */
export const MEDIA_GRACE_MS = 5000;
const OVERLAY_SCRIPT = '/overlay.js';

/** Serialises start/stop so they never interleave. */
let queue: Promise<unknown> = Promise.resolve();

function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/**
 * The start under way, if any. A stop (switch, shortcut, tab closed, another tab) aborts it
 * rather than queueing behind it.
 */
let starting: { sessionId: string; tabId: number; controller: AbortController } | null = null;

export async function getStatus(): Promise<SessionStatus> {
  const stored = await browser.storage.session.get(SESSION_KEY);
  return (stored[SESSION_KEY] as SessionStatus | undefined) ?? { state: 'idle' };
}

/** Status writes, one at a time, so a read-decide-write never interleaves with another. */
let writes: Promise<unknown> = Promise.resolve();

/**
 * Replaces the status with `change(current)`, unless that returns null. Resolves with the status
 * stored afterwards.
 */
function updateStatus(
  change: (current: SessionStatus) => SessionStatus | null,
): Promise<SessionStatus> {
  const run = writes.then(async () => {
    const previous = await getStatus();
    const next = change(previous);
    if (!next) return previous;
    await browser.storage.session.set({ [SESSION_KEY]: next });
    await showBadge(next, previous.state === 'idle' ? null : previous.tabId);
    return next;
  });
  writes = run.catch(() => {});
  return run;
}

function setStatus(status: SessionStatus): Promise<SessionStatus> {
  return updateStatus(() => status);
}

/** `status` when the stored one is still session `sessionId` and hasn't failed already. */
function ifStillStarting(sessionId: string, status: SessionStatus) {
  return (current: SessionStatus): SessionStatus | null =>
    current.state !== 'idle' && current.state !== 'error' && current.sessionId === sessionId
      ? status
      : null;
}

/** Engines a session would use now, from settings and this device. */
export async function plannedEngines(settings?: Settings): Promise<ResolvedEngines> {
  const s = settings ?? (await loadSettings());
  return resolveEngines(
    s.profile,
    s.custom,
    registry,
    await deviceHardware(),
    await deviceResolveOptions(s, s.profile),
  );
}

/** What the offscreen document needs of the profile's memory ladder, from where it starts. */
async function sessionLadder(engines: ResolvedEngines): Promise<SessionLadder | undefined> {
  const { ladder } = engines;
  if (!ladder) return undefined;
  const steps = ladderFromStart(ladder);
  // Below the last step: Chrome's engines, nothing to step down.
  if (steps.length === 0) return undefined;
  return {
    profile: ladder.profile,
    gpu: gpuKey(await deviceHardware()),
    steps,
    length: ladder.steps.length,
    smaller: ladder.reason !== null && ladder.reason !== 'smaller',
    ...(ladder.reason === 'slow' || ladder.reason === 'speed' ? { why: ladder.reason } : {}),
  };
}

/**
 * The offscreen document stepped down a memory ladder (out of memory, or falling behind): start
 * there next time on this device.
 * Kept even when the session then fails (a smaller model not downloaded yet), so the popup offers
 * the right download.
 */
export async function onMemoryFit(event: {
  sessionId: string;
  profile: SessionLadder['profile'];
  gpu: string;
  step: number;
  engine: string;
  message: string;
  cause?: 'slow';
}): Promise<void> {
  const status = await getStatus();
  if (status.state === 'idle' || status.sessionId !== event.sessionId) return;
  await saveMemoryFit(event.gpu, event.profile, {
    step: event.step,
    at: Date.now(),
    cause: event.cause ?? 'memory',
    engine: event.engine,
    message: event.message,
  });
}

export function engineLabels(engines: ResolvedEngines): { asr: string; translation: string } {
  return {
    asr: registry.asrInfo(engines.asr)?.label ?? engines.asr,
    translation: registry.translationInfo(engines.translation)?.label ?? engines.translation,
  };
}

export interface StartOptions {
  /** `tone`: the synthetic source instead of tab audio (e2e builds). */
  source?: 'tab' | 'tone';
  /** These engines instead of the settings' (e2e builds: the demo engines). */
  engines?: { asr: string; translation: string };
  /** Engines to fail as if out of graphics memory (e2e builds only). */
  simulateOutOfMemory?: Record<string, SimulatedFailure>;
}

export function startSession(tabId: number, options: StartOptions = {}): Promise<SessionStatus> {
  // Another tab takes over at once, even from a start still under way.
  if (starting && starting.tabId !== tabId) {
    starting.controller.abort(new DOMException('Another tab took over.', 'AbortError'));
  }
  return exclusive(async () => {
    const current = await getStatus();
    if (current.state !== 'idle') {
      if (current.tabId === tabId && current.state !== 'error') return current;
      await stopNow();
    }
    const sessionId = crypto.randomUUID();
    const controller = new AbortController();
    const { signal } = controller;
    starting = { sessionId, tabId, controller };
    // Every step gives way at once to a stop.
    const step = <T>(work: Promise<T>) => untilAborted(work, signal);
    await setStatus({ state: 'starting', tabId, sessionId });
    try {
      const settings = await step(loadSettings());
      const planned = options.engines ? null : await step(plannedEngines(settings));
      const engines = options.engines ?? (planned as ResolvedEngines);
      const ladder = planned ? await step(sessionLadder(planned)) : undefined;
      const spoken = spokenLanguages(settings, navigator.languages, LANGUAGES);
      if (!options.engines) {
        // Models download only when the person asks: say so before capturing anything.
        const needed = modelsFor(
          settings.profile,
          settings.custom,
          registry,
          await step(deviceHardware()),
          await step(deviceResolveOptions(settings, settings.profile)),
        );
        const downloaded = await step(modelStore.downloaded(needed));
        // A missing translation model doesn't stop the start: another translator stands in.
        const { required: missing } = splitMissing(
          needed.filter((m) => !downloaded.has(m.id)),
          engines.translation,
        );
        if (missing.length > 0) {
          const names = missing.map((m) => m.label).join(' and ');
          return await updateStatus(
            ifStillStarting(sessionId, {
              state: 'error',
              tabId,
              sessionId,
              code: 'model',
              message: `${names} ${missing.length > 1 ? 'aren’t' : 'isn’t'} downloaded yet. Download in Settings, under Models.`,
              missingModels: missing.map((m) => m.id),
            }),
          );
        }
      }
      await step(ensureOffscreenDocument());
      await step(injectOverlay(tabId));
      // Mint last: the ID is single-use and expires within seconds.
      const source: CaptureSourceSpec =
        options.source === 'tone'
          ? { kind: 'tone' }
          : { kind: 'tab', streamId: await step(mintTabStreamId(tabId)) };
      const config: SessionConfig = {
        sessionId,
        tabId,
        source,
        asrEngine: engines.asr,
        translationEngine: engines.translation,
        targetLanguage: settings.targetLanguage,
        // One language and nothing else: say so to the engines as the source language.
        sourceLanguage: settings.onlySpoken && spoken.length === 1 ? (spoken[0] ?? null) : null,
        translatePartials: settings.translatePartials,
        spokenLanguages: spoken,
        onlySpoken: settings.onlySpoken,
        ...(settings.glossary.length > 0 ? { glossary: settings.glossary } : {}),
        ...(ladder ? { ladder } : {}),
        ...(IS_E2E && options.simulateOutOfMemory
          ? { simulateOutOfMemory: options.simulateOutOfMemory }
          : {}),
      };
      // Answered once the capture is open; the models load after, reporting by event.
      const reply = await step(
        sendToOffscreen({ target: 'offscreen', type: 'start', config }, signal),
      );
      if (!reply.ok) throw new OffscreenFailure(reply.error);
      const tab = await browser.tabs.get(tabId).catch(() => null);
      await rememberOrigin(sessionId, tab?.url);
    } catch (err) {
      // Stopped: the stop cleans up and sets the status.
      if (signal.aborted) return getStatus();
      console.error(LOG_PREFIX, 'start failed', err);
      // The offscreen document's own report (with its code, packs or models) may be in already.
      const failure = err instanceof OffscreenFailure ? err.failure : startError(err);
      await updateStatus(
        ifStillStarting(sessionId, { state: 'error', tabId, sessionId, ...failure }),
      );
      await closeOffscreenDocument().catch(() => {});
    } finally {
      if (starting?.sessionId === sessionId) starting = null;
    }
    return getStatus();
  });
}

/** Stops the session, cutting short a start under way. */
export function stopSession(): Promise<SessionStatus> {
  starting?.controller.abort(new DOMException('Stopped.', 'AbortError'));
  return exclusive(stopNow);
}

async function stopNow(): Promise<SessionStatus> {
  await closeOffscreenDocument().catch((err: unknown) =>
    console.warn(LOG_PREFIX, 'closing the offscreen document failed', err),
  );
  await setStatus({ state: 'idle' });
  return { state: 'idle' };
}

/**
 * A status report from the offscreen document. Reports for another session, or after this one
 * stopped or failed, are ignored. A failure while loading ends the session.
 */
export async function onOffscreenStatus(status: ActiveSessionStatus): Promise<void> {
  const stored = await updateStatus((current) =>
    current.state === 'idle' || current.state === 'error' || current.sessionId !== status.sessionId
      ? null
      : status,
  );
  if (stored !== status || status.state !== 'error') return;
  await exclusive(async () => {
    const current = await getStatus();
    if (current.state === 'error' && current.sessionId === status.sessionId) {
      await closeOffscreenDocument().catch(() => {});
    }
  });
}

class OffscreenFailure extends Error {
  constructor(readonly failure: SessionFailure) {
    super(failure.message);
  }
}

/** Session cleanup on tab and capture events. Call once, synchronously, at worker start. */
export function installSessionListeners(): void {
  browser.tabs.onRemoved.addListener((tabId) => {
    void stopIfSessionTab(tabId);
  });
  // Capture ended without us (another capturer took over, the tab crashed). Only a running
  // session reacts: while one is starting, a "stopped" is the previous capture of the same tab.
  browser.tabCapture.onStatusChanged.addListener((info) => {
    if (info.status === 'stopped' || info.status === 'error') {
      void stopIfSessionTab(info.tabId, 'running');
    }
  });
  browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.status === 'complete') void followNavigation(tabId, tab?.url);
  });
}

/**
 * A navigation in the captured tab drops its overlay (the capture goes on). Put it back when the
 * page has loaded. The session stops, and says why, when it can't follow: Murmur has no access to
 * the new page without a click (`activeTab` ends at another site), or the new site has nothing to
 * subtitle.
 */
async function followNavigation(tabId: number, url: string | undefined): Promise<void> {
  const status = await getStatus();
  if (status.state === 'idle' || status.state === 'error' || status.tabId !== tabId) return;
  const { sessionId } = status;
  try {
    await injectOverlay(tabId);
  } catch {
    await endAfterNavigation(
      sessionId,
      'The tab went to another site, where Murmur needs a click first. Turn subtitles on again to continue there.',
    );
    return;
  }
  const origin = originOf(url);
  const before = await rememberedOrigin(sessionId);
  if (!origin || origin === before) return;
  await rememberOrigin(sessionId, url);
  if (before === null) return;
  // Another site: keep going only if there is something to subtitle (players load late).
  for (const deadline = Date.now() + MEDIA_GRACE_MS; ; ) {
    const media = await pageHasMedia(tabId);
    if (media !== false) return;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 1000));
    const now = await getStatus();
    if (now.state === 'idle' || now.state === 'error' || now.sessionId !== sessionId) return;
  }
  await endAfterNavigation(
    sessionId,
    'The tab went to another site with no video on the page, so subtitles stopped.',
  );
}

/** Stops session `sessionId` (if it is still the one) with `message`, code `navigated`. */
async function endAfterNavigation(sessionId: string, message: string): Promise<void> {
  await exclusive(async () => {
    const current = await getStatus();
    if (current.state === 'idle' || current.state === 'error' || current.sessionId !== sessionId) {
      return;
    }
    await closeOffscreenDocument().catch(() => {});
    await updateStatus((now) =>
      now.state !== 'idle' && now.sessionId === sessionId
        ? { state: 'error', tabId: now.tabId, sessionId, code: 'navigated', message }
        : null,
    );
  });
}

/**
 * Whether any frame of the tab has a video or audio element (open shadow roots included), or a
 * frame big enough to hold a player Murmur can't see into. Null when it can't tell.
 */
async function pageHasMedia(tabId: number): Promise<boolean | null> {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const has = (root: Document | ShadowRoot): boolean => {
          if (root.querySelector('video, audio')) return true;
          for (const frame of root.querySelectorAll('iframe')) {
            const r = frame.getBoundingClientRect();
            if (r.width >= 200 && r.height >= 120) return true;
          }
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot && has(el.shadowRoot)) return true;
          }
          return false;
        };
        return has(document);
      },
    });
    return results.some((r) => r.result === true);
  } catch {
    return null;
  }
}

function originOf(url: string | undefined): string | null {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

async function rememberOrigin(sessionId: string, url: string | undefined): Promise<void> {
  const origin = originOf(url);
  if (origin) await browser.storage.session.set({ [ORIGIN_KEY]: { sessionId, origin } });
}

async function rememberedOrigin(sessionId: string): Promise<string | null> {
  const stored = (await browser.storage.session.get(ORIGIN_KEY))[ORIGIN_KEY] as
    | { sessionId: string; origin: string }
    | undefined;
  return stored?.sessionId === sessionId ? stored.origin : null;
}

/**
 * The popup opened on the session's tab (so `activeTab` is fresh): put the overlay back in case a
 * navigation dropped it. The overlay ignores a second injection.
 */
export async function reattachOverlay(tabId: number): Promise<void> {
  const status = await getStatus();
  if (status.state === 'idle' || status.state === 'error' || status.tabId !== tabId) return;
  await injectOverlay(tabId).catch(() => {});
}

/** After a worker restart: drop a stored session whose offscreen document is gone. */
export async function reconcile(): Promise<void> {
  const status = await getStatus();
  if (status.state === 'idle' || status.state === 'error') return;
  if (!(await hasOffscreenDocument())) await setStatus({ state: 'idle' });
}

async function stopIfSessionTab(tabId: number, only?: SessionStatus['state']): Promise<void> {
  const status = await getStatus();
  if (status.state === 'idle' || status.tabId !== tabId) return;
  if (only && status.state !== only) return;
  await stopSession();
}

async function injectOverlay(tabId: number): Promise<void> {
  await browser.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: [OVERLAY_SCRIPT],
  });
}

async function sendToOffscreen(
  command: OffscreenCommand,
  signal?: AbortSignal,
): Promise<OffscreenReply> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      const reply = (await browser.runtime.sendMessage(command)) as OffscreenReply | undefined;
      if (reply) return reply;
      throw new Error('The offscreen document did not answer.');
    } catch (err) {
      // The document can be a moment late registering its listener.
      if (attempt >= 3 || signal?.aborted) throw err;
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
  }
}

function startError(err: unknown): SessionFailure & { code: SessionErrorCode } {
  const message = err instanceof Error ? err.message : String(err);
  if (/Cannot access|cannot be scripted|chrome:\/\/|Missing host permission/i.test(message)) {
    return { message: "Murmur can't run on this page.", code: 'page' };
  }
  if (/activeTab|has not been invoked|Extension has not been invoked/i.test(message)) {
    return { message: 'Click the Murmur button on this tab first.', code: 'access' };
  }
  if (/already capturing|active stream/i.test(message)) {
    return { message: 'Another app or extension is already capturing this tab.', code: 'busy' };
  }
  return { message, code: 'unknown' };
}

/** Turns subtitles on or off for `tabId` (keyboard shortcut). */
export async function toggleSession(tabId: number): Promise<SessionStatus> {
  const status = await getStatus();
  const on = status.state !== 'idle' && status.state !== 'error' && status.tabId === tabId;
  return on ? stopSession() : startSession(tabId);
}
