/**
 * The tee inside the page's workers, for players that run MSE in a dedicated worker (Twitch).
 * Only on the sites that need it (`workerTeeHost`): the page's `Worker` becomes a Proxy whose
 * `new` starts a classic worker from a blob that
 *
 *   1. waits for a private MessagePort (the first message, marked with a random token; it never
 *      reaches the page's own handlers),
 *   2. installs the tee on the worker's global from `installTee`'s own source text, reporting
 *      each audio SourceBuffer's buffered ranges (the element plays a `MediaSourceHandle`, so its
 *      MediaSource is found by matching them: relay.ts `mediaSourceFor`),
 *   3. `importScripts` the original script by its absolute URL.
 *
 * The worker's events come back over the port and go out with the page's own (ids prefixed per
 * worker). Module workers are left alone, as is every worker after the page's CSP refused a blob
 * worker (a `securitypolicyviolation`), or when making one fails. A worker started from a blob
 * sees a `blob:` `location`, so its relative URLs would resolve differently: that's why this is
 * per site. The Proxy keeps `Worker`'s name, `toString()`, prototype and `instanceof`.
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
}

/** Bytes a worker queues before its port arrives, at most. */
const WORKER_QUEUE_BYTES = 8 * 1024 * 1024;

/**
 * The blob's source: the tee, then the original script. `token` marks the port message; `url` is
 * absolute.
 */
export function workerPrelude(
  options: Pick<WorkerTeeOptions, 'installTee' | 'kindOf'>,
  token: string,
  idPrefix: string,
  url: string,
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
importScripts(${json(url)});
`;
}

type WorkerClass = new (url: string | URL, options?: WorkerOptions) => Worker;

export function wrapWorkers(
  win: Window & typeof globalThis,
  options: WorkerTeeOptions,
): WorkerTee | null {
  const Original = win.Worker as WorkerClass | undefined;
  if (typeof Original !== 'function') return null;
  const postMessage = Original.prototype.postMessage;
  const createObjectURL = win.URL.createObjectURL.bind(win.URL);
  const ports: MessagePort[] = [];
  let killed = false;
  let refused = false;
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
    win.crypto.getRandomValues(random);
    const token = `${(random[0] ?? 0).toString(36)}${(random[1] ?? 0).toString(36)}`;
    const prefix = `${options.idPrefix}w${++count}-`;
    const source = workerPrelude(options, token, prefix, url);
    const blob = createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = Reflect.construct(Original, [blob, ...args.slice(1)], newTarget) as Worker;
    const channel = new MessageChannel();
    channel.port1.onmessage = (e: MessageEvent) => {
      const event = e.data as TeeEvent;
      if (killed || !event || typeof event !== 'object') return;
      options.send(
        event,
        event.t === 'append' && event.bytes instanceof ArrayBuffer ? [event.bytes] : [],
      );
    };
    ports.push(channel.port1);
    postMessage.call(worker, { [TEE_MESSAGE]: token }, [channel.port2]);
    return worker;
  };

  win.Worker = new Proxy(Original, {
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

  return {
    off() {
      killed = true;
      for (const port of ports) {
        try {
          port.postMessage({ t: 'off' });
        } catch {}
      }
    },
    get wrapped() {
      return count;
    },
  };
}
