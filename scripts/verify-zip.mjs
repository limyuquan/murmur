#!/usr/bin/env node
/**
 * Checks a release zip before it ships:
 * - its manifest keeps the public `key`, so Chrome gives the unpacked extension the fixed ID in
 *   src/shared/ids.ts (settings and downloaded models survive an update), its version matches
 *   package.json, and it asks for no more than the expected permissions;
 * - it has the files a working build needs (the WebAssembly runtimes, the speech detector model,
 *   the licence files), and none of the e2e builds' test hooks;
 * - it stays within a size budget.
 * Usage: node scripts/verify-zip.mjs .output/murmur-<version>-chrome.zip
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const PERMISSIONS = [
  'tabCapture',
  'offscreen',
  'activeTab',
  'scripting',
  'storage',
  'unlimitedStorage',
];

/** Files every build needs, as patterns over the zip's paths. */
const REQUIRED = [
  ['the manifest', /^manifest\.json$/],
  ['the licence', /^LICENSE$/],
  ['the notice', /^NOTICE$/],
  ['the third-party notices', /^THIRD_PARTY_NOTICES\.txt$/],
  ['the service worker', /^background\.js$/],
  ['the offscreen document', /^offscreen\.html$/],
  ['the overlay', /^overlay\.js$/],
  ['the translation model worker', /^llm-worker\.js$/],
  ['LiteRT-LM’s WebAssembly glue', /^litert\/litertlm_wasm_internal\.js$/],
  ['LiteRT-LM’s WebAssembly', /^litert\/litertlm_wasm_internal\.wasm$/],
  ['ONNX Runtime’s WebAssembly', /^assets\/ort-wasm-simd-threaded\.asyncify-[\w-]+\.wasm$/],
  ['ONNX Runtime’s WebAssembly glue', /^assets\/ort-wasm-simd-threaded\.asyncify-[\w-]+\.mjs$/],
  ['the Silero VAD model', /^assets\/silero_vad-[\w-]+\.onnx$/],
  ['the Figtree font', /^assets\/figtree-latin-wght-normal-[\w-]+\.woff2$/],
];

/** What only e2e builds may contain (test hooks, test engines, simulated failures). */
const FORBIDDEN = [
  '__murmurLog',
  'globalThis.__murmur=',
  'simulateOutOfMemory',
  'NeedsPackAsrEngine',
  'StalledAsrEngine',
  'demo-needs-pack',
];

/** Largest release zip, bytes. */
const MAX_ZIP_BYTES = 30 * 1024 * 1024;

const zip = process.argv[2];
if (!zip) {
  console.error('usage: node scripts/verify-zip.mjs <zip>');
  process.exit(2);
}
/** Notices the licence files must carry, for what the build bundles. */
const NOTICES = [
  ['THIRD_PARTY_NOTICES.txt', 'Figtree'],
  ['THIRD_PARTY_NOTICES.txt', 'SIL OPEN FONT LICENSE Version 1.1'],
];

const fail = (message) => {
  console.error(`verify-zip: ${zip}: ${message}`);
  process.exit(1);
};

const manifest = JSON.parse(
  execFileSync('unzip', ['-p', zip, 'manifest.json'], { encoding: 'utf8' }),
);
const ids = readFileSync(new URL('../src/shared/ids.ts', import.meta.url), 'utf8');
const expected = /EXTENSION_ID\s*=\s*'([a-p]{32})'/.exec(ids)?.[1];
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

if (!expected) fail('could not read EXTENSION_ID from src/shared/ids.ts');
if (!manifest.key) fail('manifest.json has no "key" ; build it with `pnpm zip`');
// Chrome's ID: the first 32 hex digits of SHA-256(public key), with 0-f written as a-p.
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex')]
  .slice(0, 32)
  .map((c) => 'abcdefghijklmnop'[Number.parseInt(c, 16)])
  .join('');
if (id !== expected) fail(`the key gives ID ${id}, not ${expected}`);
if (manifest.version !== version)
  fail(`manifest version ${manifest.version} is not package.json's ${version}`);
const extra = (manifest.permissions ?? []).filter((p) => !PERMISSIONS.includes(p));
if (extra.length > 0) fail(`unexpected permissions: ${extra.join(', ')}`);
if (manifest.host_permissions?.length)
  fail(`host_permissions must be empty (asked for at runtime)`);

const paths = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 1 << 24 })
  .split('\n')
  .filter(Boolean);
for (const [what, pattern] of REQUIRED) {
  if (!paths.some((p) => pattern.test(p))) fail(`${what} is missing (${pattern})`);
}
for (const path of paths.filter((p) => /\.(js|mjs|html|json|css)$/.test(p))) {
  const text = execFileSync('unzip', ['-p', zip, path], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const found = FORBIDDEN.find((needle) => text.includes(needle));
  if (found) fail(`${path} contains "${found}": an e2e build?`);
}
for (const [file, needle] of NOTICES) {
  const text = execFileSync('unzip', ['-p', zip, file], { encoding: 'utf8', maxBuffer: 1 << 24 });
  if (!text.includes(needle)) fail(`${file} doesn’t mention ${needle}`);
}
const size = statSync(zip).size;
if (size > MAX_ZIP_BYTES) {
  fail(`${(size / 1048576).toFixed(1)} MB, over the ${MAX_ZIP_BYTES / 1048576} MB budget`);
}
console.log(
  `${zip}: Murmur ${manifest.version}, ID ${id}, ${paths.length} files, ${(size / 1048576).toFixed(1)} MB`,
);
