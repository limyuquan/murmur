import { describe, expect, it } from 'vitest';
import { matchesHash, Sha256 } from '@/models/digest';

const hex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');

async function* chunks(data: Uint8Array, sizes: number[]): AsyncIterable<Uint8Array> {
  let at = 0;
  for (let i = 0; at < data.length; i++) {
    const n = sizes[i % sizes.length] as number;
    yield data.subarray(at, at + n);
    at += n;
  }
}

describe('Sha256', () => {
  it('matches the known values', () => {
    const of = (text: string) => {
      const sha = new Sha256();
      sha.update(new TextEncoder().encode(text));
      return sha.hex();
    };
    expect(of('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(of('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('matches Web Crypto on data fed in uneven pieces', async () => {
    for (const size of [55, 56, 63, 64, 65, 127, 128, 1000, 70_001]) {
      const data = Uint8Array.from({ length: size }, (_, i) => (i * 31 + size) % 256);
      const sha = new Sha256();
      for await (const c of chunks(data, [1, 7, 64, 3, 129])) sha.update(c);
      expect(sha.hex()).toBe(hex(await crypto.subtle.digest('SHA-256', data)));
    }
  });
});

describe('matchesHash', () => {
  const data = new TextEncoder().encode('{"a": 1}\n');

  it('checks a Git LFS file by its sha256, and a Git file by its blob id', async () => {
    const sha = hex(await crypto.subtle.digest('SHA-256', data));
    expect(await matchesHash(`sha256:${sha}`, data.length, () => chunks(data, [4]))).toBe(true);
    expect(
      await matchesHash(`sha256:${'0'.repeat(64)}`, data.length, () => chunks(data, [4])),
    ).toBe(false);
    // `git hash-object` of the same bytes.
    const blob = new Uint8Array([...new TextEncoder().encode(`blob ${data.length}\0`), ...data]);
    const oid = hex(await crypto.subtle.digest('SHA-1', blob));
    expect(await matchesHash(`git-sha1:${oid}`, data.length, () => chunks(data, [3]))).toBe(true);
    expect(
      await matchesHash(`git-sha1:${'0'.repeat(40)}`, data.length, () => chunks(data, [3])),
    ).toBe(false);
  });
});
