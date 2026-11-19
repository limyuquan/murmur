/**
 * Messages of lookahead's capture path:
 *
 *   page (MAIN world, tee.ts) ──TeeEvent──▶ relay (isolated world, relay.ts)     MessagePort, bytes transferred
 *   relay ──TeeWire──▶ overlay ──OverlayToHost 'tee'──▶ offscreen document       runtime port, bytes as base64
 *
 * The relay sits in the page from `document_start` on the sites where lookahead is on, and holds
 * what the page appended until a session's overlay attaches; the overlay forwards it on its own
 * port to the offscreen document. Everything that comes from the page is untrusted: shapes are
 * checked on arrival (`isTeeEvent`, `isTeeWire`).
 */
import type { TrackKind } from './kind';

/** The marker on window messages between the tee and the relay (handing over the port). */
export const TEE_MESSAGE = '__murmurTee';

/** From the tee in the page (MAIN world) to the relay. */
export type TeeEvent =
  /** A MediaSource was given a blob URL (so an element playing that URL plays it). */
  | { t: 'url'; url: string; ms: string }
  | { t: 'sb'; sb: string; ms: string; mime: string; kind: TrackKind }
  | {
      t: 'append';
      sb: string;
      bytes: ArrayBuffer;
      tso: number;
      aws: number;
      /** `Infinity` doesn't survive JSON: null for no end. */
      awe: number | null;
      sequence: boolean;
    }
  | { t: 'remove'; sb: string; start: number; end: number }
  | { t: 'abort'; sb: string }
  | { t: 'ctype'; sb: string; mime: string; kind: TrackKind }
  | { t: 'sbrm'; sb: string }
  /**
   * An audio SourceBuffer's buffered ranges after an update, from a worker's tee only: the
   * element plays a `MediaSourceHandle`, so its MediaSource is found by matching these with the
   * element's own buffered ranges (the relay keeps them; not sent on).
   */
  | { t: 'buffered'; sb: string; ranges: [number, number][] };

/** From the relay to the tee. */
export type TeeControl =
  /** The kill switch: hooks pass straight through from now on. */
  { t: 'off' };

/** A TeeEvent on the way to the offscreen document. */
export type TeeWire =
  | Exclude<TeeEvent, { t: 'append' | 'buffered' }>
  | {
      t: 'append';
      sb: string;
      /** Base64. */
      bytes: string;
      tso: number;
      aws: number;
      awe: number | null;
      sequence: boolean;
      /** Bytes before this were dropped (the relay's buffer was full): find a segment start. */
      resync?: boolean;
    }
  /** Answer to a `fetch` request (progressive sources, read with the page's own access). */
  | { t: 'fetched'; id: number; bytes?: string; total?: number | null; error?: string };

/** What the overlay reports about the video it follows, for lookahead. */
export interface PlayheadReport {
  /** PCM timeline: a MediaSource id, or `p:<url>` for a progressive source; null: neither. */
  timeline: string | null;
  /** Content key (cues are kept under it): a site's id for the video, else the timeline. */
  key: string | null;
  /** The player is showing an ad. */
  ad: boolean;
  time: number;
  rate: number;
  paused: boolean;
  /** Epoch ms of `time`. */
  at: number;
}

/** The global the relay leaves in the isolated world, for the overlay (same world). */
export interface TeeRelayApi {
  readonly version: 1;
  /** Starts forwarding (everything held so far first). Returns a detach. */
  attach(sink: (wire: TeeWire) => void): () => void;
  /** The MediaSource an element plays, from its blob URL. */
  mediaSourceOf(url: string): string | null;
  /**
   * The MediaSource in a worker an element plays (`srcObject` is a `MediaSourceHandle`): the one
   * whose audio is buffered where the element's is (`buffered`), around `time`. Null: none seen.
   */
  mediaSourceFor(buffered: readonly (readonly [number, number])[], time: number): string | null;
  /** Reads bytes of a URL with the page's access (progressive sources on the page's origin). */
  fetchRange(
    url: string,
    start: number,
    end: number,
  ): Promise<{ bytes: Uint8Array; total: number | null }>;
}

declare global {
  /** Set by tee-relay.js on sites where lookahead is on. */
  var __murmurTee: TeeRelayApi | undefined;
}

const KINDS = new Set(['audio', 'video', 'muxed', 'unknown']);
const MAX_ID = 64;
const MAX_MIME = 256;

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && !Number.isNaN(v);
}

/** Whether `m` is a well-formed TeeEvent (it comes from the page). */
export function isTeeEvent(m: unknown): m is TeeEvent {
  if (typeof m !== 'object' || m === null) return false;
  const e = m as Record<string, unknown>;
  switch (e.t) {
    case 'url':
      return typeof e.url === 'string' && e.url.length < 2048 && isId(e.ms);
    case 'sb':
    case 'ctype':
      return (
        isId(e.sb) &&
        (e.t === 'ctype' || isId(e.ms)) &&
        typeof e.mime === 'string' &&
        e.mime.length <= MAX_MIME &&
        KINDS.has(e.kind as string)
      );
    case 'append':
      return (
        isId(e.sb) &&
        e.bytes instanceof ArrayBuffer &&
        isNum(e.tso) &&
        isNum(e.aws) &&
        (e.awe === null || isNum(e.awe)) &&
        typeof e.sequence === 'boolean'
      );
    case 'remove':
      return isId(e.sb) && isNum(e.start) && isNum(e.end);
    case 'abort':
    case 'sbrm':
      return isId(e.sb);
    case 'buffered':
      return (
        isId(e.sb) &&
        Array.isArray(e.ranges) &&
        e.ranges.length <= 32 &&
        e.ranges.every((r) => Array.isArray(r) && r.length === 2 && isNum(r[0]) && isNum(r[1]))
      );
    default:
      return false;
  }
}

/** Whether `m` is a well-formed TeeWire (it comes from a content script). */
export function isTeeWire(m: unknown): m is TeeWire {
  if (typeof m !== 'object' || m === null) return false;
  const e = m as Record<string, unknown>;
  if (e.t === 'append') {
    return (
      isId(e.sb) &&
      typeof e.bytes === 'string' &&
      isNum(e.tso) &&
      isNum(e.aws) &&
      (e.awe === null || isNum(e.awe)) &&
      typeof e.sequence === 'boolean'
    );
  }
  if (e.t === 'fetched') return isNum(e.id);
  if (e.t === 'buffered') return false;
  return isTeeEvent(m);
}

/** Whether `m` is a well-formed PlayheadReport (it comes from a content script). */
export function isPlayheadReport(m: unknown): m is PlayheadReport {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as Record<string, unknown>;
  const text = (v: unknown) => v === null || (typeof v === 'string' && v.length <= 4096);
  return (
    text(r.timeline) &&
    text(r.key) &&
    typeof r.ad === 'boolean' &&
    isNum(r.time) &&
    isNum(r.rate) &&
    typeof r.paused === 'boolean' &&
    isNum(r.at)
  );
}
