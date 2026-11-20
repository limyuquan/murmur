/**
 * Playwright fixtures for Murmur e2e tests. Import `test` and `expect` from here.
 *
 * - `context`: persistent headless Chromium context with the e2e build loaded (fresh profile).
 * - `serviceWorker`: the extension's service worker (`__murmur` test hooks live on it).
 * - `murmur`: helpers to open fixtures, start/stop sessions and read the session status.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  type BrowserContext,
  test as base,
  chromium,
  type Frame,
  type Page,
  type Worker,
} from '@playwright/test';
import type { Browser } from 'wxt/browser';
import type { SessionStatus } from '@/messaging/protocol';
import type { E2eCommand } from '@/overlay';
import { EXTENSION_ID } from '@/shared/ids';
import { FIXTURE_ORIGIN } from '../../playwright.config';

/** Built by `pnpm build:e2e`. `MURMUR_E2E_ID` must match the one used for the build. */
export const EXTENSION_PATH = path.resolve(
  `.output/chrome-mv3-e2e${process.env.MURMUR_E2E_ID ? `-${process.env.MURMUR_E2E_ID}` : ''}`,
);

/** `chrome` and the test hook inside `serviceWorker.evaluate` callbacks. */
type SwGlobal = { chrome: typeof Browser; __murmur: import('@/shared/e2e').BackgroundTestHook };

export interface MurmurHelpers {
  /** Opens a fixture page (`tests/fixtures/pages/<name>`) in a new tab. */
  open(name: string): Promise<Page>;
  /** Chrome tab id of `page`. */
  tabId(page: Page): Promise<number>;
  /** What the popup's switch does, without the click. Captures the test tone unless `tab`. */
  start(page: Page, source?: 'tab' | 'tone'): Promise<number>;
  stop(): Promise<void>;
  status(): Promise<SessionStatus>;
  /** Dragged subtitle positions, per site. */
  positions(): Promise<Record<string, { x: number; y: number }>>;
}

interface Fixtures {
  context: BrowserContext;
  serviceWorker: Worker;
  murmur: MurmurHelpers;
}

export const test = base.extend<Fixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures take a destructured first argument.
  context: async ({}, use) => {
    if (!existsSync(path.join(EXTENSION_PATH, 'manifest.json'))) {
      throw new Error(`No e2e build at ${EXTENSION_PATH}. Run \`pnpm build:e2e\` first.`);
    }
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      // New headless mode: the full browser, with extensions. Never a visible window.
      headless: true,
      viewport: { width: 1280, height: 800 },
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        // No GPU: nothing here needs one, CI has none, and a half-working GPU stack (seen under
        // WSL) makes headless Chromium hang before `load`.
        '--disable-gpu',
        '--disable-software-rasterizer',
        // Lets tabCapture.getMediaStreamId work without the toolbar click Playwright can't make.
        `--allowlisted-extension-id=${EXTENSION_ID}`,
      ],
    });
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    const isOurs = (w: Worker) => w.url() === `chrome-extension://${EXTENSION_ID}/background.js`;
    const sw =
      context.serviceWorkers().find(isOurs) ??
      (await context.waitForEvent('serviceworker', { predicate: isOurs }));
    await use(sw);
  },

  murmur: async ({ context, serviceWorker }, use) => {
    const helpers: MurmurHelpers = {
      async open(name) {
        const page = await context.newPage();
        await page.goto(`${FIXTURE_ORIGIN}/${name}`);
        return page;
      },
      async tabId(page) {
        const url = page.url();
        const id = await serviceWorker.evaluate(async (u) => {
          const tabs = await (globalThis as unknown as SwGlobal).chrome.tabs.query({ url: u });
          return tabs[0]?.id ?? -1;
        }, url);
        if (id < 0) throw new Error(`No tab for ${url}`);
        return id;
      },
      async start(page) {
        const tabId = await helpers.tabId(page);
        await serviceWorker.evaluate(
          (id) => (globalThis as unknown as SwGlobal).__murmur.start(id),
          tabId,
        );
        return tabId;
      },
      async stop() {
        await serviceWorker.evaluate(() => (globalThis as unknown as SwGlobal).__murmur.stop());
      },
      async status() {
        return serviceWorker.evaluate(async () => {
          const s = await (globalThis as unknown as SwGlobal).chrome.storage.session.get('session');
          return (s.session ?? { state: 'idle' }) as SessionStatus;
        });
      },
      async positions() {
        return serviceWorker.evaluate(async () => {
          const s = await (globalThis as unknown as SwGlobal).chrome.storage.local.get('positions');
          return (s.positions ?? {}) as Record<string, { x: number; y: number }>;
        });
      },
    };
    await use(helpers);
  },
});

export const expect = test.expect;

/** Feeds the overlay in `target` directly (the e2e build's page event). */
export async function send(target: Page | Frame, command: E2eCommand): Promise<void> {
  await target.evaluate(
    (detail) => document.dispatchEvent(new CustomEvent('murmur-e2e', { detail })),
    JSON.stringify(command),
  );
}

/**
 * Makes the overlay in `target` ignore the session's cues, so the test controls every line, and
 * waits for a clear stage: a test-tone line that came before the hold fades out for a moment
 * (still in the DOM, matching the test's locators) before it goes.
 */
export async function hold(target: Page | Frame): Promise<void> {
  await send(target, { hold: true });
  await expect(target.locator('murmur-overlay .block')).toHaveCount(0);
}
