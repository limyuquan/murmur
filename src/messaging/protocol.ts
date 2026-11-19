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
import type { Cue } from '@/pipeline/types';
import type { OverlaySettings } from '@/settings/settings';

// ---------------------------------------------------------------------------------------------
// Session state (service worker owns it; kept in storage.session so it outlives worker restarts)

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
    }
  | { state: 'error'; tabId: number; sessionId: string; message: string };

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

export type OverlayMessage =
  /** A new or changed cue: replace by `cue.id`. */
  | { type: 'cue'; cue: Cue }
  /** Drop every cue (new session on the same page). */
  | { type: 'reset' };

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
