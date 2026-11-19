/**
 * The page-side tee on stand-in MediaSource/SourceBuffer classes: wrappers that look and behave
 * like the built-ins, audio copied and video not, never a throw into the page, the kill switch;
 * and the relay: init segments, what it holds before an overlay attaches, and how it hands it on.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromBase64 } from '@/lookahead/bytes';
import type { TeeEvent, TeeWire } from '@/lookahead/protocol';
import { initSegmentOf, Relay } from '@/lookahead/relay';
import { installTee, type TeeGlobal } from '@/lookahead/tee';

function fakeGlobal() {
  const calls: string[] = [];
  class SourceBuffer {
    timestampOffset = 0;
    appendWindowStart = 0;
    appendWindowEnd = Number.POSITIVE_INFINITY;
    mode = 'segments';
    appendBuffer(data: ArrayBuffer | ArrayBufferView): void {
      calls.push(`append ${(data as ArrayBuffer).byteLength ?? 0}`);
    }
    remove(start: number, end: number): string {
      calls.push(`remove ${start}-${end}`);
      return 'removed';
    }
    abort(): void {
      calls.push('abort');
    }
    changeType(type: string): void {
      calls.push(`changeType ${type}`);
    }
  }
  class MediaSource {
    addSourceBuffer(type: string): SourceBuffer {
      calls.push(`add ${type}`);
      if (type === 'bad') throw new Error('NotSupportedError');
      return new SourceBuffer();
    }
    removeSourceBuffer(_sb: SourceBuffer): void {
      calls.push('removeSourceBuffer');
    }
  }
  const URL = {
    createObjectURL(obj: unknown): string {
      return obj instanceof MediaSource ? 'blob:x/1' : 'blob:x/other';
    },
  };
  return { G: { MediaSource, SourceBuffer, URL } as unknown as TeeGlobal, MediaSource, calls };
}

describe('installTee', () => {
  it('wraps methods so they look like the originals', () => {
    const { G, MediaSource } = fakeGlobal();
    const original = MediaSource.prototype.addSourceBuffer;
    installTee(G, { send: () => {}, idPrefix: 'p-' });
    const wrapped = MediaSource.prototype.addSourceBuffer;
    expect(wrapped).not.toBe(original);
    expect(wrapped.name).toBe('addSourceBuffer');
    expect(wrapped.length).toBe(original.length);
    expect('prototype' in wrapped).toBe(false);
    expect(wrapped.toString()).toBe(Function.prototype.toString.call(original));
  });

  it('copies audio appends with their timing, and only counts video', () => {
    const { G, MediaSource, calls } = fakeGlobal();
    const events: TeeEvent[] = [];
    const tee = installTee(G, { send: (e) => events.push(e), idPrefix: 'p-' });
    const ms = new MediaSource();
    expect((G.URL as { createObjectURL(o: unknown): string }).createObjectURL(ms)).toBe('blob:x/1');
    const audio = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    const video = ms.addSourceBuffer('video/mp4; codecs="avc1.64001f"');
    audio.timestampOffset = 5;
    audio.appendWindowEnd = 30;
    const bytes = new Uint8Array([1, 2, 3, 4]);
    audio.appendBuffer(bytes);
    video.appendBuffer(new Uint8Array(1000));
    expect(audio.remove(1, 2)).toBe('removed');
    audio.abort();
    audio.changeType('audio/webm; codecs="opus"');
    // The page's calls all went through, in order.
    expect(calls).toEqual([
      'add audio/mp4; codecs="mp4a.40.2"',
      'add video/mp4; codecs="avc1.64001f"',
      'append 4',
      'append 1000',
      'remove 1-2',
      'abort',
      'changeType audio/webm; codecs="opus"',
    ]);
    expect(events.map((e) => e.t)).toEqual([
      'url',
      'sb',
      'sb',
      'append',
      'remove',
      'abort',
      'ctype',
    ]);
    const append = events.find((e) => e.t === 'append');
    expect(append).toMatchObject({ tso: 5, aws: 0, awe: 30, sequence: false });
    if (append?.t === 'append') {
      expect([...new Uint8Array(append.bytes)]).toEqual([1, 2, 3, 4]);
      // A copy: the page keeps its own buffer.
      expect(append.bytes).not.toBe(bytes.buffer);
    }
    expect(tee.stats).toMatchObject({ appends: 2, copiedBytes: 4, skippedBytes: 1000 });
  });

  it('never throws into the page, and lets the page see its own errors', () => {
    const { G, MediaSource } = fakeGlobal();
    installTee(G, {
      send: () => {
        throw new Error('broken relay');
      },
      idPrefix: 'p-',
    });
    const ms = new MediaSource();
    const sb = ms.addSourceBuffer('audio/mp4');
    expect(() => sb.appendBuffer(new Uint8Array(2))).not.toThrow();
    expect(() => ms.addSourceBuffer('bad')).toThrow('NotSupportedError');
  });

  it('passes straight through once switched off', () => {
    const { G, MediaSource } = fakeGlobal();
    const events: TeeEvent[] = [];
    const tee = installTee(G, { send: (e) => events.push(e), idPrefix: 'p-' });
    tee.off();
    const sb = new MediaSource().addSourceBuffer('audio/mp4');
    sb.appendBuffer(new Uint8Array(2));
    expect(events).toEqual([]);
  });
});

describe('Relay', () => {
  const read = (name: string) =>
    new Uint8Array(readFileSync(new URL(`./fixtures/lookahead/${name}`, import.meta.url)));

  it('finds the init segment at the start of an append', () => {
    const mp4 = read('aac-frag.mp4');
    const init = initSegmentOf(mp4, 'audio/mp4');
    expect(init?.length).toBeGreaterThan(100);
    expect(init?.length).toBeLessThan(mp4.length);
    const webm = read('opus.webm');
    const webmInit = initSegmentOf(webm, 'audio/webm');
    expect(webmInit?.length).toBeGreaterThan(50);
    expect(initSegmentOf(webm.subarray(webmInit?.length), 'audio/webm')).toBeNull();
  });

  it('holds what the page did until attached, then hands on everything in order', () => {
    const relay = new Relay(undefined, 300);
    relay.onEvent({ t: 'url', url: 'blob:x/1', ms: 'm1' });
    relay.onEvent({ t: 'sb', sb: 's1', ms: 'm1', mime: 'audio/mp4', kind: 'audio' });
    const append = (n: number): TeeEvent => ({
      t: 'append',
      sb: 's1',
      bytes: new Uint8Array(100).fill(n).buffer,
      tso: 0,
      aws: 0,
      awe: null,
      sequence: false,
    });
    for (let n = 1; n <= 5; n++) relay.onEvent(append(n));
    relay.onEvent({ t: 'remove', sb: 's1', start: 0, end: 1 });
    expect(relay.mediaSourceOf('blob:x/1')).toBe('m1');

    const got: TeeWire[] = [];
    const detach = relay.attach((w) => got.push(w));
    // The buffer, then the most recent appends that fit (300 bytes), the first marked resync.
    expect(got.map((w) => w.t)).toEqual(['sb', 'append', 'append', 'append', 'remove']);
    const appends = got.filter((w) => w.t === 'append');
    expect(appends.map((w) => (w.t === 'append' ? fromBase64(w.bytes)[0] : 0))).toEqual([3, 4, 5]);
    expect(appends[0]).toMatchObject({ resync: true });
    expect(appends[1]?.t === 'append' && appends[1].resync).toBeFalsy();
    // Then live.
    relay.onEvent(append(6));
    expect(got.at(-1)?.t).toBe('append');
    detach();
    relay.onEvent(append(7));
    expect(got.length).toBe(6);
  });

  it('drops everything and switches the tee off when lookahead is turned off', () => {
    const relay = new Relay();
    const posted: unknown[] = [];
    relay.ports.push({ postMessage: (m: unknown) => posted.push(m) } as unknown as MessagePort);
    relay.onEvent({ t: 'sb', sb: 's1', ms: 'm1', mime: 'audio/mp4', kind: 'audio' });
    relay.off();
    expect(posted).toEqual([{ t: 'off' }]);
    const got: TeeWire[] = [];
    relay.attach((w) => got.push(w));
    expect(got).toEqual([]);
  });
});
