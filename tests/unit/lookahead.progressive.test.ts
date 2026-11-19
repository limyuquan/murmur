/**
 * Progressive sources: range reads that never download a whole file when the server ignores
 * Range, the file's size from the right header, reads through the page first, and retries
 * before a source gives up.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_SKIP_BYTES, rangeBody } from '@/lookahead/bytes';
import { fallbackReader, ProgressiveSource, type RangeReader } from '@/lookahead/progressive';

const FILE = new Uint8Array(
  readFileSync(new URL('./fixtures/lookahead/aac-progressive.mp4', import.meta.url)),
);

/** A 200 response streamed in chunks, counting how many bytes were pulled. */
function streamed(bytes: Uint8Array, chunk = 1000, headers: Record<string, string> = {}) {
  let pulled = 0;
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      const piece = bytes.slice(at, at + chunk);
      at += piece.length;
      pulled += piece.length;
      controller.enqueue(piece);
    },
  });
  return { response: new Response(body, { status: 200, headers }), pulled: () => pulled };
}

describe('rangeBody', () => {
  it('reads a 206 as the range, with the size from Content-Range', async () => {
    const res = new Response(FILE.slice(10, 20), {
      status: 206,
      headers: { 'content-range': `bytes 10-19/${FILE.length}` },
    });
    const { bytes, total } = await rangeBody(res, 10, 20);
    expect([...bytes]).toEqual([...FILE.slice(10, 20)]);
    expect(total).toBe(FILE.length);
  });

  it('streams a 200 only as far as the range, with the size from Content-Length', async () => {
    const big = new Uint8Array(1_000_000).map((_, i) => i % 251);
    const s = streamed(big, 1000, { 'content-length': String(big.length) });
    const { bytes, total } = await rangeBody(s.response, 5000, 5100);
    expect([...bytes]).toEqual([...big.slice(5000, 5100)]);
    // The whole file's size, not the read's.
    expect(total).toBe(big.length);
    expect(s.pulled()).toBeLessThan(10_000);
  });

  it('refuses a 200 whose range starts far into the file', async () => {
    const s = streamed(new Uint8Array(10));
    await expect(rangeBody(s.response, MAX_SKIP_BYTES + 1, MAX_SKIP_BYTES + 10)).rejects.toThrow(
      /ignores byte ranges/,
    );
  });
});

describe('fallbackReader', () => {
  it('reads through the first until it fails, then the second from then on', async () => {
    const calls: string[] = [];
    const reader = (name: string, fails: boolean): RangeReader => ({
      async read(start, end) {
        calls.push(`${name} ${start}`);
        if (fails) throw new Error('CORS');
        return { bytes: new Uint8Array(end - start), total: null };
      },
    });
    const r = fallbackReader(reader('page', true), reader('offscreen', false));
    await r.read(0, 4);
    await r.read(4, 8);
    expect(calls).toEqual(['page 0', 'offscreen 0', 'offscreen 4']);
  });
});

describe('ProgressiveSource', () => {
  it('tries again after a failed read, waiting longer each time, before it gives up', async () => {
    let now = 0;
    let failing = true;
    let reads = 0;
    const reader: RangeReader = {
      async read(start, end) {
        reads++;
        if (failing) throw new Error('HTTP 503');
        return { bytes: FILE.slice(start, end), total: FILE.length };
      },
    };
    const configs: unknown[] = [];
    const source = new ProgressiveSource(
      reader,
      { config: (c) => configs.push(c), frame: () => {} },
      90,
      () => now,
    );
    await source.ensure(0);
    expect(source.failed).toBeNull();
    expect(reads).toBe(1);
    // Too soon: no read.
    now = 1000;
    await source.ensure(0);
    expect(reads).toBe(1);
    // The server is back.
    failing = false;
    now = 2500;
    await source.ensure(0);
    expect(source.failed).toBeNull();
    expect(configs).toHaveLength(1);

    // A source that keeps failing gives up after a few tries.
    const broken = new ProgressiveSource(
      { read: async () => Promise.reject(new Error('HTTP 503')) },
      { config: () => {}, frame: () => {} },
      90,
      () => now,
    );
    for (let i = 0; i < 10; i++) {
      now += 120_000;
      await broken.ensure(0);
    }
    expect(broken.failed).toBe('HTTP 503');
  });
});
