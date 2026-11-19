/**
 * Test-only hooks, present only in e2e builds (`import.meta.env.MODE === 'e2e'`). Production
 * builds tree-shake them away. Playwright reaches them through `serviceWorker.evaluate`.
 */
import type { LookaheadSnapshot } from '@/lookahead/host';
import type { SegmentEvent } from '@/pipeline/segmenter';
import type { Cue } from '@/pipeline/types';

/** True in `pnpm build:e2e` builds only. */
export const IS_E2E = import.meta.env.MODE === 'e2e';

/** On the service worker global as `__murmur`. */
export interface BackgroundTestHook {
  /**
   * What the popup's switch does for `tabId`, minus the click: inject the overlay and start a
   * session. `tone` (default) captures the synthetic test tone; `tab` captures the tab's audio,
   * which without the toolbar click needs Chrome started with `--allowlisted-extension-id`.
   * `engines`: `demo` (default; no models, no network), `settings` (the real engines the
   * settings choose, for checks on a machine that has them), or these engine ids. Resolves once
   * the capture is open; the engines load after (poll the status).
   */
  start(
    tabId: number,
    source?: 'tab' | 'tone',
    engines?: 'demo' | 'settings' | { asr: string; translation: string },
  ): Promise<void>;
  stop(): Promise<void>;
  /** Lookahead on or off for `site` (the e2e build already has access to every site). */
  lookahead(site: string, on: boolean): Promise<void>;
  /** What the offscreen document logged (asked over runtime messaging). */
  offscreenLog(): Promise<OffscreenE2eLog | null>;
}

/** The offscreen document's answer to an `e2e-log` command. */
export interface OffscreenE2eLog {
  /** Live cues sent so far. */
  cues: number;
  /** The last 200 live cues sent, with the epoch ms each was sent. */
  liveCues: { at: number; cue: Cue }[];
  lookaheadCues: { at: number; cue: Cue }[];
  lookahead: LookaheadSnapshot | null;
}

/** On the offscreen document's global as `__murmurLog` (e2e builds): what the session produced. */
export interface OffscreenTestLog {
  /** Every cue sent to the overlay, with the epoch ms it was sent. */
  cues: { at: number; cue: Cue }[];
  /** Every lookahead cue, with the epoch ms it was sent. */
  lookaheadCues: { at: number; cue: Cue }[];
  /** What lookahead is doing now (null: not running in this session). */
  lookahead: () => LookaheadSnapshot | null;
  /** Chrome speech: which recognizer won each segment, with every candidate's score. */
  arbitrations: { at: number; record: unknown }[];
  /** Segment decodes of engines that report them (Qwen3-ASR): kind, timing, text. */
  decodes: { at: number; record: unknown }[];
  engines: { asr: string; translation: string } | null;
  /** Each segment's start and end (with why it ended), with the epoch ms it was sent. */
  segments: { at: number; event: SegmentEvent }[];
  /** The session's speech detector, and the time it has spent so far (live). */
  vad: { detector: 'silero' | 'energy'; cost: { frames: number; ms: number } | null } | null;
  /**
   * When each start-up step was done, epoch ms (`capture`, `asr`, `translation`: loaded and
   * warmed up, `pipeline`: live subtitles start), to measure how late the first line is.
   */
  startup: Record<string, number>;
}

/**
 * On the options page's global as `__murmurVadCheck` (e2e builds): loads the bundled Silero VAD
 * the way the offscreen document does and scores `samples` (16 kHz), for checks in a real browser.
 */
export type VadCheck = (samples: number[]) => Promise<{
  probs: number[];
  loadMs: number;
  /** Time in the model per frame: mean (includes warm-up) and median. */
  msPerFrame: number;
  medianMs: number;
}>;

declare global {
  var __murmur: BackgroundTestHook | undefined;
  var __murmurLog: OffscreenTestLog | undefined;
  var __murmurVadCheck: VadCheck | undefined;
}
