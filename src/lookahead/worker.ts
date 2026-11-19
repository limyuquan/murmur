/**
 * The tee inside the page's workers, for players that run MSE in a dedicated worker (Twitch).
 * Only on the sites that need it (`workerTeeHost`): the page's `Worker` becomes a Proxy whose
 * `new`, for a classic worker started from a script Blob the page made a URL for (the usual way
 * to run a worker script from a CDN: `importScripts` inside a blob), starts it instead from a
 * new Blob made of
 *
 *   1. a prelude that waits for a private MessagePort (the first message, marked with a random
 *      token; it never reaches the page's own handlers) and installs the tee on the worker's
 *      global from `installTee`'s own source text, reporting each audio SourceBuffer's buffered
 *      ranges (the element plays a `MediaSourceHandle`, so its MediaSource is found by matching
 *      them: relay.ts `mediaSourceFor`),
 *   2. then the page's own Blob, as it is.
 *
 * Nothing is fetched later, so a page that revokes its URL right after `new Worker(url)` loses
 * nothing, and the worker runs under the same CSP as the page's blob worker would (a blob worker
 * inherits the document's). Every other worker is left alone: module workers, http(s) URLs (a
 * blob would bring the page's CSP to a script that had none: WebAssembly or its fetches could
 * fail silently), `data:` URLs, blobs made elsewhere, and every worker after the page's CSP
 * refused a blob worker (a `securitypolicyviolation`), or when making one fails. The worker's
 * events come back over the port and go out with the page's own (ids prefixed per worker). The
 * Proxy keeps `Worker`'s name, prototype, `instanceof` and `constructor`.
 *
 * One difference stays: a `"use strict"` at the very top of the page's script no longer applies to
 * the whole script (the prelude comes first). Bundled worker scripts put it inside functions.
 */
import type { TrackKind } from './kind';
import { TEE_MESSAGE, type TeeEvent } from './protocol';
import type { TeeGlobal, TeeHandle, TeeOptions } from './tee';

export interface WorkerTeeOptions {
  /** The page's id prefix; each worker's ids add `w<n>-`. */
  idPrefix: string;
  send(event: TeeEvent, transfer: ArrayBuffer[]): void;
  /** Run in each worker from its source text. */
  installTee: (G: TeeGlobal, options: TeeOptions) => TeeHandle;
  kindOf: (mime: string) => TrackKind;
}

export interface WorkerTee {
  /** Workers made from now on are plain; those wrapped pass straight through. */
  off(): void;
  /** Workers wrapped so far. */
  readonly wrapped: number;
  /** The page made `url` for `object` (the tee's `URL.createObjectURL` hook tells it). */
  objectUrl(object: unknown, url: string): void;
}

/** Bytes a worker queues before its port arrives, at most. */
const WORKER_QUEUE_BYTES = 8 * 1024 * 1024;
/** Script Blobs remembered by their URL (the latest), and the largest kept. */
const MAX_BLOBS = 8;
const MAX_BLOB_BYTES = 4 * 1024 * 1024;
/** Ports to wrapped workers kept for the kill switch (the latest). */
const MAX_PORTS = 32;
/** Our blob URL is revoked when the worker reports in, or after this long, ms. */
const REVOKE_MS = 30_000;

/** The prelude: the tee, waiting for its port. `token` marks the port message. */
export function workerPrelude(
  options: Pick<WorkerTeeOptions, 'installTee' | 'kindOf'>,
  token: string,
  idPrefix: string,
): string {
  const json = JSON.stringify;
  return `(function () {
  var port = null, queue = [], queued = 0, tee = null;
  var send = function (event, transfer) {
    if (port) { port.postMessage(event, transfer); return; }
    var size = event.t === 'append' ? event.bytes.byteLength : 64;
    if (queued + size > ${WORKER_QUEUE_BYTES}) return;
    queued += size;
    queue.push([event, transfer]);
  };
  self.addEventListener('message', function (e) {
    var d = e.data;
    if (port || !d || d[${json(TEE_MESSAGE)}] !== ${json(token)} || !e.ports[0]) return;
    e.stopImmediatePropagation();
    port = e.ports[0];
    port.onmessage = function (m) { if (m.data && m.data.t === 'off' && tee) tee.off(); };
    port.postMessage({ t: 'up' });
    for (var i = 0; i < queue.length; i++) port.postMessage(queue[i][0], queue[i][1]);
    queue = []; queued = 0;
  });
  try {
    tee = (${options.installTee.toString()})(self, {
      idPrefix: ${json(idPrefix)},
      kindOf: ${options.kindOf.toString()},
      reportBuffered: true,
      send: send
    });
  } catch (e) {}
})();
`;
}

type WorkerClass = new (url: string | URL, options?: WorkerOptions) => Worker;

/** A Blob that may hold a classic worker script. */
function scriptBlob(object: unknown): object is Blob {
  if (typeof Blob !== 'function' || !(object instanceof Blob)) return false;
  if (object.size > MAX_BLOB_BYTES) return false;
  const type = object.type.toLowerCase();
  return type === '' || /javascript|ecmascript|text\/plain/.test(type);
}

export function wrapWorkers(
  win: Window & typeof globalThis,
  options: WorkerTeeOptions,
): WorkerTee | null {
  const Original = win.Worker as WorkerClass | undefined;
  if (typeof Original !== 'function') return null;
  const postMessage = Original.prototype.postMessage;
  const createObjectURL = win.URL.createObjectURL.bind(win.URL);
  const revokeObjectURL = win.URL.revokeObjectURL?.bind(win.URL);
  const ports: MessagePort[] = [];
  const blobs = new Map<string, Blob>();
  let killed = false;
  let refused = false;
  /** Making our own blob URL (the tee's hook reports it too). */
  let making = false;
  let count = 0;
  const random = new Uint32Array(2);

  try {
    win.document?.addEventListener(
      'securitypolicyviolation',
      (e) => {
        if (
          /^blob/.test(e.blockedURI) &&
          /worker|script|child|default/.test(e.effectiveDirective)
        ) {
          refused = true;
        }
      },
      { capture: true, passive: true },
    );
  } catch {}

  const wrap = (args: unknown[], newTarget: WorkerClass): Worker | null => {
    const init = args[1] as WorkerOptions | undefined;
    if (killed || refused || init?.type === 'module') return null;
    const base = win.document?.baseURI ?? win.location.href;
    const url = new URL(String(args[0]), base).href;
    // Only a Blob the page made a URL for: read now, in one piece with the prelude.
    const script = url.startsWith('blob:') ? blobs.get(url) : undefined;
    if (!script) return null;
    win.crypto.getRandomValues(random);
    const token = `${(random[0] ?? 0).toString(36)}${(random[1] ?? 0).toString(36)}`;
    const prefix = `${options.idPrefix}w${count + 1}-`;
    const source = new Blob([workerPrelude(options, token, prefix), '\n;\n', script], {
      type: 'text/javascript',
    });
    making = true;
    let blobUrl: string;
    try {
      blobUrl = createObjectURL(source);
    } finally {
      making = false;
    }
    let worker: Worker;
    try {
      worker = Reflect.construct(Original, [blobUrl, ...args.slice(1)], newTarget) as Worker;
    } catch (err) {
      revokeObjectURL?.(blobUrl);
      throw err;
    }
    count++;
    let revoked = false;
    const revoke = () => {
      if (revoked) return;
      revoked = true;
      clearTimeout(timer);
      revokeObjectURL?.(blobUrl);
    };
    const timer = setTimeout(revoke, REVOKE_MS);
    const channel = new MessageChannel();
    channel.port1.onmessage = (e: MessageEvent) => {
      const event = e.data as TeeEvent | { t: 'up' };
      if (!event || typeof event !== 'object') return;
      if (event.t === 'up') {
        revoke();
        return;
      }
      if (killed) return;
      options.send(
        event,
        event.t === 'append' && event.bytes instanceof ArrayBuffer ? [event.bytes] : [],
      );
    };
    ports.push(channel.port1);
    if (ports.length > MAX_PORTS) ports.shift();
    postMessage.call(worker, { [TEE_MESSAGE]: token }, [channel.port2]);
    return worker;
  };

  const proxy = new Proxy(Original, {
    construct(target, args, newTarget) {
      try {
        const worker = wrap(args, newTarget as WorkerClass);
        if (worker) return worker;
      } catch {
        // Never into the page: it gets the worker it asked for.
      }
      return Reflect.construct(target, args, newTarget);
    },
  }) as typeof win.Worker;
  win.Worker = proxy;
  // So a worker's `constructor` is the global `Worker`, as without the Proxy.
  try {
    const descriptor = Object.getOwnPropertyDescriptor(Original.prototype, 'constructor');
    if (descriptor)
      Object.defineProperty(Original.prototype, 'constructor', { ...descriptor, value: proxy });
  } catch {}

  return {
    off() {
      killed = true;
      blobs.clear();
      for (const port of ports) {
        try {
          port.postMessage({ t: 'off' });
        } catch {}
      }
    },
    get wrapped() {
      return count;
    },
    objectUrl(object, url) {
      if (killed || making || !scriptBlob(object)) return;
      blobs.delete(url);
      blobs.set(url, object);
      if (blobs.size > MAX_BLOBS) blobs.delete(blobs.keys().next().value as string);
    },
  };
}
