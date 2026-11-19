import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

/**
 * Unit tests: Node, fast. `wxt/browser` is WXT's in-memory fake browser.
 * Files: tests/unit/**\/*.test.ts. Pure logic only; anything that needs a real browser (audio
 * graph, overlay DOM) is covered by the Playwright e2e suite.
 */
export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/unit/setup.ts'],
  },
});
