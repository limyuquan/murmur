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
import { type ResolvedEngines, resolveEngines } from '@/engines/profiles';
import type {
  ActiveSessionStatus,
  CaptureSourceSpec,
  OffscreenCommand,
  OffscreenReply,
  SessionConfig,
  SessionErrorCode,
  SessionStatus,
} from '@/messaging/protocol';
import { modelsFor } from '@/models/catalog';
import { loadSettings, type Settings, spokenLanguages } from '@/settings/settings';
import { LOG_PREFIX } from '@/shared/ids';
import { LANGUAGES } from '@/ui/languages';
import { showBadge } from './badge';
import { deviceHardware, registry } from './engines';
import { modelStore } from './models';

const SESSION_KEY = 'session';
const OVERLAY_SCRIPT = '/overlay.js';

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
  return resolveEngines(s.profile, s.custom, registry, await deviceHardware());
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
      const engines = options.engines ?? (await plannedEngines(settings));
      const spoken = spokenLanguages(settings, navigator.languages, LANGUAGES);
      if (!options.engines) {
        // Models download only when the person asks: say so before capturing anything.
        const needed = modelsFor(
          settings.profile,
          settings.custom,
          registry,
          await deviceHardware(),
        );
        const downloaded = await modelStore.downloaded(needed);
        const missing = needed.filter((m) => !downloaded.has(m.id));
        if (missing.length > 0) {
          const names = missing.map((m) => m.label).join(' and ');
          await setStatus({
            state: 'error',
            tabId,
            sessionId,
            code: 'model',
            message: `${names} ${missing.length > 1 ? 'aren’t' : 'isn’t'} downloaded yet. Download in Settings, under Models.`,
            missingModels: missing.map((m) => m.id),
          });
          return getStatus();
        }
      }
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
        // One language and nothing else: say so to the engines as the source language.
        sourceLanguage: settings.onlySpoken && spoken.length === 1 ? (spoken[0] ?? null) : null,
        translatePartials: settings.translatePartials,
        spokenLanguages: spoken,
        onlySpoken: settings.onlySpoken,
      };
      const reply = await sendToOffscreen({ target: 'offscreen', type: 'start', config });
      if (!reply.ok) throw new Error(reply.error.message);
    } catch (err) {
      console.error(LOG_PREFIX, 'start failed', err);
      await setStatus({ state: 'error', tabId, sessionId, ...startError(err) });
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

function startError(err: unknown): { message: string; code: SessionErrorCode } {
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
