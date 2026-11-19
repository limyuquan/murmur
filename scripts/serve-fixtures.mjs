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
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const port = Number(process.env.FIXTURE_PORT ?? 4392);
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
