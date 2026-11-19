/**
 * The one session (subtitles on one tab), owned by the service worker. Its status lives in
 * `storage.session`, so it survives the worker being stopped and restarted while the offscreen
 * document keeps running; the popup reads it from there too.
 *
 * Start: offscreen document → overlay injected (all frames) → stream ID minted → offscreen starts
 * capture and engines and reports progress. Stop: close the offscreen document, which ends
 * capture, frees the models and disconnects the overlays (they remove themselves).
 */
import { browser } from 'wxt/browser';
import {
  closeOffscreenDocument,
  ensureOffscreenDocument,
  hasOffscreenDocument,
  mintTabStreamId,
} from '@/capture/offscreen';
import { createBuiltinRegistry } from '@/engines/builtin';
import { detectHardware, type HardwareInfo } from '@/engines/hardware';
import { type ResolvedEngines, resolveEngines } from '@/engines/profiles';
import type {
  ActiveSessionStatus,
  CaptureSourceSpec,
  OffscreenCommand,
  OffscreenReply,
  SessionConfig,
  SessionStatus,
} from '@/messaging/protocol';
import { loadSettings, type Settings } from '@/settings/settings';
import { LOG_PREFIX } from '@/shared/ids';
import { showBadge } from './badge';

const SESSION_KEY = 'session';
const OVERLAY_SCRIPT = '/overlay.js';

const registry = createBuiltinRegistry();
let hardware: Promise<HardwareInfo> | null = null;
/** Serialises start/stop so they never interleave. */
let queue: Promise<unknown> = Promise.resolve();

function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export async function getStatus(): Promise<SessionStatus> {
  const stored = await browser.storage.session.get(SESSION_KEY);
  return (stored[SESSION_KEY] as SessionStatus | undefined) ?? { state: 'idle' };
}

async function setStatus(status: SessionStatus): Promise<void> {
  const previous = await getStatus();
  await browser.storage.session.set({ [SESSION_KEY]: status });
  await showBadge(status, previous.state === 'idle' ? null : previous.tabId);
}

/** Engines a session would use now, from settings and this device. */
export async function plannedEngines(settings?: Settings): Promise<ResolvedEngines> {
  const s = settings ?? (await loadSettings());
  hardware ??= detectHardware();
  return resolveEngines(s.profile, s.custom, registry, await hardware);
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
}

export function startSession(tabId: number, options: StartOptions = {}): Promise<SessionStatus> {
  return exclusive(async () => {
    const current = await getStatus();
    if (current.state !== 'idle') {
      if (current.tabId === tabId && current.state !== 'error') return current;
      await stopNow();
    }
    const sessionId = crypto.randomUUID();
    await setStatus({ state: 'starting', tabId, sessionId });
    try {
      const settings = await loadSettings();
      const engines = await plannedEngines(settings);
      await ensureOffscreenDocument();
      await injectOverlay(tabId);
      // Mint last: the ID is single-use and expires within seconds.
      const source: CaptureSourceSpec =
        options.source === 'tone'
          ? { kind: 'tone' }
          : { kind: 'tab', streamId: await mintTabStreamId(tabId) };
      const config: SessionConfig = {
        sessionId,
        tabId,
        source,
        asrEngine: engines.asr,
        translationEngine: engines.translation,
        targetLanguage: settings.targetLanguage,
        sourceLanguage: settings.sourceLanguage === 'auto' ? null : settings.sourceLanguage,
        translatePartials: settings.translatePartials,
      };
      const reply = await sendToOffscreen({ target: 'offscreen', type: 'start', config });
      if (!reply.ok) throw new Error(reply.error.message);
    } catch (err) {
      console.error(LOG_PREFIX, 'start failed', err);
      await setStatus({ state: 'error', tabId, sessionId, message: startError(err) });
      await closeOffscreenDocument().catch(() => {});
    }
    return getStatus();
  });
}

export function stopSession(): Promise<SessionStatus> {
  return exclusive(stopNow);
}

async function stopNow(): Promise<SessionStatus> {
  await closeOffscreenDocument().catch((err: unknown) =>
    console.warn(LOG_PREFIX, 'closing the offscreen document failed', err),
  );
  await setStatus({ state: 'idle' });
  return { state: 'idle' };
}

/** A status report from the offscreen document. Stale sessions are ignored. */
export async function onOffscreenStatus(status: ActiveSessionStatus): Promise<void> {
  const current = await getStatus();
  if (current.state === 'idle' || current.sessionId !== status.sessionId) return;
  await setStatus(status);
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
  // A navigation in the captured tab drops its overlay; put it back when the page has loaded.
  // Works where the access still holds (same site, or host access granted); otherwise the
  // subtitles return on the next click.
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status !== 'complete') return;
    void getStatus().then((s) => {
      if (s.state !== 'idle' && s.state !== 'error' && s.tabId === tabId) {
        injectOverlay(tabId).catch(() => {});
      }
    });
  });
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

async function sendToOffscreen(command: OffscreenCommand): Promise<OffscreenReply> {
  for (let attempt = 0; ; attempt++) {
    try {
      const reply = (await browser.runtime.sendMessage(command)) as OffscreenReply | undefined;
      if (reply) return reply;
      throw new Error('The offscreen document did not answer.');
    } catch (err) {
      // The document can be a moment late registering its listener.
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
  }
}

function startError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/Cannot access|cannot be scripted|chrome:\/\/|Missing host permission/i.test(message)) {
    return "Earshot can't run on this page.";
  }
  if (/activeTab|has not been invoked|Extension has not been invoked/i.test(message)) {
    return 'Click the Earshot button on this tab first.';
  }
  return message;
}
