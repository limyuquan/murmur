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
 * Players that run MSE in a worker (MediaSourceHandle) need the same tee inside the worker: this
 * function takes the global to install on, so a worker wrapper can call it there (not done yet).
 */
import { kindOf, type TrackKind } from './kind';
import { TEE_MESSAGE, type TeeEvent } from './protocol';

export interface TeeOptions {
  send(event: TeeEvent, transfer: ArrayBuffer[]): void;
  /** Prefix for MediaSource and SourceBuffer ids (unique per document). */
  idPrefix: string;
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

type Method = (this: unknown, ...args: unknown[]) => unknown;

/**
 * Replaces `target[name]` with `hook`, which gets the original. The replacement looks like the
 * built-in: same name and length, no prototype, and `toString()` gives the original's source.
 */
export function wrapMethod(
  target: object,
  name: string,
  hook: (original: Method) => (self: unknown, args: unknown[]) => unknown,
): boolean {
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
}

function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export function installTee(G: TeeGlobal, options: TeeOptions): TeeHandle {
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
  const buffers = new WeakMap<object, { id: string; kind: TrackKind }>();
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
        buffers.set(sb as object, { id, kind });
        send({ t: 'sb', sb: id, ms: sourceId(self as object), mime: mime.slice(0, 256), kind });
      } catch {}
    }
    return sb;
  });

  wrapMethod(MS, 'removeSourceBuffer', (original) => (self, args) => {
    if (!killed) {
      try {
        const info = buffers.get(args[0] as object);
        if (info) send({ t: 'sbrm', sb: info.id });
      } catch {}
    }
    return original.apply(self, args);
  });

  wrapMethod(SB, 'appendBuffer', (original) => (self, args) => {
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
    return original.apply(self, args);
  });

  wrapMethod(SB, 'remove', (original) => (self, args) => {
    if (!killed) {
      try {
        const info = buffers.get(self as object);
        if (info && info.kind !== 'video') {
          send({ t: 'remove', sb: info.id, start: Number(args[0]), end: Number(args[1]) });
        }
      } catch {}
    }
    return original.apply(self, args);
  });

  wrapMethod(SB, 'abort', (original) => (self, args) => {
    if (!killed) {
      try {
        const info = buffers.get(self as object);
        if (info && info.kind !== 'video') send({ t: 'abort', sb: info.id });
      } catch {}
    }
    return original.apply(self, args);
  });

  wrapMethod(SB, 'changeType', (original) => (self, args) => {
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
    return original.apply(self, args);
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
          }
        } catch {}
      }
      return out;
    });
  }
  return handle;
}

/**
 * The page side: installs the tee on `window` and sends its events to the relay over a
 * MessagePort the relay hands over (queued until then).
 */
export function startPageTee(win: Window & typeof globalThis): void {
  const flag = Symbol.for('murmur.tee');
  const w = win as unknown as Record<symbol, boolean>;
  if (w[flag]) return;
  Object.defineProperty(win, flag, { value: true });

  const queue: [TeeEvent, ArrayBuffer[]][] = [];
  let queued = 0;
  let port: MessagePort | null = null;
  const random = new Uint32Array(1);
  win.crypto.getRandomValues(random);
  const tee = installTee(win as unknown as TeeGlobal, {
    idPrefix: `${(random[0] ?? 0).toString(36)}-`,
    send(event, transfer) {
      if (port) {
        port.postMessage(event, transfer);
        return;
      }
      // Until the relay is there (moments): a bounded queue.
      const size = event.t === 'append' ? event.bytes.byteLength : 64;
      if (queued + size > 8 * 1024 * 1024) return;
      queued += size;
      queue.push([event, transfer]);
    },
  });

  win.addEventListener(
    'message',
    (e: MessageEvent) => {
      const data = e.data as { [TEE_MESSAGE]?: string } | null;
      if (e.source !== win || !data || data[TEE_MESSAGE] !== 'port' || port) return;
      const given = e.ports[0];
      if (!given) return;
      e.stopImmediatePropagation();
      port = given;
      port.onmessage = (m: MessageEvent) => {
        if ((m.data as { t?: string } | null)?.t === 'off') tee.off();
      };
      for (const [event, transfer] of queue.splice(0)) port.postMessage(event, transfer);
      queued = 0;
    },
    true,
  );
  // In case the relay ran first and its offer went by.
  win.postMessage({ [TEE_MESSAGE]: 'hello' }, '*');
}
