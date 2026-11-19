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
   * `engines`: `demo` (default; no models, no network) or `settings` (the real engines the
   * settings choose, for checks on a machine that has them).
   */
  start(tabId: number, source?: 'tab' | 'tone', engines?: 'demo' | 'settings'): Promise<void>;
  stop(): Promise<void>;
}

/** On the offscreen document's global as `__murmurLog` (e2e builds): what the session produced. */
export interface OffscreenTestLog {
  /** Every cue sent to the overlay, with the epoch ms it was sent. */
  cues: { at: number; cue: Cue }[];
  /** Chrome speech: which recognizer won each segment, with every candidate's score. */
  arbitrations: { at: number; record: unknown }[];
  engines: { asr: string; translation: string } | null;
}

declare global {
  var __murmur: BackgroundTestHook | undefined;
  var __murmurLog: OffscreenTestLog | undefined;
}
