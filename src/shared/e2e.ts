/**
 * Test-only hooks, present only in e2e builds (`import.meta.env.MODE === 'e2e'`). Production
 * builds tree-shake them away. Playwright reaches them through `serviceWorker.evaluate`.
 */
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
}

/** On the offscreen document's global as `__murmurLog` (e2e builds): what the session produced. */
export interface OffscreenTestLog {
  /** Every cue sent to the overlay, with the epoch ms it was sent. */
  cues: { at: number; cue: Cue }[];
  /** Chrome speech: which recognizer won each segment, with every candidate's score. */
  arbitrations: { at: number; record: unknown }[];
  /** Segment decodes of engines that report them (Qwen3-ASR): kind, timing, text. */
  decodes: { at: number; record: unknown }[];
  engines: { asr: string; translation: string } | null;
  /** The session's speech detector, and the time it has spent so far (live). */
  vad: { detector: 'silero' | 'energy'; cost: { frames: number; ms: number } | null } | null;
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
