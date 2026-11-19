/**
 * WebM (Matroska) for lookahead, audio only: the stream a page appends to a SourceBuffer, in any
 * slices (some players append fixed-size pieces that cut elements anywhere).
 *
 * Master elements are entered without tracking their ends, so unknown sizes (live clusters) are
 * fine. Elements Murmur doesn't need (cues, tags, video frames) are skipped as they stream past,
 * never buffered whole. Frame times: the cluster's timecode plus the block's, scaled by the
 * segment's TimecodeScale; laced frames are spaced by the track's DefaultDuration or the Opus
 * packet's own duration.
 */
import { concat, indexOf } from './bytes';
import { ascObjectType } from './fmp4';
import {
  type AudioTrackConfig,
  DEMUX_LIMITS,
  DemuxError,
  type DemuxEvent,
  type Demuxer,
  type EncodedSample,
} from './types';

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  ContentEncodings: 0x6d80,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
} as const;

/** Entered as containers (their children follow). */
const MASTERS = new Set<number>([
  ID.Segment,
  ID.Info,
  ID.Tracks,
  ID.TrackEntry,
  ID.Audio,
  ID.Cluster,
  ID.BlockGroup,
]);

/** Leaves read whole (small). Every other element is skipped as it streams past. */
const LEAVES = new Set<number>([
  ID.TimecodeScale,
  ID.TrackNumber,
  ID.TrackType,
  ID.CodecID,
  ID.CodecPrivate,
  ID.DefaultDuration,
  ID.SamplingFrequency,
  ID.Channels,
  ID.Timecode,
]);

const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];
const EBML_ID = [0x1a, 0x45, 0xdf, 0xa3];

interface Vint {
  value: number;
  length: number;
  /** All value bits set: an unknown size. */
  unknown: boolean;
}

/** An EBML variable-size integer at `o` (`marker`: keep the length marker, as IDs do). */
export function readVint(u8: Uint8Array, o: number, marker = false): Vint | null {
  const first = u8[o];
  if (first === undefined || first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    length++;
    mask >>= 1;
  }
  if (o + length > u8.length) return null;
  let value = marker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    const b = u8[o + i] ?? 0;
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !marker && allOnes };
}

function readUint(u8: Uint8Array, o: number, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + (u8[o + i] ?? 0);
  return v;
}

function readFloat(u8: Uint8Array, o: number, n: number): number {
  const dv = new DataView(u8.buffer, u8.byteOffset + o, n);
  return n === 4 ? dv.getFloat32(0) : n === 8 ? dv.getFloat64(0) : 0;
}

/** Duration of an Opus packet from its TOC byte(s), seconds (RFC 6716 §3.1). */
export function opusPacketDuration(packet: Uint8Array): number | null {
  const toc = packet[0];
  if (toc === undefined) return null;
  const config = toc >> 3;
  let frameMs: number;
  if (config < 12) frameMs = [10, 20, 40, 60][config % 4] as number;
  else if (config < 16) frameMs = config % 2 === 0 ? 10 : 20;
  else frameMs = [2.5, 5, 10, 20][config % 4] as number;
  const code = toc & 3;
  let frames = 1;
  if (code === 1 || code === 2) frames = 2;
  else if (code === 3) {
    const count = packet[1];
    if (count === undefined) return null;
    frames = count & 0x3f;
  }
  return (frames * frameMs) / 1000;
}

interface Track {
  number?: number;
  type?: number;
  codecId?: string;
  codecPrivate?: Uint8Array;
  defaultDurationNs?: number;
  sampleRate?: number;
  channels?: number;
  encrypted?: boolean;
}

function configOf(t: Track): AudioTrackConfig | null {
  const base = {
    sampleRate: Math.round(t.sampleRate ?? 48000),
    channels: t.channels ?? 1,
    encrypted: t.encrypted ?? false,
  };
  switch (t.codecId) {
    case 'A_OPUS':
      return { codec: 'opus', ...base, sampleRate: 48000, description: t.codecPrivate ?? null };
    case 'A_VORBIS':
      return { codec: 'vorbis', ...base, description: t.codecPrivate ?? null };
    case 'A_FLAC':
      return { codec: 'flac', ...base, description: t.codecPrivate ?? null };
    case 'A_AAC':
      return {
        codec: `mp4a.40.${ascObjectType(t.codecPrivate ?? null)}`,
        ...base,
        description: t.codecPrivate ?? null,
      };
    case 'A_MPEG/L3':
      return { codec: 'mp3', ...base, description: null };
    default:
      return null;
  }
}

export class WebmDemuxer implements Demuxer {
  private pending = new Uint8Array(0);
  /** Pushed bytes not yet joined to `pending` (the element at its start needs more). */
  private waiting: Uint8Array[] = [];
  private waitingBytes = 0;
  /** Bytes `pending` must reach before the element at its start can be read. */
  private need = 0;
  /** Bytes still to drop of an element being skipped. */
  private skip = 0;
  private resyncing = false;
  private timecodeScale = 1_000_000;
  private clusterTimecode = 0;
  private tracks: Track[] = [];
  /** Tracks changed since the last `init` event. */
  private dirty = false;
  private audio: { number: number; config: AudioTrackConfig; frameS: number | null } | null = null;
  /** Frames read in the current push. */
  private readonly batch: EncodedSample[] = [];

  push(bytes: Uint8Array): DemuxEvent[] {
    const events: DemuxEvent[] = [];
    let u8 = bytes;
    if (this.skip > 0) {
      const n = Math.min(this.skip, u8.length);
      this.skip -= n;
      u8 = u8.subarray(n);
    }
    // An element arriving in many pushes is joined once, not copied again on every push.
    if (this.pending.length + this.waitingBytes + u8.length < this.need) {
      this.waiting.push(u8.slice());
      this.waitingBytes += u8.length;
      return events;
    }
    u8 = concat(this.pending, ...this.waiting, u8);
    this.waiting = [];
    this.waitingBytes = 0;
    this.need = 0;
    if (this.resyncing) {
      const cluster = indexOf(u8, CLUSTER_ID);
      const ebml = indexOf(u8, EBML_ID);
      const at = [cluster, ebml].filter((i) => i >= 0).sort((a, b) => a - b)[0];
      if (at === undefined) {
        this.pending = u8.slice(Math.max(0, u8.length - 3));
        return events;
      }
      u8 = u8.subarray(at);
      this.resyncing = false;
    }
    const samples = this.batch;
    let o = 0;
    let need = 0;
    while (o < u8.length) {
      const id = readVint(u8, o, true);
      // A zero byte can't start an id or a size: not a stream we can follow from here.
      if (!id) {
        if (u8[o] === 0) return this.lost(events, samples, 'bad element id');
        break;
      }
      const size = readVint(u8, o + id.length);
      if (!size) {
        if (u8[o + id.length] === 0) return this.lost(events, samples, 'bad element size');
        break;
      }
      const body = o + id.length + size.length;
      if (MASTERS.has(id.value)) {
        this.enter(id.value, events);
        o = body;
        continue;
      }
      if (size.unknown) {
        // A leaf can't have an unknown size: this isn't a stream we can follow.
        return this.lost(events, samples, 'unknown-size leaf');
      }
      const end = body + size.value;
      const read = id.value === ID.SimpleBlock || id.value === ID.Block || LEAVES.has(id.value);
      // Read whole: a frame or a header field, never megabytes (skipped elements stream past).
      if (read && size.value > DEMUX_LIMITS.headerBytes) {
        throw new DemuxError(`element of ${size.value} bytes`);
      }
      if (id.value === ID.SimpleBlock || id.value === ID.Block) {
        // Peek at the track: another track's frame is skipped without buffering it.
        const track = readVint(u8, body);
        if (!track) break;
        const ours = this.audio !== null && track.value === this.audio.number;
        if (!ours) {
          if (end > u8.length) {
            this.skip = end - u8.length;
            o = u8.length;
            break;
          }
          o = end;
          continue;
        }
        if (end > u8.length) {
          need = end - o;
          break;
        }
        this.readBlock(u8, body, end, track, samples, events);
        o = end;
        continue;
      }
      if (!LEAVES.has(id.value)) {
        if (id.value === ID.ContentEncodings) this.current().encrypted = true;
        if (end > u8.length) {
          this.skip = end - u8.length;
          o = u8.length;
          break;
        }
        o = end;
        continue;
      }
      if (end > u8.length) {
        need = end - o;
        break;
      }
      this.readLeaf(id.value, u8, body, size.value);
      o = end;
    }
    this.pending = u8.slice(o);
    this.need = need;
    return this.finish(events, samples);
  }

  reset(): void {
    this.pending = new Uint8Array(0);
    this.waiting = [];
    this.waitingBytes = 0;
    this.need = 0;
    this.skip = 0;
  }

  /** Lost the element structure: look for the next cluster or header. */
  private lost(events: DemuxEvent[], samples: EncodedSample[], why: string): DemuxEvent[] {
    events.push({ type: 'warning', message: why });
    this.resyncing = true;
    this.pending = new Uint8Array(0);
    this.need = 0;
    return this.finish(events, samples);
  }

  resync(): void {
    this.reset();
    this.resyncing = true;
  }

  private finish(events: DemuxEvent[], samples: EncodedSample[]): DemuxEvent[] {
    if (samples.length > 0) events.push({ type: 'samples', samples: samples.splice(0) });
    return events;
  }

  private current(): Track {
    let t = this.tracks.at(-1);
    if (!t) {
      t = {};
      this.tracks.push(t);
    }
    return t;
  }

  private enter(id: number, events: DemuxEvent[]): void {
    if (id === ID.Tracks) {
      this.tracks = [];
      this.dirty = true;
    } else if (id === ID.TrackEntry) {
      this.tracks.push({});
      this.dirty = true;
    } else if (id === ID.Cluster) {
      this.settle(events);
    } else if (id === ID.Segment) {
      this.timecodeScale = 1_000_000;
    }
  }

  /** Tracks are complete once a cluster starts: pick the audio track. */
  private settle(events: DemuxEvent[]): void {
    if (!this.dirty) return;
    this.dirty = false;
    // Frames before the new tracks go out with the old config.
    if (this.batch.length > 0) events.push({ type: 'samples', samples: this.batch.splice(0) });
    const track = this.tracks.find((t) => t.type === 2 && t.number !== undefined);
    const config = track ? configOf(track) : null;
    this.audio =
      track && config
        ? {
            number: track.number as number,
            config,
            frameS: track.defaultDurationNs ? track.defaultDurationNs / 1e9 : null,
          }
        : null;
    events.push({ type: 'init', audio: config });
  }

  private readLeaf(id: number, u8: Uint8Array, body: number, size: number): void {
    switch (id) {
      case ID.TimecodeScale:
        this.timecodeScale = readUint(u8, body, size) || 1_000_000;
        break;
      case ID.Timecode:
        this.clusterTimecode = readUint(u8, body, size);
        break;
      case ID.TrackNumber:
        this.current().number = readUint(u8, body, size);
        break;
      case ID.TrackType:
        this.current().type = readUint(u8, body, size);
        break;
      case ID.CodecID:
        this.current().codecId = new TextDecoder().decode(u8.subarray(body, body + size));
        break;
      case ID.CodecPrivate:
        this.current().codecPrivate = u8.slice(body, body + size);
        break;
      case ID.DefaultDuration:
        this.current().defaultDurationNs = readUint(u8, body, size);
        break;
      case ID.SamplingFrequency:
        this.current().sampleRate = readFloat(u8, body, size);
        break;
      case ID.Channels:
        this.current().channels = readUint(u8, body, size);
        break;
    }
  }

  private readBlock(
    u8: Uint8Array,
    body: number,
    end: number,
    track: Vint,
    samples: EncodedSample[],
    events: DemuxEvent[],
  ): void {
    const audio = this.audio;
    if (!audio) return;
    const p = body + track.length;
    if (p + 3 > end) return;
    const relative = (((u8[p] ?? 0) << 24) >> 16) | (u8[p + 1] ?? 0);
    const flags = u8[p + 2] ?? 0;
    const time = ((this.clusterTimecode + relative) * this.timecodeScale) / 1e9;
    const frames = lacedFrames(u8, p + 3, end, (flags >> 1) & 3);
    if (!frames) {
      events.push({ type: 'warning', message: 'bad lacing' });
      return;
    }
    let t = time;
    for (const data of frames) {
      const duration =
        audio.config.codec === 'opus' ? opusPacketDuration(data) : (audio.frameS ?? null);
      samples.push({ time: t, duration, data });
      t += duration ?? 0;
    }
  }
}

/** The frames of a block's payload `[o, end)` for its lacing (0 none, 1 Xiph, 2 fixed, 3 EBML). */
export function lacedFrames(
  u8: Uint8Array,
  o: number,
  end: number,
  lacing: number,
): Uint8Array[] | null {
  if (lacing === 0) return [u8.slice(o, end)];
  const count = (u8[o] ?? 0) + 1;
  let q = o + 1;
  const sizes: number[] = [];
  if (lacing === 1) {
    for (let i = 0; i < count - 1; i++) {
      let s = 0;
      let b = 255;
      while (b === 255 && q < end) {
        b = u8[q++] ?? 0;
        s += b;
      }
      sizes.push(s);
    }
  } else if (lacing === 3) {
    const first = readVint(u8, q);
    if (!first) return null;
    q += first.length;
    sizes.push(first.value);
    for (let i = 1; i < count - 1; i++) {
      const v = readVint(u8, q);
      if (!v) return null;
      q += v.length;
      // Signed: subtract half the range.
      const diff = v.value - (2 ** (7 * v.length - 1) - 1);
      sizes.push((sizes[i - 1] ?? 0) + diff);
    }
  } else {
    const size = (end - q) / count;
    if (!Number.isInteger(size)) return null;
    for (let i = 0; i < count - 1; i++) sizes.push(size);
  }
  const used = sizes.reduce((a, b) => a + b, 0);
  sizes.push(end - q - used);
  const frames: Uint8Array[] = [];
  for (const s of sizes) {
    if (s < 0 || q + s > end) return null;
    frames.push(u8.slice(q, q + s));
    q += s;
  }
  return frames;
}
