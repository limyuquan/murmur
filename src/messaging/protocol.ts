/**
 * Every message between Earshot's contexts, typed in one place.
 *
 *   popup / options ──Request──▶ service worker            (runtime.sendMessage, `target: 'background'`)
 *   service worker ──OffscreenCommand──▶ offscreen doc     (runtime.sendMessage, `target: 'offscreen'`)
 *   offscreen doc ──OffscreenEvent──▶ service worker       (runtime.sendMessage, `target: 'background'`)
 *   overlay (content script) ◀──OverlayMessage── offscreen (runtime.Port named OVERLAY_PORT)
 *
 * `runtime.sendMessage` reaches every extension page, so each listener checks `target` and stays
 * silent (returns nothing) for messages that aren't its own. The overlay talks to the offscreen
 * document directly over a port, keeping per-cue traffic off the service worker; the port's
 * disconnect is also how the overlay learns the session ended.
 */
import type { LanguageTag } from '@/engines/types';
import type { Cue } from '@/pipeline/types';
import type { OverlaySettings } from '@/settings/settings';

// ---------------------------------------------------------------------------------------------
// Session state (service worker owns it; kept in storage.session so it outlives worker restarts)

/**
 * What a running session is doing, for the popup. Reported by the offscreen document at most once
 * a second, and only when something here changes.
 */
export interface SessionActivity {
  /** `listening`: waiting for speech. `transcribing`: a line is being heard. `translating`: a
   * finished line is waiting for its translation. */
  stage: 'listening' | 'transcribing' | 'translating';
  /** Languages heard in recent lines, most heard first (BCP-47). */
  languages: LanguageTag[];
  /** Languages heard recently that the engines can't handle. */
  unsupported: LanguageTag[];
  /** Typical delay from speech to its finished subtitle lately, ms; null before the first. */
  delayMs: number | null;
  /** Subtitles are falling further behind the speech than the engines can make up. */
  behind: boolean;
  /** How long the tab has been silent, ms. */
  silentMs: number;
  /** Any sound at all since the session started. */
  soundEver: boolean;
}

/**
 * Why a session failed, so the popup can offer the fix. `message` stays the words to show.
 * - `page`: Earshot can't run on this page (browser pages, the web store).
 * - `access`: Chrome needs the toolbar button clicked on this tab first.
 * - `busy`: something else is capturing the tab.
 * - `companion`: the profile needs the companion app and it isn't running.
 * - `model`: a model failed to load or isn't downloaded.
 * - `unknown`: anything else.
 */
export type SessionErrorCode = 'page' | 'access' | 'busy' | 'companion' | 'model' | 'unknown';

export type SessionStatus =
  | { state: 'idle' }
  | { state: 'starting'; tabId: number; sessionId: string }
  | {
      state: 'loading';
      tabId: number;
      sessionId: string;
      /** 0–1 when known. */
      progress: number | null;
      detail: string;
    }
  | {
      state: 'running';
      tabId: number;
      sessionId: string;
      asr: string;
      translation: string;
      /** Speech has been heard at least once. */
      heard: boolean;
      /** Absent until the first report. */
      activity?: SessionActivity;
    }
  | {
      state: 'error';
      tabId: number;
      sessionId: string;
      message: string;
      code?: SessionErrorCode;
    };

export type ActiveSessionStatus = Exclude<SessionStatus, { state: 'idle' }>;

// ---------------------------------------------------------------------------------------------
// Popup / options → service worker

export interface TabView {
  tabId: number;
  status: SessionStatus;
  /** The session is on this tab (any state but idle). */
  thisTab: boolean;
  /** Engines a new session would use, by label. */
  engines: { asr: string; translation: string; notes: string[] };
}

/** op → [args, result]. */
export interface Ops {
  /** What the popup shows for `tabId`. */
  view: [{ tabId: number }, TabView];
  /** Starts subtitles on `tabId` (stopping any other session first). */
  start: [{ tabId: number }, SessionStatus];
  /** Stops the session, wherever it is. */
  stop: [Record<string, never>, SessionStatus];
}

export type Op = keyof Ops;

export interface Request<K extends Op = Op> {
  target: 'background';
  op: K;
  args: Ops[K][0];
}

export type Response<K extends Op = Op> =
  | { ok: true; result: Ops[K][1] }
  | { ok: false; error: { message: string } };

// ---------------------------------------------------------------------------------------------
// Service worker → offscreen document

export type CaptureSourceSpec =
  /** Tab audio from `tabCapture.getMediaStreamId`. */
  | { kind: 'tab'; streamId: string }
  /** The synthetic test tone (e2e builds). */
  | { kind: 'tone' };

export interface SessionConfig {
  sessionId: string;
  tabId: number;
  source: CaptureSourceSpec;
  asrEngine: string;
  translationEngine: string;
  targetLanguage: string;
  /** `null` = detect per segment. */
  sourceLanguage: string | null;
  translatePartials: boolean;
}

export type OffscreenCommand =
  | { target: 'offscreen'; type: 'start'; config: SessionConfig }
  | { target: 'offscreen'; type: 'stop' };

export type OffscreenReply = { ok: true } | { ok: false; error: { message: string } };

// ---------------------------------------------------------------------------------------------
// Offscreen document → service worker

export type OffscreenEvent = {
  target: 'background';
  type: 'session-status';
  status: ActiveSessionStatus;
};

// ---------------------------------------------------------------------------------------------
// Offscreen document ↔ overlay

/** Name of the runtime.Port the overlay opens to the offscreen document. */
export const OVERLAY_PORT = 'earshot-overlay';

/** What the overlay says about the session on the picture (a small chip). */
export type OverlayStatus =
  | { state: 'loading'; detail: string; progress: number | null }
  /** `behindMs`: how late subtitles are when falling behind, else null. */
  | { state: 'running'; behindMs: number | null }
  | { state: 'error'; message: string };

export type OverlayMessage =
  /** A new or changed cue: replace by `cue.id`. */
  | { type: 'cue'; cue: Cue }
  /** Drop every cue (new session on the same page). */
  | { type: 'reset' }
  | { type: 'status'; status: OverlayStatus };

/** The overlay's chip for a session status. */
export function overlayStatus(status: ActiveSessionStatus): OverlayStatus {
  switch (status.state) {
    case 'starting':
      return { state: 'loading', detail: 'Starting', progress: null };
    case 'loading':
      return { state: 'loading', detail: status.detail, progress: status.progress };
    case 'running': {
      const a = status.activity;
      return { state: 'running', behindMs: a?.behind ? (a.delayMs ?? 0) : null };
    }
    case 'error':
      return { state: 'error', message: status.message };
  }
}

/** Overlay → offscreen. */
export type OverlayHello = { type: 'hello'; frameUrl: string };

/** What the overlay renders with; the overlay reads it from storage itself. */
export type { OverlaySettings };

// ---------------------------------------------------------------------------------------------
// Guards

export function isRequest(m: unknown): m is Request {
  return isTargeted(m, 'background') && typeof (m as { op?: unknown }).op === 'string';
}

export function isOffscreenEvent(m: unknown): m is OffscreenEvent {
  return isTargeted(m, 'background') && (m as { type?: unknown }).type === 'session-status';
}

export function isOffscreenCommand(m: unknown): m is OffscreenCommand {
  return isTargeted(m, 'offscreen');
}

function isTargeted(m: unknown, target: string): boolean {
  return typeof m === 'object' && m !== null && (m as { target?: unknown }).target === target;
}
