#!/usr/bin/env node
/**
 * Static server for e2e fixture pages (tests/fixtures/pages) on http://127.0.0.1:<port>.
 * No dependencies. `tests/fixtures/pages/clip.webm` is a 4 s, 320×180 test clip (solid colour,
 * 220 Hz tone), made with:
 *
 *   ffmpeg -f lavfi -i "color=c=0x2a4d69:s=320x180:d=4:r=10" -f lavfi -i "sine=frequency=220:duration=4" \
 *     -c:v libvpx -b:v 30k -c:a libopus -b:a 24k -shortest tests/fixtures/pages/clip.webm
 *
 *   FIXTURE_PORT=5000 node scripts/serve-fixtures.mjs
 *
 * The pages are also served on the next port (FIXTURE_PORT + 1), another origin, so a fixture can
 * embed a frame from "another site" (frames.html).
 *
 * `/hf/<repo>/resolve/<revision>/<path>` stands in for Hugging Face in e2e builds (MODEL_HOST in
 * src/models/hub.ts): any file listed in an engine's files.json (src/engines/{whisper,qwen3asr}),
 * at its real size, filled with a fixed pattern, with Range support, at `FIXTURE_HF_MBPS` MB/s
 * (default 40) so downloads take long enough to watch and cancel. Files of the `murmur` group
 * (Murmur's own, whose repo isn't published yet) are served under any repo.
 *
 * `FIXTURE_HF_DIR=<dir>` serves real model files instead, unthrottled, where it has them: from
 * `<dir>/<repo>/<path>`, else `<dir>/<path>`. With a build that downloads from here
 * (`WXT_MODEL_HOST=http://127.0.0.1:4392/hf pnpm build:e2e`), real models load in a real Chrome
 * before they are published.
 */
import { createReadStream, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const port = Number(process.env.FIXTURE_PORT ?? 4392);
const hfSpeed = Number(process.env.FIXTURE_HF_MBPS ?? 40) * 1e6;
const hfDir = process.env.FIXTURE_HF_DIR ? path.resolve(process.env.FIXTURE_HF_DIR) : null;
const readJson = async (file) =>
  JSON.parse(await readFile(new URL(`../src/engines/${file}`, import.meta.url), 'utf8'));
/** `<repo>/<path>` → bytes; `murmur` group files by path alone (any repo). */
const modelFiles = new Map();
const anyRepoFiles = new Map();
for (const entry of Object.values(await readJson('whisper/files.json'))) {
  for (const [file, bytes] of [...entry.shared, ...(entry.webgpu ?? []), ...(entry.wasm ?? [])]) {
    modelFiles.set(`${entry.repo}/${file}`, bytes);
  }
}
const qwen = await readJson('qwen3asr/files.json');
for (const [file, bytes] of qwen.upstream.files)
  modelFiles.set(`${qwen.upstream.repo}/${file}`, bytes);
for (const [file, bytes] of qwen.murmur.files) anyRepoFiles.set(file, bytes);

/** A real file for `<repo>/<path>` under FIXTURE_HF_DIR, or null. */
function localModelFile(repo, file) {
  if (!hfDir) return null;
  for (const candidate of [path.join(hfDir, repo, file), path.join(hfDir, file)]) {
    if (!candidate.startsWith(hfDir + path.sep)) continue;
    try {
      const stat = statSync(candidate);
      if (stat.isFile()) return { file: candidate, size: stat.size };
    } catch {}
  }
  return null;
}

/** Streams bytes [start, end] of a real model file. */
function serveLocalFile(req, res, { file, size }) {
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
  res.writeHead(range ? 206 : 200, {
    'content-type': 'application/octet-stream',
    'content-length': String(end - start + 1),
    ...(range && { 'content-range': `bytes ${start}-${end}/${size}` }),
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  createReadStream(file, { start, end }).pipe(res);
}

/** Streams bytes [start, end] of a stand-in model file, throttled. */
async function serveModelFile(req, res, size) {
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
  res.writeHead(range ? 206 : 200, {
    'content-type': 'application/octet-stream',
    'content-length': String(end - start + 1),
    ...(range && { 'content-range': `bytes ${start}-${end}/${size}` }),
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  const chunk = 1 << 20;
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  for (let at = start; at <= end && !closed; at += chunk) {
    const n = Math.min(chunk, end - at + 1);
    const buf = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i++) buf[i] = (at + i) % 251;
    if (!res.write(buf)) await new Promise((r) => res.once('drain', r));
    await new Promise((r) => setTimeout(r, (n / hfSpeed) * 1000));
  }
  res.end();
}
const root = path.resolve(new URL('../tests/fixtures/pages', import.meta.url).pathname);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.webm': 'video/webm',
  '.js': 'text/javascript',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  const hf = /^\/hf\/([^/]+\/[^/]+)\/resolve\/[^/]+\/(.+)$/.exec(url.pathname);
  if (hf) {
    const file = decodeURIComponent(hf[2]);
    const local = localModelFile(hf[1], file);
    if (local) {
      serveLocalFile(req, res, local);
      return;
    }
    const size = modelFiles.get(`${hf[1]}/${file}`) ?? anyRepoFiles.get(file);
    if (size === undefined) {
      res.writeHead(404, { 'access-control-allow-origin': '*' });
      res.end('not found');
    } else {
      await serveModelFile(req, res, size);
    }
    return;
  }
  const file = path.join(root, path.normalize(url.pathname));
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const body = await readFile(file);
    const type = types[path.extname(file)] ?? 'application/octet-stream';
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : body.length - 1;
      res.writeHead(206, {
        'content-type': type,
        'content-range': `bytes ${start}-${end}/${body.length}`,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      });
      res.end(body.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, {
      'content-type': type,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fixtures: http://127.0.0.1:${port}/`);
});
// The same pages on the next port: another origin, for frames from another site.
createServer((req, res) => server.emit('request', req, res)).listen(port + 1, '127.0.0.1');
