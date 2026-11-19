import { defineConfig } from '@playwright/test';

export const FIXTURE_PORT = Number(process.env.FIXTURE_PORT ?? 4392);
export const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;

const resultsSuffix = process.env.EARSHOT_E2E_ID ? `-${process.env.EARSHOT_E2E_ID}` : '';

/**
 * E2E: the extension (built by `pnpm build:e2e` into .output/chrome-mv3-e2e) is loaded into
 * Playwright's bundled Chromium, headless. `pnpm test:e2e` builds first; `playwright test` alone
 * reuses the last build.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: `test-results${resultsSuffix}`,
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { trace: 'retain-on-failure' },
  webServer: {
    command: 'node scripts/serve-fixtures.mjs',
    url: `${FIXTURE_ORIGIN}/`,
    reuseExistingServer: !process.env.CI,
    env: { FIXTURE_PORT: String(FIXTURE_PORT) },
  },
});
