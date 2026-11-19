/**
 * Test-only hooks, present only in e2e builds (`import.meta.env.MODE === 'e2e'`). Production
 * builds tree-shake them away. Playwright reaches them through `serviceWorker.evaluate`.
 */

/** True in `pnpm build:e2e` builds only. */
export const IS_E2E = import.meta.env.MODE === 'e2e';

/** On the service worker global as `__earshot`. */
export interface BackgroundTestHook {
  /**
   * What the popup's switch does for `tabId`, minus the click: inject the overlay and start a
   * session. `tone` (default) captures the synthetic test tone; `tab` captures the tab's audio,
   * which without the toolbar click needs Chrome started with `--allowlisted-extension-id`.
   */
  start(tabId: number, source?: 'tab' | 'tone'): Promise<void>;
  stop(): Promise<void>;
}

declare global {
  var __earshot: BackgroundTestHook | undefined;
}
