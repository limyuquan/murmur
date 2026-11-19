/**
 * The demuxers on bytes made to exhaust them (a page can append anything to a SourceBuffer):
 * counts and sizes past what a box can hold are refused or cut to what it holds, quickly, and
 * random damage to real files never throws anything but `DemuxError`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Fmp4Demuxer, parseMovie, topLevelBoxes } from '@/lookahead/fmp4';
import { SourceBufferMirror } from '@/lookahead/mirror';
import { DemuxError, type Demuxer } from '@/lookahead/types';
import { WebmDemuxer } from '@/lookahead/webm';

const FIXTURES = new URL('./fixtures/lookahead/', import.meta.url);
const read = (name: string) => new Uint8Array(readFileSync(new URL(name, FIXTURES)));

/** An MP4 box: size, type, then the body parts (numbers are 32-bit big-endian). */
function box(type: string, ...parts: (Uint8Array | number[])[]): Uint8Array {
  const body = parts.map((p) => (p instanceof Uint8Array ? p : u32s(...p)));
  const size = 8 + body.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(new TextEncoder().encode(type), 4);
  let at = 8;
  for (const b of body) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

function u32s(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => {
    view.setUint32(i * 4, v >>> 0);
  });
  return out;
}

/** The init segment of a real fragmented file (its `ftyp` and `moov`). */
function initOf(bytes: Uint8Array): Uint8Array {
  const moov = topLevelBoxes(bytes).find((b) => b.type === 'moov');
  return bytes.subarray(0, (moov?.start ?? 0) + (moov?.size ?? 0));
}

const timed = <T>(f: () => T): { value: T | Error; ms: number } => {
  const start = performance.now();
  let value: T | Error;
  try {
    value = f();
  } catch (err) {
    value = err as Error;
  }
  return { value, ms: performance.now() - start };
};

describe('Fmp4Demuxer limits', () => {
  const init = initOf(read('aac-frag.mp4'));

  it('refuses a trun that claims billions of samples with no per-sample fields', () => {
    for (const count of [10_000_000, 0xffffffff]) {
      const d = new Fmp4Demuxer();
      d.push(init);
      // tfhd: track 1, default duration and size; trun: version/flags 0, the count.
      const moof = box(
        'moof',
        box('traf', box('tfhd', [0x18, 1, 1024, 4]), box('trun', [0, count])),
      );
      const { value, ms } = timed(() => d.push(moof));
      expect(value).toBeInstanceOf(DemuxError);
      expect(ms).toBeLessThan(100);
    }
  });

  it('reads no more trun entries than the box holds', () => {
    const d = new Fmp4Demuxer();
    d.push(init);
    // Sizes per sample (flag 0x200), count 10^7, but room for 2.
    const moof = box(
      'moof',
      box(
        'traf',
        box('tfhd', [0x8, 1, 1024]),
        box('tfdt', [0, 0]),
        box('trun', [0x200, 1e7, 3, 3]),
      ),
    );
    const mdat = box('mdat', [0, 0]);
    const { value, ms } = timed(() => [...d.push(moof), ...d.push(mdat)]);
    expect(ms).toBeLessThan(100);
    const samples = (value as ReturnType<Demuxer['push']>).flatMap((e) =>
      e.type === 'samples' ? e.samples : [],
    );
    expect(samples.length).toBeLessThanOrEqual(2);
  });

  it('refuses a box that claims gigabytes, at its header', () => {
    const d = new Fmp4Demuxer();
    d.push(init);
    const header = u32s(0xfffffff0, 0x6d646174); // "mdat"
    const { value, ms } = timed(() => d.push(header));
    expect(value).toBeInstanceOf(DemuxError);
    expect(ms).toBeLessThan(50);
    // A 64-bit size too.
    const big = new Fmp4Demuxer();
    big.push(init);
    expect(() => big.push(u32s(1, 0x6d6f6f66, 1, 0))).toThrow(DemuxError);
  });

  it('joins a large box once, not on every push', () => {
    const d = new Fmp4Demuxer();
    d.push(init);
    const mdat = new Uint8Array(8 * 1024 * 1024);
    new DataView(mdat.buffer).setUint32(0, mdat.length);
    mdat.set(new TextEncoder().encode('free'), 4);
    const { ms } = timed(() => {
      for (let o = 0; o < mdat.length; o += 1024) d.push(mdat.subarray(o, o + 1024));
    });
    // Copying the growing box on each of 8192 pushes took seconds.
    expect(ms).toBeLessThan(1500);
  });

  it('cuts sample tables to what their boxes hold, and refuses an index too large', () => {
    const bytes = read('aac-progressive.mp4');
    const moovAt = topLevelBoxes(bytes).find((b) => b.type === 'moov');
    const moov = bytes.slice(moovAt?.start, (moovAt?.start ?? 0) + (moovAt?.size ?? 0));
    const view = new DataView(moov.buffer);
    // The audio track's table (the video track comes first).
    const find = (type: string) => {
      for (let i = moov.length - 8; i >= 0; i--) {
        if (new TextDecoder().decode(moov.subarray(i + 4, i + 8)) === type) return i;
      }
      return -1;
    };
    // stco says a billion chunks; stsc a billion per chunk.
    const tampered = moov.slice();
    const tv = new DataView(tampered.buffer);
    tv.setUint32(find('stco') + 12, 1e9);
    tv.setUint32(find('stsc') + 12, 1e9);
    const { value, ms } = timed(() => parseMovie(tampered));
    expect(ms).toBeLessThan(200);
    expect((value as ReturnType<typeof parseMovie>)?.samples.length).toBe(131);
    // stsz: a fixed size for three million samples (348 bytes made 421 MB).
    const stsz = find('stsz');
    view.setUint32(stsz + 12, 4);
    view.setUint32(stsz + 16, 3_000_000);
    expect(timed(() => parseMovie(moov)).value).toBeInstanceOf(DemuxError);
  });
});

describe('WebmDemuxer limits', () => {
  it('refuses a block of its own track that claims a gigabyte', () => {
    const bytes = read('opus.webm');
    const d = new WebmDemuxer();
    // Up to the first cluster (tracks settled).
    const cluster = bytes.findIndex(
      (b, i) =>
        b === 0x1f && bytes[i + 1] === 0x43 && bytes[i + 2] === 0xb6 && bytes[i + 3] === 0x75,
    );
    d.push(bytes.subarray(0, cluster));
    // Cluster (unknown size), Timecode 0, SimpleBlock of 2^30 bytes for track 1.
    const block = [0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
    const timecode = [0xe7, 0x81, 0x00];
    const simple = [0xa3, 0x08, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x81];
    const { value, ms } = timed(() => d.push(Uint8Array.from([...block, ...timecode, ...simple])));
    expect(value).toBeInstanceOf(DemuxError);
    expect(ms).toBeLessThan(50);
  });

  it('looks for the next cluster after a byte no element can start with, keeping nothing', () => {
    const d = new WebmDemuxer();
    const events = d.push(new Uint8Array(4096));
    expect(events.some((e) => e.type === 'warning')).toBe(true);
    // Zeros keep coming: still nothing kept.
    for (let i = 0; i < 100; i++) d.push(new Uint8Array(4096));
    expect((d as unknown as { pending: Uint8Array }).pending.length).toBeLessThan(8);
  });
});

describe('demuxers on damaged files', () => {
  /** Deterministic random numbers. */
  function random(seed: number) {
    let s = seed;
    return (n: number) => {
      s = (s * 1103515245 + 12345) % 2 ** 31;
      return s % n;
    };
  }

  const cases: [string, () => Demuxer][] = [
    ['aac-frag.mp4', () => new Fmp4Demuxer()],
    ['opus-frag.mp4', () => new Fmp4Demuxer()],
    ['opus.webm', () => new WebmDemuxer()],
  ];

  for (const [name, make] of cases) {
    it(`never throws anything but DemuxError, nor hangs: ${name}`, () => {
      const original = read(name);
      const rand = random(name.length);
      const start = performance.now();
      for (let round = 0; round < 150; round++) {
        const bytes = original.slice();
        // Overwrite a few bytes (sizes, counts, flags) with junk or extremes.
        for (let k = 0; k < 1 + rand(8); k++) {
          const at = rand(bytes.length);
          bytes[at] = [0, 0xff, 0x7f, 0x80, rand(256)][rand(5)] as number;
        }
        const d = make();
        const slice = [1, 7, 100, 4096, bytes.length][rand(5)] as number;
        try {
          for (let o = 0; o < bytes.length; o += slice) {
            if (rand(20) === 0) d.resync();
            d.push(bytes.subarray(o, o + slice));
          }
        } catch (err) {
          expect(err, `round ${round}`).toBeInstanceOf(DemuxError);
        }
      }
      expect(performance.now() - start).toBeLessThan(10_000);
    });
  }

  it('reads progressive indexes with damage without throwing other errors', () => {
    const bytes = read('aac-progressive.mp4');
    const moovAt = topLevelBoxes(bytes).find((b) => b.type === 'moov');
    const moov = bytes.slice(moovAt?.start, (moovAt?.start ?? 0) + (moovAt?.size ?? 0));
    const rand = random(3);
    for (let round = 0; round < 300; round++) {
      const m = moov.slice();
      for (let k = 0; k < 1 + rand(6); k++)
        m[rand(m.length)] = [0, 0xff, rand(256)][rand(3)] as number;
      try {
        parseMovie(m);
      } catch (err) {
        expect(err).toBeInstanceOf(DemuxError);
      }
    }
  });
});

describe('SourceBufferMirror and a demuxer that gives up', () => {
  it('reports it once, and reads nothing more from that SourceBuffer', () => {
    const failed: string[] = [];
    let frames = 0;
    const mirror = new SourceBufferMirror('audio/mp4; codecs="mp4a.40.2"', {
      config: () => {},
      frame: () => frames++,
      failed: (m) => failed.push(m),
    });
    const append = (bytes: Uint8Array) =>
      mirror.append({
        bytes,
        timestampOffset: 0,
        appendWindowStart: 0,
        appendWindowEnd: Number.POSITIVE_INFINITY,
        sequence: false,
      });
    append(u32s(0xfffffff0, 0x6d646174));
    expect(failed).toHaveLength(1);
    append(read('aac-frag.mp4'));
    mirror.changeType('audio/mp4; codecs="mp4a.40.2"');
    append(read('aac-frag.mp4'));
    expect(frames).toBe(0);
    expect(failed).toHaveLength(1);
  });
});
