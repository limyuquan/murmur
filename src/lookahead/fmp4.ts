/**
 * ISO BMFF (MP4) for lookahead, audio only:
 *
 * - `Fmp4Demuxer`: the stream a page appends to a SourceBuffer: an init segment (`moov`) then
 *   fragments (`moof` + `mdat`), cut into any slices. Boxes may span appends; a fragment's
 *   samples come out once its `mdat` is complete.
 * - `parseMovie` / `topLevelBoxes`: a whole (non-fragmented) file's index, for progressive
 *   sources read by byte range (progressive.ts).
 *
 * Times follow what Chromium's MSE does: the first edit of the track's edit list shifts every
 * sample earlier by its `media_time` (encoder priming), and `cts` offsets apply.
 */
import { concat, fourcc, i32, u16, u32, u64 } from './bytes';
import type { AudioTrackConfig, DemuxEvent, Demuxer, EncodedSample } from './types';

interface Box {
  type: string;
  start: number;
  /** Header size (8 or 16). */
  header: number;
  size: number;
  body: number;
  end: number;
}

/** Boxes laid out in `u8[start, end)`. Stops at the first one that doesn't fit. */
function* boxes(u8: Uint8Array, start: number, end: number): Generator<Box> {
  let o = start;
  while (o + 8 <= end) {
    let size = u32(u8, o);
    const type = fourcc(u8, o + 4);
    let header = 8;
    if (size === 1) {
      if (o + 16 > end) return;
      size = u64(u8, o + 8);
      header = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < header || o + size > end) return;
    yield { type, start: o, header, size, body: o + header, end: o + size };
    o += size;
  }
}

function child(u8: Uint8Array, parent: Box, type: string): Box | null {
  for (const b of boxes(u8, parent.body, parent.end)) if (b.type === type) return b;
  return null;
}

function path(u8: Uint8Array, parent: Box, types: readonly string[]): Box | null {
  let cur: Box | null = parent;
  for (const t of types) {
    if (!cur) return null;
    cur = child(u8, cur, t);
  }
  return cur;
}

/** One track of a `moov`. */
export interface Mp4Track {
  id: number;
  handler: string;
  timescale: number;
  /** Seconds to subtract from every sample time (the first edit's `media_time`). */
  editShift: number;
  /** For audio tracks: how to decode it (null: a codec Murmur can't decode). */
  audio: AudioTrackConfig | null;
  /** `trex` defaults for fragments. */
  defaultDuration: number;
  defaultSize: number;
  /** The sample table box, for non-fragmented files. */
  stbl: Box | null;
}

const AUDIO_ENTRIES = new Set(['mp4a', 'enca', 'Opus', 'fLaC', '.mp3', 'mp3 ']);

/** Reads an MPEG-4 descriptor length (1–4 bytes of 7 bits). */
function descriptorLength(u8: Uint8Array, o: number): { length: number; bytes: number } {
  let length = 0;
  let i = 0;
  let b = 0;
  do {
    b = u8[o + i] ?? 0;
    length = (length << 7) | (b & 0x7f);
    i++;
  } while (b & 0x80 && i < 4);
  return { length, bytes: i };
}

/** `esds`: the object type and the AudioSpecificConfig. */
function parseEsds(u8: Uint8Array, esds: Box): { codec: string; description: Uint8Array | null } {
  let o = esds.body + 4;
  let objectType = 0;
  let asc: Uint8Array | null = null;
  while (o < esds.end) {
    const tag = u8[o] ?? 0;
    const { length, bytes } = descriptorLength(u8, o + 1);
    const body = o + 1 + bytes;
    if (tag === 0x03) {
      // ES_Descriptor: id, flags, optional fields, then nested descriptors.
      let p = body + 2;
      const flags = u8[p] ?? 0;
      p++;
      if (flags & 0x80) p += 2;
      if (flags & 0x40) p += 1 + (u8[p] ?? 0);
      if (flags & 0x20) p += 2;
      o = p;
      continue;
    }
    if (tag === 0x04) {
      // DecoderConfigDescriptor: objectTypeIndication, then 12 bytes, then nested.
      objectType = u8[body] ?? 0;
      o = body + 13;
      continue;
    }
    if (tag === 0x05) {
      asc = u8.slice(body, body + length);
      break;
    }
    o = body + length;
  }
  if (objectType === 0x6b || objectType === 0x69) return { codec: 'mp3', description: null };
  return { codec: `mp4a.40.${ascObjectType(asc)}`, description: asc };
}

/** Audio object type from an AudioSpecificConfig (2 when unreadable: AAC-LC). */
export function ascObjectType(asc: Uint8Array | null): number {
  if (!asc || asc.length === 0) return 2;
  let aot = (asc[0] ?? 0) >> 3;
  if (aot === 31 && asc.length > 1) aot = 32 + (((asc[0] ?? 0) & 7) << 3) + ((asc[1] ?? 0) >> 5);
  return aot || 2;
}

/** ISO `dOps` (Opus in MP4, big-endian) as the `OpusHead` WebCodecs takes. */
export function opusHeadFromDops(u8: Uint8Array, dops: Box): Uint8Array {
  const b = dops.body;
  const channels = u8[b + 1] ?? 1;
  const preSkip = u16(u8, b + 2);
  const inputRate = u32(u8, b + 4);
  const gain = u16(u8, b + 8);
  const family = u8[b + 10] ?? 0;
  const table = family !== 0 ? u8.subarray(b + 11, b + 13 + channels) : new Uint8Array(0);
  const head = new Uint8Array(19 + table.length);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // "OpusHead"
  head[8] = 1;
  head[9] = channels;
  head[10] = preSkip & 0xff;
  head[11] = preSkip >> 8;
  head[12] = inputRate & 0xff;
  head[13] = (inputRate >> 8) & 0xff;
  head[14] = (inputRate >> 16) & 0xff;
  head[15] = (inputRate >>> 24) & 0xff;
  head[16] = gain & 0xff;
  head[17] = gain >> 8;
  head[18] = family;
  head.set(table, 19);
  return head;
}

/** The first sample entry of `stsd`, as an audio config (null when not audio or unknown). */
function parseStsd(u8: Uint8Array, stsd: Box): AudioTrackConfig | null {
  for (const entry of boxes(u8, stsd.body + 8, stsd.end)) {
    if (!AUDIO_ENTRIES.has(entry.type)) return null;
    // AudioSampleEntry: 8 (SampleEntry) + 8 reserved + channels, size, 4, rate (16.16).
    const base = entry.body;
    const config: AudioTrackConfig = {
      codec: '',
      channels: u16(u8, base + 16),
      sampleRate: u32(u8, base + 24) >>> 16,
      description: null,
      encrypted: entry.type === 'enca',
    };
    let format = entry.type;
    for (const c of boxes(u8, base + 28, entry.end)) {
      if (c.type === 'sinf') {
        config.encrypted = true;
        const frma = path(u8, c, ['frma']);
        if (frma) format = fourcc(u8, frma.body);
      } else if (c.type === 'esds') {
        Object.assign(config, parseEsds(u8, c));
      } else if (c.type === 'dOps') {
        config.codec = 'opus';
        config.sampleRate = 48000;
        config.description = opusHeadFromDops(u8, c);
      } else if (c.type === 'dfLa') {
        config.codec = 'flac';
        const blocks = u8.subarray(c.body + 4, c.end);
        const desc = new Uint8Array(4 + blocks.length);
        desc.set([0x66, 0x4c, 0x61, 0x43]); // "fLaC"
        desc.set(blocks, 4);
        config.description = desc;
      }
    }
    if (!config.codec) {
      if (format === 'Opus') config.codec = 'opus';
      else if (format === '.mp3' || format === 'mp3 ') config.codec = 'mp3';
      else if (format === 'mp4a') config.codec = 'mp4a.40.2';
      else return null;
    }
    return config;
  }
  return null;
}

/** Tracks of a `moov` (`u8` holds the whole box). */
export function parseMoov(u8: Uint8Array, moov: Box): Mp4Track[] {
  const tracks: Mp4Track[] = [];
  const mvhd = child(u8, moov, 'mvhd');
  const movieScale = mvhd ? u32(u8, mvhd.body + (u8[mvhd.body] === 1 ? 20 : 12)) : 1000;
  for (const trak of boxes(u8, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue;
    const tkhd = child(u8, trak, 'tkhd');
    const mdhd = path(u8, trak, ['mdia', 'mdhd']);
    const hdlr = path(u8, trak, ['mdia', 'hdlr']);
    if (!tkhd || !mdhd || !hdlr) continue;
    const id = u32(u8, tkhd.body + (u8[tkhd.body] === 1 ? 20 : 12));
    const timescale = u32(u8, mdhd.body + (u8[mdhd.body] === 1 ? 20 : 12)) || 1;
    const handler = fourcc(u8, hdlr.body + 8);
    const stbl = path(u8, trak, ['mdia', 'minf', 'stbl']);
    const stsd = stbl ? child(u8, stbl, 'stsd') : null;
    const audio = handler === 'soun' && stsd ? parseStsd(u8, stsd) : null;
    tracks.push({
      id,
      handler,
      timescale,
      editShift: editShift(u8, trak, timescale, movieScale),
      audio,
      defaultDuration: 0,
      defaultSize: 0,
      stbl,
    });
  }
  const mvex = child(u8, moov, 'mvex');
  if (mvex) {
    for (const trex of boxes(u8, mvex.body, mvex.end)) {
      if (trex.type !== 'trex') continue;
      const track = tracks.find((t) => t.id === u32(u8, trex.body + 4));
      if (track) {
        track.defaultDuration = u32(u8, trex.body + 12);
        track.defaultSize = u32(u8, trex.body + 16);
      }
    }
  }
  return tracks;
}

/** Seconds the first non-empty edit skips at the start of the media (encoder priming). */
function editShift(u8: Uint8Array, trak: Box, timescale: number, _movieScale: number): number {
  const elst = path(u8, trak, ['edts', 'elst']);
  if (!elst) return 0;
  const version = u8[elst.body] ?? 0;
  const count = u32(u8, elst.body + 4);
  const entrySize = version === 1 ? 20 : 12;
  for (let i = 0; i < count; i++) {
    const o = elst.body + 8 + i * entrySize;
    if (o + entrySize > elst.end) break;
    const mediaTime = version === 1 ? u64(u8, o + 8) : i32(u8, o + 4);
    // -1 (or 2^64-1): an empty edit, a delay. Chromium's MSE ignores those; so do we.
    if (mediaTime < 0 || mediaTime >= 2 ** 53) continue;
    return mediaTime / timescale;
  }
  return 0;
}

interface TrafRun {
  trackId: number;
  baseTime: number | null;
  /** Byte offsets are from this absolute stream position. */
  base: number;
  samples: { offset: number; size: number; duration: number; cts: number }[];
}

function parseMoof(u8: Uint8Array, moof: Box, moofAbs: number, tracks: Mp4Track[]): TrafRun[] {
  const out: TrafRun[] = [];
  for (const traf of boxes(u8, moof.body, moof.end)) {
    if (traf.type !== 'traf') continue;
    const tfhd = child(u8, traf, 'tfhd');
    if (!tfhd) continue;
    const flags = u32(u8, tfhd.body) & 0xffffff;
    const trackId = u32(u8, tfhd.body + 4);
    const track = tracks.find((t) => t.id === trackId);
    let p = tfhd.body + 8;
    let base = moofAbs;
    if (flags & 0x1) {
      base = u64(u8, p);
      p += 8;
    }
    if (flags & 0x2) p += 4;
    let defaultDuration = track?.defaultDuration ?? 0;
    let defaultSize = track?.defaultSize ?? 0;
    if (flags & 0x8) {
      defaultDuration = u32(u8, p);
      p += 4;
    }
    if (flags & 0x10) {
      defaultSize = u32(u8, p);
      p += 4;
    }
    const tfdt = child(u8, traf, 'tfdt');
    const baseTime = tfdt
      ? u8[tfdt.body] === 1
        ? u64(u8, tfdt.body + 4)
        : u32(u8, tfdt.body + 4)
      : null;
    const run: TrafRun = { trackId, baseTime, base, samples: [] };
    let next = 0;
    let first = true;
    for (const trun of boxes(u8, traf.body, traf.end)) {
      if (trun.type !== 'trun') continue;
      const tflags = u32(u8, trun.body) & 0xffffff;
      const count = u32(u8, trun.body + 4);
      let q = trun.body + 8;
      let offset = first ? 0 : next;
      if (tflags & 0x1) {
        offset = i32(u8, q);
        q += 4;
      }
      if (tflags & 0x4) q += 4;
      first = false;
      for (let i = 0; i < count && q <= trun.end; i++) {
        let duration = defaultDuration;
        let size = defaultSize;
        let cts = 0;
        if (tflags & 0x100) {
          duration = u32(u8, q);
          q += 4;
        }
        if (tflags & 0x200) {
          size = u32(u8, q);
          q += 4;
        }
        if (tflags & 0x400) q += 4;
        if (tflags & 0x800) {
          cts = i32(u8, q);
          q += 4;
        }
        run.samples.push({ offset, size, duration, cts });
        offset += size;
      }
      next = offset;
    }
    out.push(run);
  }
  return out;
}

const SEGMENT_STARTS = new Set(['ftyp', 'styp', 'moov', 'moof', 'sidx', 'emsg', 'prft']);
const IGNORED = new Set(['ftyp', 'styp', 'sidx', 'free', 'skip', 'emsg', 'prft', 'uuid', 'mfra']);
/** Larger "boxes" found while resyncing are garbage. */
const MAX_BOX = 256 * 1024 * 1024;

export class Fmp4Demuxer implements Demuxer {
  private pending = new Uint8Array(0);
  /** Absolute stream position of `pending[0]`. */
  private position = 0;
  private tracks: Mp4Track[] = [];
  private audio: Mp4Track | null = null;
  private moof: { abs: number; runs: TrafRun[] } | null = null;
  /** Next decode time per track, for fragments without `tfdt`. */
  private nextTime = new Map<number, number>();
  private resyncing = false;

  push(bytes: Uint8Array): DemuxEvent[] {
    const events: DemuxEvent[] = [];
    let u8 = concat(this.pending, bytes);
    if (this.resyncing) {
      const at = this.findSegmentStart(u8);
      if (at < 0) {
        // Keep the last few bytes: a box header may straddle the next push.
        const keep = Math.min(u8.length, 7);
        this.position += u8.length - keep;
        this.pending = u8.slice(u8.length - keep);
        return events;
      }
      this.position += at;
      u8 = u8.subarray(at);
      this.resyncing = false;
    }
    let consumed = 0;
    for (const box of boxes(u8, 0, u8.length)) {
      // `size == 0` means "to the end of the stream": wait for more unless it is a known end.
      if (u32(u8, box.start) === 0) break;
      consumed = box.end;
      const abs = this.position + box.start;
      if (box.type === 'moov') {
        this.tracks = parseMoov(u8, box);
        for (const t of this.tracks) t.stbl = null;
        this.audio = this.tracks.find((t) => t.handler === 'soun') ?? null;
        this.moof = null;
        this.nextTime.clear();
        events.push({ type: 'init', audio: this.audio?.audio ?? null });
      } else if (box.type === 'moof') {
        this.moof = { abs, runs: parseMoof(u8, box, abs, this.tracks) };
      } else if (box.type === 'mdat') {
        this.readMdat(u8, box, abs, events);
      } else if (!IGNORED.has(box.type)) {
        events.push({ type: 'warning', message: `box ${box.type}` });
      }
    }
    this.position += consumed;
    this.pending = u8.slice(consumed);
    return events;
  }

  reset(): void {
    this.pending = new Uint8Array(0);
    this.moof = null;
  }

  resync(): void {
    this.reset();
    this.resyncing = true;
  }

  private readMdat(u8: Uint8Array, mdat: Box, mdatAbs: number, events: DemuxEvent[]): void {
    const moof = this.moof;
    this.moof = null;
    if (!moof) {
      events.push({ type: 'warning', message: 'mdat without moof' });
      return;
    }
    const audio = this.audio;
    for (const run of moof.runs) {
      const track = this.tracks.find((t) => t.id === run.trackId);
      let time = run.baseTime ?? this.nextTime.get(run.trackId) ?? 0;
      const samples: EncodedSample[] = [];
      for (const s of run.samples) {
        if (track === audio && audio) {
          const rel = run.base + s.offset - mdatAbs;
          if (rel < mdat.header || rel + s.size > mdat.size) {
            events.push({ type: 'warning', message: 'sample outside mdat' });
          } else {
            const at = mdat.start + rel;
            samples.push({
              time: (time + s.cts) / audio.timescale - audio.editShift,
              duration: s.duration / audio.timescale,
              data: u8.slice(at, at + s.size),
            });
          }
        }
        time += s.duration;
      }
      this.nextTime.set(run.trackId, time);
      if (samples.length > 0) events.push({ type: 'samples', samples });
    }
  }

  /** Offset of the first plausible box that starts a segment, or -1. */
  private findSegmentStart(u8: Uint8Array): number {
    for (let i = 0; i + 8 <= u8.length; i++) {
      const type = fourcc(u8, i + 4);
      if (!SEGMENT_STARTS.has(type)) continue;
      const size = u32(u8, i);
      if (size >= 8 && size <= MAX_BOX) return i;
    }
    return -1;
  }
}

/** Top-level boxes in a prefix of a file (the last may be cut off). */
export function topLevelBoxes(u8: Uint8Array): { type: string; start: number; size: number }[] {
  const out: { type: string; start: number; size: number }[] = [];
  let o = 0;
  while (o + 8 <= u8.length) {
    let size = u32(u8, o);
    const type = fourcc(u8, o + 4);
    if (size === 1) {
      if (o + 16 > u8.length) break;
      size = u64(u8, o + 8);
    }
    out.push({ type, start: o, size });
    if (size < 8) break;
    o += size;
  }
  return out;
}

/** A sample of a non-fragmented file: where it is and when. */
export interface IndexedSample {
  offset: number;
  size: number;
  /** Seconds. */
  time: number;
  duration: number;
}

export interface MovieAudio {
  config: AudioTrackConfig;
  samples: IndexedSample[];
}

/** The audio track of a whole `moov` box (`u8` starts with it), with its sample table. */
export function parseMovie(u8: Uint8Array): MovieAudio | null {
  for (const box of boxes(u8, 0, u8.length)) {
    if (box.type !== 'moov') continue;
    const track = parseMoov(u8, box).find((t) => t.handler === 'soun' && t.audio && t.stbl);
    if (!track?.audio || !track.stbl) return null;
    return { config: track.audio, samples: sampleTable(u8, track.stbl, track) };
  }
  return null;
}

function sampleTable(u8: Uint8Array, stbl: Box, track: Mp4Track): IndexedSample[] {
  const get = (t: string) => child(u8, stbl, t);
  const stsz = get('stsz');
  const stsc = get('stsc');
  const stco = get('stco');
  const co64 = get('co64');
  const stts = get('stts');
  const ctts = get('ctts');
  if (!stsz || !stsc || (!stco && !co64) || !stts) return [];
  const count = u32(u8, stsz.body + 8);
  const fixed = u32(u8, stsz.body + 4);
  const size = (i: number) => fixed || u32(u8, stsz.body + 12 + 4 * i);
  const chunks: number[] = [];
  if (stco) {
    const n = u32(u8, stco.body + 4);
    for (let i = 0; i < n; i++) chunks.push(u32(u8, stco.body + 8 + 4 * i));
  } else if (co64) {
    const n = u32(u8, co64.body + 4);
    for (let i = 0; i < n; i++) chunks.push(u64(u8, co64.body + 8 + 8 * i));
  }
  const runs: [firstChunk: number, perChunk: number][] = [];
  const nsc = u32(u8, stsc.body + 4);
  for (let i = 0; i < nsc; i++) {
    runs.push([u32(u8, stsc.body + 8 + 12 * i), u32(u8, stsc.body + 12 + 12 * i)]);
  }
  const durations: number[] = [];
  const nts = u32(u8, stts.body + 4);
  for (let i = 0; i < nts && durations.length < count; i++) {
    const n = u32(u8, stts.body + 8 + 8 * i);
    const d = u32(u8, stts.body + 12 + 8 * i);
    for (let k = 0; k < n && durations.length < count; k++) durations.push(d);
  }
  const offsets: number[] = [];
  if (ctts) {
    const version = u8[ctts.body] ?? 0;
    const n = u32(u8, ctts.body + 4);
    for (let i = 0; i < n && offsets.length < count; i++) {
      const c = u32(u8, ctts.body + 8 + 8 * i);
      const o = version === 1 ? i32(u8, ctts.body + 12 + 8 * i) : u32(u8, ctts.body + 12 + 8 * i);
      for (let k = 0; k < c && offsets.length < count; k++) offsets.push(o);
    }
  }
  const out: IndexedSample[] = [];
  let index = 0;
  let dts = 0;
  let run = 0;
  for (let c = 0; c < chunks.length && index < count; c++) {
    while (run + 1 < runs.length && c + 1 >= (runs[run + 1]?.[0] ?? Infinity)) run++;
    const perChunk = runs[run]?.[1] ?? 0;
    let offset = chunks[c] ?? 0;
    for (let k = 0; k < perChunk && index < count; k++, index++) {
      const s = size(index);
      const d = durations[index] ?? 0;
      out.push({
        offset,
        size: s,
        time: (dts + (offsets[index] ?? 0)) / track.timescale - track.editShift,
        duration: d / track.timescale,
      });
      offset += s;
      dts += d;
    }
  }
  return out;
}
