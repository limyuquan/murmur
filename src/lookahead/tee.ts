/**
 * The tee: runs in the page's own world (MAIN), from `document_start`, on sites where lookahead
 * is on. It watches what the page's player does to its MediaSource and SourceBuffers and copies
 * the audio bytes it appends, so Murmur can decode the audio ahead of the playhead.
 *
 * Rules, because this runs inside other people's players:
 * - Every wrapper calls the original unconditionally (for `appendBuffer` and the other void
 *   methods, last) and returns what it returns; Murmur's own work is in try/catch and never
 *   throws into the page.
 * - Wrappers keep the original's `name`, `length` and `toString()`, and have no `prototype`, like
 *   the built-in methods they replace.
 * - Only audio is copied (by codec, then MIME type): video SourceBuffers are only counted. A copy
 *   is one `slice()` of the appended bytes, handed over without another copy (transfer).
 * - `timestampOffset`, the append window and `mode` are read at each append, so the setters are
 *   left alone.
 * - The kill switch (`off()`) makes every wrapper a plain pass-through.
 *
 * Players that run MSE in a dedicated worker (Twitch: the element plays a `MediaSourceHandle`)
 * get the same tee inside each worker, on the sites that need it only (`workerTeeHost`): the
 * page's `Worker` is wrapped so a classic worker starts from a blob that installs the tee and
 * then `importScripts` the original (worker.ts). `installTee` is written to run there from its
 * own source text: everything it uses is inside it or passed in.
 */
import { kindOf, type TrackKind } from './kind';
import { TEE_MESSAGE, type TeeEvent } from './protocol';
import { workerTeeHost } from './sites';
import { wrapWorkers } from './worker';

export interface TeeOptions {
  send(event: TeeEvent, transfer: ArrayBuffer[]): void;
  /** Prefix for MediaSource and SourceBuffer ids (unique per document). */
  idPrefix: string;
  /** What a SourceBuffer carries, from its MIME type (kind.ts; self-contained too). */
  kindOf(mime: string): TrackKind;
  /**
   * Report each audio SourceBuffer's buffered ranges after every update (`buffered` events): in a
   * worker, where the element's MediaSource is found by matching them.
   */
  reportBuffered?: boolean;
  /** Every object URL the page makes (the worker tee keeps script Blobs by their URL). */
  onObjectUrl?(object: unknown, url: string): void;
}

export interface TeeHandle {
  /** Pass straight through from now on. */
  off(): void;
  readonly stats: { appends: number; copiedBytes: number; skippedBytes: number; hookMs: number };
}

/** The globals the tee hooks (a window, or a dedicated worker's global). */
export interface TeeGlobal {
  MediaSource?: { prototype: object };
  SourceBuffer?: { prototype: object };
  URL?: { createObjectURL?: unknown };
  performance?: { now(): number };
}

/**
 * Installs the tee on `G`. Self-contained (a worker runs it from its source text): no reference to
 * anything outside the function but its arguments and built-ins.
 */
export function installTee(G: TeeGlobal, options: TeeOptions): TeeHandle {
  type Method = (this: unknown, ...args: unknown[]) => unknown;
  /**
   * Replaces `target[name]` with `hook`, which gets the original. The replacement looks like the
   * built-in: same name and length, no prototype, and `toString()` gives the original's source.
   */
  const wrapMethod = (
    target: object,
    name: string,
    hook: (original: Method) => (self: unknown, args: unknown[]) => unknown,
  ): boolean => {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    const original = descriptor?.value as Method | undefined;
    if (typeof original !== 'function') return false;
    const body = hook(original);
    const wrapper = {
      [name](this: unknown, ...args: unknown[]): unknown {
        return body(this, args);
      },
    }[name] as Method;
    Object.defineProperty(wrapper, 'length', { value: original.length });
    const source = Function.prototype.toString.call(original);
    Object.defineProperty(wrapper, 'toString', {
      value: {
        toString(): string {
          return source;
        },
      }.toString,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(target, name, { ...descriptor, value: wrapper });
    return true;
  };
  const bytesOf = (data: unknown): Uint8Array | null => {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data))
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
  };
  const rangesOf = (ranges: TimeRanges): [number, number][] => {
    const out: [number, number][] = [];
    for (let i = 0; i < ranges.length && i < 32; i++) out.push([ranges.start(i), ranges.end(i)]);
    return out;
  };
  const kindOf = options.kindOf;
  const stats = { appends: 0, copiedBytes: 0, skippedBytes: 0, hookMs: 0 };
  let killed = false;
  const handle: TeeHandle = {
    off: () => {
      killed = true;
    },
    stats,
  };
  const MS = G.MediaSource?.prototype;
  const SB = G.SourceBuffer?.prototype;
  if (!MS || !SB) return handle;
  const clock = () => G.performance?.now() ?? 0;
  const send = (event: TeeEvent, transfer: ArrayBuffer[] = []) => {
    try {
      options.send(event, transfer);
    } catch {
      // Never into the page.
    }
  };

  const sourceIds = new WeakMap<object, string>();
  const buffers = new WeakMap<object, { id: string; kind: ReturnType<typeof kindOf> }>();
  let seq = 0;
  const sourceId = (ms: object): string => {
    let id = sourceIds.get(ms);
    if (!id) {
      id = `${options.idPrefix}m${++seq}`;
      sourceIds.set(ms, id);
    }
    return id;
  };

  wrapMethod(MS, 'addSourceBuffer', (original) => (self, args) => {
    const sb = original.apply(self, args);
    if (!killed) {
      try {
        const mime = String(args[0]);
        const id = `${options.idPrefix}s${++seq}`;
        const kind = kindOf(mime);
        const info = { id, kind };
        buffers.set(sb as object, info);
        send({ t: 'sb', sb: id, ms: sourceId(self as object), mime: mime.slice(0, 256), kind });
        if (options.reportBuffered) {
          const target = sb as EventTarget & { buffered: TimeRanges };
          target.addEventListener('updateend', () => {
            if (killed || info.kind === 'video') return;
            try {
              send({ t: 'buffered', sb: id, ranges: rangesOf(target.buffered) });
            } catch {}
          });
        }
      } catch {}
    }
    return sb;
  });

  // The original runs first in each wrapper below: an exception it throws reaches the page
  // unchanged, and then nothing is reported (the call didn't happen).
  wrapMethod(MS, 'removeSourceBuffer', (original) => (self, args) => {
    const out = original.apply(self, args);
    if (!killed) {
      try {
        const info = buffers.get(args[0] as object);
        if (info) send({ t: 'sbrm', sb: info.id });
      } catch {}
    }
    return out;
  });

  wrapMethod(SB, 'appendBuffer', (original) => (self, args) => {
    // `appendBuffer` copies the data before it returns, so the bytes are still as appended (a
    // QuotaExceededError, which players answer by appending again, copies nothing).
    const out = original.apply(self, args);
    if (!killed) {
      const t0 = clock();
      try {
        const info = buffers.get(self as object);
        const bytes = info ? bytesOf(args[0]) : null;
        if (info && bytes) {
          stats.appends++;
          if (info.kind === 'video') {
            stats.skippedBytes += bytes.byteLength;
          } else {
            const sb = self as {
              timestampOffset: number;
              appendWindowStart: number;
              appendWindowEnd: number;
              mode: string;
            };
            const copy = bytes.slice();
            stats.copiedBytes += copy.byteLength;
            const awe = sb.appendWindowEnd;
            send(
              {
                t: 'append',
                sb: info.id,
                bytes: copy.buffer,
                tso: sb.timestampOffset,
                aws: sb.appendWindowStart,
                awe: Number.isFinite(awe) ? awe : null,
                sequence: sb.mode === 'sequence',
              },
              [copy.buffer],
            );
          }
        }
      } catch {}
      stats.hookMs += clock() - t0;
    }
    return out;
  });

  wrapMethod(SB, 'remove', (original) => (self, args) => {
    const out = original.apply(self, args);
    if (!killed) {
      try {
        const info = buffers.get(self as object);
        if (info && info.kind !== 'video') {
          const end = Number(args[1]);
          // `Infinity` doesn't survive JSON on the way to the offscreen document: null.
          send({
            t: 'remove',
            sb: info.id,
            start: Number(args[0]),
            end: Number.isFinite(end) ? end : null,
          });
        }
      } catch {}
    }
    return out;
  });

  wrapMethod(SB, 'abort', (original) => (self, args) => {
    const out = original.apply(self, args);
    if (!killed) {
      try {
        const info = buffers.get(self as object);
        if (info && info.kind !== 'video') send({ t: 'abort', sb: info.id });
      } catch {}
    }
    return out;
  });

  wrapMethod(SB, 'changeType', (original) => (self, args) => {
    const out = original.apply(self, args);
    if (!killed) {
      try {
        const info = buffers.get(self as object);
        if (info) {
          const mime = String(args[0]);
          info.kind = kindOf(mime);
          send({ t: 'ctype', sb: info.id, mime: mime.slice(0, 256), kind: info.kind });
        }
      } catch {}
    }
    return out;
  });

  const url = G.URL;
  if (url) {
    wrapMethod(url, 'createObjectURL', (original) => (self, args) => {
      const out = original.apply(self, args);
      if (!killed) {
        try {
          const MediaSourceClass = G.MediaSource as unknown as new () => object;
          if (args[0] instanceof MediaSourceClass && typeof out === 'string') {
            send({ t: 'url', url: out, ms: sourceId(args[0] as object) });
          } else if (typeof out === 'string') {
            options.onObjectUrl?.(args[0], out);
          }
        } catch {}
      }
      return out;
    });
  }
  return handle;
}

/**
 * The page side: installs the tee on `window` (and in its workers, where needed) and sends its
 * events to the relay over a MessagePort the relay hands over (queued until then).
 */
export function startPageTee(win: Window & typeof globalThis): void {
  // Once per document. The check goes through the wrapper itself (only ours has its own
  // `toString`), so nothing new is left on the page's globals.
  try {
    const append = Object.getOwnPropertyDescriptor(
      win.SourceBuffer?.prototype ?? {},
      'appendBuffer',
    )?.value as unknown;
    if (typeof append === 'function' && Object.hasOwn(append, 'toString')) return;
  } catch {}

  const queue: [TeeEvent, ArrayBuffer[]][] = [];
  let queued = 0;
  let port: MessagePort | null = null;
  const random = new Uint32Array(1);
  win.crypto.getRandomValues(random);
  const prefix = `${(random[0] ?? 0).toString(36)}-`;
  const send = (event: TeeEvent, transfer: ArrayBuffer[]): void => {
    if (port) {
      port.postMessage(event, transfer);
      return;
    }
    // Until the relay is there (moments): a bounded queue.
    const size = event.t === 'append' ? event.bytes.byteLength : 64;
    if (queued + size > 8 * 1024 * 1024) return;
    queued += size;
    queue.push([event, transfer]);
  };
  let workers: ReturnType<typeof wrapWorkers> = null;
  const tee = installTee(win as unknown as TeeGlobal, {
    idPrefix: prefix,
    kindOf,
    send,
    onObjectUrl: (object, url) => workers?.objectUrl(object, url),
  });
  // MSE in workers, on the sites that need it.
  workers = workerTeeHost(win.location.hostname, win.location.search)
    ? wrapWorkers(win, { idPrefix: prefix, send, installTee, kindOf })
    : null;
  const off = (): void => {
    tee.off();
    workers?.off();
  };

  win.addEventListener(
    'message',
    (e: MessageEvent) => {
      const data = e.data as { [TEE_MESSAGE]?: string } | null;
      if (e.source !== win || !data || data[TEE_MESSAGE] !== 'port') return;
      // Every offer stops here, taken or not: the page's own handlers never see one.
      e.stopImmediatePropagation();
      const given = e.ports[0];
      if (port || !given) {
        given?.close();
        return;
      }
      port = given;
      port.onmessage = (m: MessageEvent) => {
        if ((m.data as { t?: string } | null)?.t === 'off') off();
      };
      // So the relay makes no second offer.
      port.postMessage({ t: 'ack' });
      for (const [event, transfer] of queue.splice(0)) port.postMessage(event, transfer);
      queued = 0;
    },
    true,
  );
  // In case the relay ran first and its offer went by.
  win.postMessage({ [TEE_MESSAGE]: 'hello' }, '*');
}
