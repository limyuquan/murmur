/**
 * MSE in workers (Twitch): the tee runs from its own source text in a worker, the page's Worker
 * is wrapped only where asked, the worker's events come back over a private port, and the relay
 * finds the element's MediaSource by buffered ranges. Also the site entries and live streams.
 */
import { describe, expect, it } from 'vitest';
import { kindOf } from '@/lookahead/kind';
import type { TeeEvent } from '@/lookahead/protocol';
import { Relay } from '@/lookahead/relay';
import {
  BILIBILI,
  lookaheadSiteFor,
  type TimelineVideo,
  TWITCH,
  videoTimeline,
  workerTeeHost,
} from '@/lookahead/sites';
import { installTee, type TeeGlobal } from '@/lookahead/tee';
import { workerPrelude, wrapWorkers } from '@/lookahead/worker';

/** A worker-like global with stand-in MediaSource classes (SourceBuffers fire `updateend`). */
function fakeWorkerGlobal() {
  class SourceBuffer extends EventTarget {
    timestampOffset = 0;
    appendWindowStart = 0;
    appendWindowEnd = Number.POSITIVE_INFINITY;
    mode = 'segments';
    ranges: [number, number][] = [];
    get buffered() {
      const r = this.ranges;
      return { length: r.length, start: (i: number) => r[i]?.[0], end: (i: number) => r[i]?.[1] };
    }
    appendBuffer(_data: ArrayBuffer | ArrayBufferView): void {
      this.ranges = [[0, (this.ranges[0]?.[1] ?? 0) + 2]];
      this.dispatchEvent(new Event('updateend'));
    }
  }
  class MediaSource {
    addSourceBuffer(_type: string): SourceBuffer {
      return new SourceBuffer();
    }
  }
  const self = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(self, { MediaSource, SourceBuffer, performance });
  return { self, MediaSource };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe('the tee in a worker', () => {
  it('runs from its own source text, with no outside references', () => {
    const install = new Function(`return (${installTee.toString()})`)() as typeof installTee;
    const kind = new Function(`return (${kindOf.toString()})`)() as typeof kindOf;
    const { self, MediaSource } = fakeWorkerGlobal();
    const events: TeeEvent[] = [];
    install(self as unknown as TeeGlobal, {
      idPrefix: 'w1-',
      kindOf: kind,
      reportBuffered: true,
      send: (e) => events.push(e),
    });
    const ms = new MediaSource();
    const audio = ms.addSourceBuffer('video/mp4;codecs="mp4a.40.2"');
    const video = ms.addSourceBuffer('video/mp4;codecs="avc1.64001f"');
    audio.appendBuffer(new Uint8Array([1, 2, 3]));
    video.appendBuffer(new Uint8Array(10));
    expect(events.map((e) => e.t)).toEqual(['sb', 'sb', 'append', 'buffered']);
    expect(events[0]).toMatchObject({ kind: 'audio', sb: 'w1-s1' });
    expect(events.at(-1)).toEqual({ t: 'buffered', sb: 'w1-s1', ranges: [[0, 2]] });
  });

  it('installs from the prelude, sends over the port it is given, then runs the script', async () => {
    const { self, MediaSource } = fakeWorkerGlobal();
    const imported: string[] = [];
    const source = workerPrelude(
      { installTee, kindOf },
      'tok',
      'p-w1-',
      'https://example.com/w.js',
    );
    new Function('self', 'importScripts', source)(self, (url: string) => imported.push(url));
    expect(imported).toEqual(['https://example.com/w.js']);
    // The page's own handler never sees the port message.
    const pageSaw: unknown[] = [];
    self.addEventListener('message', (e) => pageSaw.push((e as MessageEvent).data));
    // Before the port: queued.
    const sb = new MediaSource().addSourceBuffer('audio/mp4');
    sb.appendBuffer(new Uint8Array([7, 7]));
    const channel = new MessageChannel();
    const got: TeeEvent[] = [];
    channel.port1.onmessage = (e) => got.push(e.data as TeeEvent);
    self.dispatchEvent(new MessageEvent('message', { data: { __murmurTee: 'nope' } }));
    self.dispatchEvent(
      new MessageEvent('message', { data: { __murmurTee: 'tok' }, ports: [channel.port2] }),
    );
    sb.appendBuffer(new Uint8Array([8]));
    await settle();
    expect(pageSaw).toEqual([{ __murmurTee: 'nope' }]);
    expect(got.map((e) => e.t)).toEqual(['sb', 'append', 'buffered', 'append', 'buffered']);
    expect(got[0]).toMatchObject({ sb: 'p-w1-s1' });
    // The kill switch reaches the worker's tee.
    channel.port1.postMessage({ t: 'off' });
    await settle();
    sb.appendBuffer(new Uint8Array([9]));
    await settle();
    expect(got).toHaveLength(5);
    channel.port1.close();
  });
});

/** A window with a stand-in Worker that records how it was made. */
function fakeWindow() {
  const made: { url: string; options?: WorkerOptions; posted: unknown[] }[] = [];
  class Worker {
    posted: unknown[] = [];
    constructor(url: string | URL, options?: WorkerOptions) {
      made.push({ url: String(url), ...(options ? { options } : {}), posted: this.posted });
    }
    postMessage(message: unknown, _transfer?: Transferable[]): void {
      this.posted.push(message);
    }
  }
  const document = new EventTarget() as EventTarget & { baseURI: string };
  document.baseURI = 'https://www.example.com/videos/1';
  const blobs: string[] = [];
  const win = {
    Worker,
    document,
    location: { href: 'https://www.example.com/videos/1' },
    crypto: globalThis.crypto,
    URL: {
      createObjectURL(blob: Blob) {
        blobs.push(String(blob.size));
        return `blob:https://www.example.com/${blobs.length}`;
      },
    },
  };
  return { win: win as unknown as Window & typeof globalThis, Worker, made, document };
}

describe('wrapWorkers', () => {
  it('starts classic workers from the prelude, and leaves module workers alone', () => {
    const { win, Worker: Original, made } = fakeWindow();
    const sent: TeeEvent[] = [];
    const tee = wrapWorkers(win, {
      idPrefix: 'p-',
      send: (e) => sent.push(e),
      installTee,
      kindOf,
    });
    const W = win.Worker;
    expect(W).not.toBe(Original);
    expect(W.name).toBe('Worker');
    const worker = new W('/player/worker.js');
    expect(worker).toBeInstanceOf(Original);
    expect(made[0]?.url).toBe('blob:https://www.example.com/1');
    expect(made[0]?.posted[0]).toMatchObject({ __murmurTee: expect.any(String) });
    new W('module.js', { type: 'module' });
    expect(made[1]).toMatchObject({ url: 'module.js', options: { type: 'module' } });
    expect(tee?.wrapped).toBe(1);
    tee?.off();
    new W('later.js');
    expect(made[2]?.url).toBe('later.js');
  });

  it('stops wrapping once the page refuses a blob worker', () => {
    const { win, made, document } = fakeWindow();
    wrapWorkers(win, { idPrefix: 'p-', send: () => {}, installTee, kindOf });
    const violation = Object.assign(new Event('securitypolicyviolation'), {
      blockedURI: 'blob',
      effectiveDirective: 'worker-src',
    });
    document.dispatchEvent(violation);
    new win.Worker('a.js');
    expect(made[0]?.url).toBe('a.js');
  });

  it('only on the sites that need it', () => {
    expect(workerTeeHost('www.twitch.tv')).toBe(true);
    expect(workerTeeHost('player.twitch.tv')).toBe(true);
    expect(workerTeeHost('www.youtube.com')).toBe(false);
    expect(workerTeeHost('www.bilibili.com')).toBe(false);
    expect(workerTeeHost('example.com', '?murmur-worker-tee')).toBe(false);
  });
});

describe('Relay.mediaSourceFor', () => {
  it('picks the worker MediaSource whose audio is buffered where the element’s is', () => {
    const relay = new Relay();
    relay.onEvent({ t: 'sb', sb: 'a', ms: 'preroll', mime: 'audio/mp4', kind: 'audio' });
    relay.onEvent({ t: 'sb', sb: 'b', ms: 'content', mime: 'audio/mp4', kind: 'audio' });
    expect(relay.mediaSourceFor([], 0)).toBeNull();
    relay.onEvent({ t: 'buffered', sb: 'b', ranges: [[1190, 1230]] });
    relay.onEvent({ t: 'buffered', sb: 'a', ranges: [[0, 15]] });
    expect(relay.mediaSourceFor([[1195, 1225]], 1200)).toBe('content');
    expect(relay.mediaSourceFor([[0, 12]], 3)).toBe('preroll');
    // Nothing buffered on the element yet: the playhead decides, else the latest.
    expect(relay.mediaSourceFor([], 1200)).toBe('content');
    expect(relay.mediaSourceFor([], 500)).toBe('preroll');
  });
});

function video(options: Partial<TimelineVideo> & { ranges?: [number, number][] }): TimelineVideo {
  const ranges = options.ranges ?? [];
  const el = {
    currentSrc: '',
    src: '',
    srcObject: null,
    duration: 100,
    currentTime: 0,
    buffered: {
      length: ranges.length,
      start: (i: number) => ranges[i]?.[0] ?? 0,
      end: (i: number) => ranges[i]?.[1] ?? 0,
    },
    closest: () => null,
    ownerDocument: { querySelector: () => null },
    ...options,
  };
  return el as unknown as TimelineVideo;
}

const lookup = {
  byUrl: (url: string) => (url === 'blob:x/1' ? 'm1' : null),
  byBuffered: () => 'w1',
};
const loc = (pathname: string, search = '') => ({ pathname, search });

describe('sites', () => {
  it('knows Twitch VODs, and leaves its live channels to the live path', () => {
    expect(lookaheadSiteFor('www.twitch.tv')).toBe(TWITCH);
    expect(TWITCH.contentKey(loc('/videos/2012345678'))).toBe('twitch:v2012345678');
    expect(TWITCH.contentKey(loc('/', '?video=v2012345678&parent=example.com'))).toBe(
      'twitch:v2012345678',
    );
    expect(TWITCH.isLive?.(loc('/somechannel'))).toBe(true);
    expect(TWITCH.isLive?.(loc('/videos/2012345678'))).toBe(false);
    const handle = new (class MediaSourceHandle {})();
    const vod = video({ srcObject: handle, ranges: [[0, 30]] });
    expect(videoTimeline(vod, lookup, TWITCH, loc('/videos/1'))).toEqual({
      timeline: 'w1',
      key: 'twitch:v1',
      ad: false,
    });
    expect(videoTimeline(vod, lookup, TWITCH, loc('/somechannel'))).toBeNull();
  });

  it('knows Bilibili videos and their parts', () => {
    expect(lookaheadSiteFor('www.bilibili.com')).toBe(BILIBILI);
    expect(BILIBILI.contentKey(loc('/video/BV1xx411c7mD/'))).toBe('bilibili:BV1xx411c7mD:p1');
    expect(BILIBILI.contentKey(loc('/video/BV1xx411c7mD', '?p=3&t=10'))).toBe(
      'bilibili:BV1xx411c7mD:p3',
    );
    expect(BILIBILI.contentKey(loc('/bangumi/play/ep123456'))).toBe('bilibili:ep123456');
    expect(BILIBILI.contentKey(loc('/'))).toBeNull();
  });

  it('never follows a live stream, nor a camera', () => {
    const live = video({ currentSrc: 'blob:x/1', duration: Number.POSITIVE_INFINITY });
    expect(videoTimeline(live, lookup, null, loc('/'))).toBeNull();
    const vod = video({ currentSrc: 'blob:x/1' });
    expect(videoTimeline(vod, lookup, null, loc('/'))).toEqual({
      timeline: 'm1',
      key: 'm1',
      ad: false,
    });
    const camera = video({ srcObject: new (class MediaStream {})() });
    expect(videoTimeline(camera, lookup, null, loc('/'))).toBeNull();
  });
});
