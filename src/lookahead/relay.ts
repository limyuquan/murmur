/**
 * The relay: runs in the extension's isolated world of each frame, from `document_start`, on
 * sites where lookahead is on. It takes the tee's events (tee.ts) over a private MessagePort and
 * holds them until a session's overlay attaches (`globalThis.__murmurTee`), then hands everything
 * on: first what it held, then each event as it comes.
 *
 * While no overlay is attached it keeps the page's MediaSources and SourceBuffers, the latest init
 * segment of each (a few hundred bytes, needed to decode anything later), and the most recent
 * appended audio up to `HOLD_BYTES`. So turning subtitles on mid-video starts with what the
 * player has already buffered ahead, not just what it appends next. This stays in the page's
 * memory; nothing leaves it until the person turns subtitles on.
 */
import { toBase64 } from './bytes';
import { topLevelBoxes } from './fmp4';
import type { TrackKind } from './kind';
import {
  isTeeEvent,
  TEE_MESSAGE,
  type TeeControl,
  type TeeEvent,
  type TeeRelayApi,
  type TeeWire,
} from './protocol';

/** Appended audio held while no overlay is attached, at most. */
export const HOLD_BYTES = 12 * 1024 * 1024;
/** An init segment bigger than this isn't kept on its own. */
const MAX_INIT = 512 * 1024;
const MAX_URLS = 64;

/** The init segment at the start of an append, if it begins with one (copied), else null. */
export function initSegmentOf(bytes: Uint8Array, mime: string): Uint8Array | null {
  if (/webm|matroska/i.test(mime)) {
    // EBML header: the init runs up to the first cluster.
    if (bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) {
      return null;
    }
    for (let i = 4; i + 4 <= bytes.length && i < MAX_INIT; i++) {
      if (
        bytes[i] === 0x1f &&
        bytes[i + 1] === 0x43 &&
        bytes[i + 2] === 0xb6 &&
        bytes[i + 3] === 0x75
      ) {
        return bytes.slice(0, i);
      }
    }
    return bytes.length <= MAX_INIT ? bytes.slice() : null;
  }
  const boxes = topLevelBoxes(bytes.subarray(0, Math.min(bytes.length, MAX_INIT)));
  const moov = boxes.find((b) => b.type === 'moov');
  if (!moov || moov.start + moov.size > bytes.length) return null;
  return bytes.slice(0, moov.start + moov.size);
}

interface Buffer {
  ms: string;
  mime: string;
  kind: TrackKind;
  init: Uint8Array | null;
}

type HeldEntry =
  | { event: Exclude<TeeEvent, { t: 'append' }> }
  | { append: Extract<TeeEvent, { t: 'append' }>; size: number };

export class Relay implements TeeRelayApi {
  readonly version = 1;
  private readonly urls = new Map<string, string>();
  private readonly buffers = new Map<string, Buffer>();
  private held: HeldEntry[] = [];
  private heldBytes = 0;
  private sink: ((wire: TeeWire) => void) | null = null;
  private disabled = false;
  /** Ports the tee may be using (to switch it off). */
  readonly ports: MessagePort[] = [];

  constructor(
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
    private readonly holdBytes = HOLD_BYTES,
  ) {}

  /** The kill switch, or lookahead turned off for this site: the tee passes through, all dropped. */
  off(): void {
    this.disabled = true;
    for (const port of this.ports) port.postMessage({ t: 'off' } satisfies TeeControl);
    this.held = [];
    this.heldBytes = 0;
    this.buffers.clear();
    this.sink = null;
  }

  get isOff(): boolean {
    return this.disabled;
  }

  /** An event from the tee (already checked). */
  onEvent(event: TeeEvent): void {
    if (this.disabled) return;
    switch (event.t) {
      case 'url':
        this.urls.set(event.url, event.ms);
        if (this.urls.size > MAX_URLS) this.urls.delete(this.urls.keys().next().value as string);
        return;
      case 'sb':
        this.buffers.set(event.sb, {
          ms: event.ms,
          mime: event.mime,
          kind: event.kind,
          init: null,
        });
        this.forward(event);
        return;
      case 'ctype': {
        const b = this.buffers.get(event.sb);
        if (b) {
          b.mime = event.mime;
          b.kind = event.kind;
          b.init = null;
        }
        break;
      }
      case 'sbrm':
        this.buffers.delete(event.sb);
        break;
      case 'append': {
        const b = this.buffers.get(event.sb);
        if (!b) return;
        const init = initSegmentOf(new Uint8Array(event.bytes), b.mime);
        if (init) b.init = init;
        this.hold({ append: event, size: event.bytes.byteLength });
        if (this.sink) this.sink(wireOf(event));
        return;
      }
    }
    this.hold({ event });
    this.forward(event);
  }

  attach(sink: (wire: TeeWire) => void): () => void {
    if (this.disabled) return () => {};
    this.sink = sink;
    // What the page set up, each buffer's init, then what was held, in order. The first held
    // append of each buffer may start mid-segment: the demuxer looks for a segment start there.
    for (const [sb, b] of this.buffers) {
      sink({ t: 'sb', sb, ms: b.ms, mime: b.mime, kind: b.kind });
      if (b.init) {
        sink({
          t: 'append',
          sb,
          bytes: toBase64(b.init),
          tso: 0,
          aws: 0,
          awe: null,
          sequence: false,
          resync: true,
        });
      }
    }
    const started = new Set<string>();
    for (const entry of this.held) {
      if ('event' in entry) {
        if (entry.event.t !== 'sb') sink(entry.event);
        continue;
      }
      const a = entry.append;
      if (!this.buffers.has(a.sb)) continue;
      const wire = wireOf(a);
      if (!started.has(a.sb)) {
        started.add(a.sb);
        if (wire.t === 'append') wire.resync = true;
      }
      sink(wire);
    }
    return () => {
      if (this.sink === sink) this.sink = null;
    };
  }

  mediaSourceOf(url: string): string | null {
    return this.urls.get(url) ?? null;
  }

  async fetchRange(
    url: string,
    start: number,
    end: number,
  ): Promise<{ bytes: Uint8Array; total: number | null }> {
    const response = await this.fetcher(url, {
      headers: { Range: `bytes=${start}-${end - 1}` },
      credentials: 'include',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const total = Number(/\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1]);
    let bytes = new Uint8Array(await response.arrayBuffer());
    // A server that ignores Range sends the whole file.
    if (response.status === 200) bytes = bytes.slice(start, end);
    return {
      bytes,
      total: Number.isFinite(total) ? total : response.status === 200 ? bytes.length : null,
    };
  }

  private forward(event: TeeEvent): void {
    if (this.sink && event.t !== 'append') this.sink(event);
  }

  private hold(entry: HeldEntry): void {
    this.held.push(entry);
    if (!('append' in entry)) return;
    this.heldBytes += entry.size;
    while (this.heldBytes > this.holdBytes && this.held.length > 0) {
      const old = this.held.shift() as HeldEntry;
      if ('append' in old) this.heldBytes -= old.size;
    }
  }
}

function wireOf(event: Extract<TeeEvent, { t: 'append' }>): TeeWire {
  return {
    t: 'append',
    sb: event.sb,
    bytes: toBase64(new Uint8Array(event.bytes)),
    tso: event.tso,
    aws: event.aws,
    awe: event.awe,
    sequence: event.sequence,
  };
}

/** The isolated-world side: hands the tee a port, and leaves the relay for the overlay. */
export function startRelay(win: Window): Relay | null {
  if (globalThis.__murmurTee) return null;
  const relay = new Relay();
  globalThis.__murmurTee = relay;
  // A port per offer: the tee takes the first that reaches it (at most two are ever made).
  const offer = () => {
    if (relay.ports.length >= 2) return;
    const channel = new MessageChannel();
    channel.port1.onmessage = (e: MessageEvent) => {
      if (isTeeEvent(e.data)) relay.onEvent(e.data);
    };
    relay.ports.push(channel.port1);
    win.postMessage({ [TEE_MESSAGE]: 'port' }, '*', [channel.port2]);
  };
  win.addEventListener(
    'message',
    (e: MessageEvent) => {
      const data = e.data as { [TEE_MESSAGE]?: string } | null;
      if (e.source === win && data?.[TEE_MESSAGE] === 'hello') {
        e.stopImmediatePropagation();
        offer();
      }
    },
    true,
  );
  offer();
  return relay;
}
