/**
 * Every message between Murmur's contexts, typed in one place.
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
import type { ProfileChoice } from '@/engines/profiles';
import type { LanguageTag, SetupAction } from '@/engines/types';
import type { PlayheadReport, TeeWire } from '@/lookahead/protocol';
import type { ModelsView } from '@/models/types';
import type { Cue } from '@/pipeline/types';
import type { LookaheadSettings, OverlaySettings } from '@/settings/settings';

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
  /**
   * Subtitles are falling further behind the speech than the engines can make up: the delay is
   * long, lines queue for translation, the speech engine is slower than real time, or it says
   * it is skipping work.
   */
  behind: boolean;
  /** The speech engine's real-time factor lately (seconds of work per second of speech). */
  rtf: number | null;
  /** Speech heard but not yet recognized, ms. */
  backlogMs: number;
  /** Finished lines waiting for their translation. */
  queue: number;
  /** How long the tab has been silent, ms. */
  silentMs: number;
  /** Any sound at all since the session started. */
  soundEver: boolean;
}

/**
 * Why a session failed, so the popup can offer the fix. `message` stays the words to show.
 * - `page`: Murmur can't run on this page (browser pages, the web store).
 * - `access`: Chrome needs the toolbar button clicked on this tab first.
 * - `busy`: something else is capturing the tab.
 * - `companion`: the profile needs the companion app and it isn't running.
 * - `model`: a model failed to load or isn't downloaded.
 * - `navigated`: the tab went to another site that the session can't follow (no access without
 *   a click, or nothing to subtitle there), so it stopped.
 * - `setup`: Chrome needs a click to download a language pack first (`setup` lists them; a page
 *   runs each with `runSetupAction` from engines/chrome/setup.ts, then starts again).
 * - `unknown`: anything else.
 */
export type SessionErrorCode =
  | 'page'
  | 'access'
  | 'busy'
  | 'companion'
  | 'model'
  | 'navigated'
  | 'setup'
  | 'unknown';

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
      /**
       * Downloads that would let more lines be translated (a language heard whose pack isn't
       * there yet). Each needs a click: `runSetupAction` (engines/chrome/setup.ts).
       */
      setup?: SetupAction[];
      /**
       * Problems the session carries on despite (a speech recognizer that stopped for good), in
       * plain words.
       */
      problems?: string[];
      /**
       * Lines the chosen translator didn't translate (too slow, a failure, or it couldn't load),
       * which another one did instead, in plain words.
       */
      translationNote?: string;
    }
  | ({ state: 'error'; tabId: number; sessionId: string } & SessionFailure);

/** Why a session failed, with what the popup needs to offer the fix. */
export interface SessionFailure {
  message: string;
  code?: SessionErrorCode;
  /** With code `setup`: the downloads to start, one click each. */
  setup?: SetupAction[];
  /** With code `model`: models that aren't downloaded (`EngineModel.id`). */
  missingModels?: string[];
}

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
  profile: ProfileChoice;
  /**
   * The profile's models: all it needs downloaded, or how much is left to download. `better`: a
   * translation model it would use but can do without (another translator stands in), to offer.
   */
  models: {
    ready: boolean;
    missingMB: number;
    better?: { ids: string[]; label: string; sizeMB: number };
  };
  /** The tab's site (positions are kept per site), when Murmur can see its address. */
  site: string | null;
  /** Subtitles ahead of time (beta), for this site. */
  lookahead: {
    /** On for this site (and not switched off everywhere). */
    on: boolean;
    /** Switched off everywhere (Settings). */
    off: boolean;
    /** The engines a session would use can do it (Chrome's speech recognition can't). */
    supported: boolean;
  };
}

/** op → [args, result]. */
export interface Ops {
  /** What the popup shows for `tabId`. */
  view: [{ tabId: number }, TabView];
  /** Starts subtitles on `tabId` (stopping any other session first). */
  start: [{ tabId: number }, SessionStatus];
  /** Stops the session, wherever it is. */
  stop: [Record<string, never>, SessionStatus];
  /** Every model, its download state, and the space they use. */
  models: [Record<string, never>, ModelsView];
  /** Queues downloads; progress follows in `storage.session` (models/types.ts). */
  downloadModels: [{ ids: string[] }, ModelsView];
  cancelDownload: [{ id: string }, ModelsView];
  deleteModel: [{ id: string }, ModelsView];
  /**
   * Subtitles ahead of time on `site`, or not. The page asks for access to the site first (a
   * click is needed for that); this registers the page scripts.
   */
  setLookahead: [{ site: string; on: boolean }, LookaheadSettings];
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
  /**
   * Languages the person expects to hear. Chrome's speech recognition listens for these (the
   * first 4); translation packs are checked for each. Absent: engines choose (Chrome speech: the
   * languages whose packs are downloaded).
   */
  spokenLanguages?: string[];
  /** Only `spokenLanguages` are spoken: engines that detect languages pick among them. */
  onlySpoken?: boolean;
  /** The person's glossary (settings.ts); translators that use one get the entries a line needs. */
  glossary?: { source: string; target: string }[];
}

export type OffscreenCommand =
  | { target: 'offscreen'; type: 'start'; config: SessionConfig }
  | { target: 'offscreen'; type: 'stop' };

/**
 * The offscreen document answers `start` once the capture is open (models load after, with their
 * progress and any failure reported as `session-status` events), so a stop never waits for a load.
 * A failure carries the whole reason, so the service worker stores what the popup needs.
 */
export type OffscreenReply = { ok: true } | { ok: false; error: SessionFailure };

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
export const OVERLAY_PORT = 'murmur-overlay';

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
  /** To the top frame: whether a frame inside it has a video with its own overlay. */
  | { type: 'frames'; videoInFrame: boolean }
  | { type: 'status'; status: OverlayStatus }
  /**
   * Lookahead runs in this session. `lagS`: how long after the page plays a moment the person
   * hears it (Murmur plays the captured tab audio back itself), so cues are shown then.
   */
  | { type: 'lookahead'; lagS: number }
  /** Lookahead has finished subtitles for these spans of `timeline` (a content key). */
  | { type: 'coverage'; timeline: string; spans: [number, number][] }
  /** Lookahead cues of `timeline` starting in `[start, end)` are void (the audio was replaced). */
  | { type: 'drop'; timeline: string; start: number; end: number }
  /** Read bytes `[start, end)` of `url` with the page's access, answer with a `fetched` tee. */
  | { type: 'fetch'; id: number; url: string; start: number; end: number };

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

/**
 * Overlay → offscreen. `hello` first; `video` whenever the frame starts or stops having a video
 * to draw on, so the top frame knows when a player in another frame shows the subtitles.
 */
export type OverlayHello = { type: 'hello'; frameUrl: string };
export type OverlayToHost =
  | OverlayHello
  | { type: 'video'; present: boolean }
  /** Lookahead: what the page's player did (from the relay), or an answer to a `fetch`. */
  | { type: 'tee'; wire: TeeWire }
  /** Lookahead: where the video this frame follows is, and what it plays. */
  | { type: 'playhead'; report: PlayheadReport };

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
