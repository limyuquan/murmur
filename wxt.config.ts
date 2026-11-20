import { createRequire } from 'node:module';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

/**
 * LiteRT-LM's WebAssembly, for the LLM translation worker (src/engines/llm/worker.ts): only the
 * build for browsers with relaxed SIMD and JSPI (24 MB; the package's three others are for older
 * browsers), copied to `litert/` in the extension. The runtime's default is a CDN; the worker
 * always names this copy.
 */
const LITERT_WASM = path.join(
  path.dirname(createRequire(import.meta.url).resolve('@litert-lm/core/package.json')),
  'wasm',
);
const LITERT_FILES = ['litertlm_wasm_internal.js', 'litertlm_wasm_internal.wasm'];

/** Licence files, copied to the extension's root so every build carries them. */
const LICENCE_FILES = ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt'];

/**
 * Public half of the key that fixes the unpacked extension ID (EXTENSION_ID in src/shared/ids.ts).
 * The private half was never saved. A fixed ID lets a future local companion app list Murmur in
 * its native-messaging `allowed_origins`.
 */
const PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsqoaTZGI3zf4zzOZ1ytCFoz/SAMrg5MGU0ggmmzlOK/7WNhVDYhupz/n0l7oc3ytHfxEFxCzeN1ODRzTrWOSiD74/U4c6jJX/RQoj8IkgyaTgeuBY8Ode1VUWSH+jb/7Gjmk/jVGyJHwnZtVUNxvlgPjkmicJGwbDTgzL9ry0dgNKKcPS9wYMI7VQ/XPsQKDnOF3mAtJTv2UzCg7zUdEhkmLciQqoohi29V10hmbm/Ytw3cZJfuMxAifiUpwBnRfco6G0DGa8i4z/bB5i4ahSjaGPfqEeuNiao1Nb3Wd+9qI5uRrurvNmB6eX4lkw6FDITJyEU9e/sNWD+9M2M7mKQIDAQAB';

/**
 * Outside e2e builds, the demo and test engines' factories (src/engines/demo/factories.ts) are an
 * empty map, so their code isn't bundled (a branch on the build mode alone still emits the
 * chunks its dynamic imports name).
 */
function noDemoEngines(mode: string) {
  return {
    name: 'murmur:no-demo-engines',
    enforce: 'pre' as const,
    load(id: string) {
      if (mode === 'e2e') return null;
      return id.split('?')[0]?.endsWith('/src/engines/demo/factories.ts')
        ? 'export const DEMO_FACTORIES = {};'
        : null;
    },
  };
}

/**
 * Optional suffix for the output folder (e.g. `MURMUR_E2E_ID=a pnpm test:e2e` builds into
 * `.output/chrome-mv3-e2e-a`), so parallel runs don't overwrite each other's e2e build.
 * tests/e2e/fixtures.ts reads the same variable.
 */
const outSuffix = process.env.MURMUR_E2E_ID ? `-${process.env.MURMUR_E2E_ID}` : '';

/**
 * Murmur build config. The manifest is generated from here.
 *
 * Modes:
 * - `production` (`pnpm build`, `pnpm zip`): the build people load unpacked, fixed ID via `key`.
 * - `development` (`pnpm dev`): WXT dev runner, fixed ID via `key`.
 * - `e2e` (`pnpm build:e2e`): outputs to `.output/chrome-mv3-e2e`, fixed ID via `key`, adds
 *   `<all_urls>` so Playwright can inject the overlay without a toolbar click, and enables the
 *   `__murmur` test hooks (gated on `import.meta.env.MODE === 'e2e'`, tree-shaken elsewhere).
 */
export default defineConfig({
  srcDir: 'src',
  outDirTemplate: `{{browser}}-mv{{manifestVersion}}{{modeSuffix}}${outSuffix}`,
  modules: ['@wxt-dev/module-react'],
  manifestVersion: 3,
  // Explicit imports everywhere (`wxt/browser`, `wxt/utils/define-background`, ...). Easier to
  // read for parallel agents and keeps Biome's undeclared-variable checks meaningful.
  imports: false,
  hooks: {
    'build:publicAssets': (_wxt, files) => {
      for (const file of LITERT_FILES) {
        files.push({ absoluteSrc: path.join(LITERT_WASM, file), relativeDest: `litert/${file}` });
      }
      for (const file of LICENCE_FILES) {
        files.push({ absoluteSrc: path.resolve(import.meta.dirname, file), relativeDest: file });
      }
    },
  },
  vite: (env) => ({
    plugins: [tailwindcss(), noDemoEngines(env.mode)],
    // The speech model worker imports transformers.js, which is ESM with top-level await.
    worker: { format: 'es' },
  }),
  manifest: ({ mode }) => ({
    name: 'Murmur',
    description: 'Live translated subtitles over any video, made on your own machine.',
    // Chrome's translator (Light, and the backup for late lines) is 138+; Light's on-device speech
    // recognition is 139+ (older: Whisper base); the translation model's runtime is 137+.
    minimum_chrome_version: '138',
    key: PUBLIC_KEY,
    permissions: [
      // Tab audio, minted by the service worker and opened by the offscreen document.
      'tabCapture',
      // The one offscreen document that holds the audio graph and the speech models.
      'offscreen',
      // A toolbar click or the shortcut grants the current tab: capture and overlay injection,
      // with no install warning and no standing access to any site.
      'activeTab',
      // Injects the overlay script into the tab (all frames) on demand.
      'scripting',
      // Settings (local) and the running session (session).
      'storage',
      // Downloaded models live in the Cache API / OPFS; keep them from being evicted.
      'unlimitedStorage',
    ],
    // WebAssembly for the speech models (ONNX Runtime), from the extension's own files only.
    // No cross-origin isolation headers: they break tab capture, and threads work without them.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    // Asked for at runtime only (keep subtitles across page loads, players in cross-origin
    // frames). Never granted at install.
    optional_host_permissions: ['<all_urls>'],
    // e2e only: Playwright can't click the toolbar, so the test build gets the access a click
    // would grant.
    ...(mode === 'e2e' && { host_permissions: ['<all_urls>'] }),
    // `default_popup` comes from the `popup` entrypoint. `icons` is discovered from public/icon/
    // (rendered from assets/icon.svg by `pnpm icons`).
    action: {
      default_title: 'Murmur',
      default_icon: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png' },
    },
    // `options_ui` comes from the `options` entrypoint (opens in a tab: see its index.html).
    // Names in src/shared/commands.ts.
    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+E' },
        description: 'Open Murmur',
      },
      'toggle-subtitles': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Subtitles on or off for this tab',
      },
      'toggle-original': {
        description: 'Show or hide the original line',
      },
    },
  }),
});
