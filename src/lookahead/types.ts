/**
 * Shared types for lookahead: subtitles made from audio the page's player has already buffered,
 * ahead of the playhead. See src/lookahead/README.md for how the parts fit.
 */

/** How to decode a track with WebCodecs' `AudioDecoder`. */
export interface AudioTrackConfig {
  /** WebCodecs codec string: `mp4a.40.2`, `opus`, `vorbis`, `flac`, `mp3`. */
  codec: string;
  sampleRate: number;
  channels: number;
  /** Codec setup bytes (AAC AudioSpecificConfig, OpusHead, Vorbis/FLAC headers), if any. */
  description: Uint8Array | null;
  /** Protected (CENC, WebM ContentEncryption): nothing to decode. */
  encrypted: boolean;
}

/** One coded audio frame, timed on its container's timeline (before `timestampOffset`). */
export interface EncodedSample {
  /** Presentation time, seconds. */
  time: number;
  /** Seconds, when the container says (WebM often doesn't: then from the Opus packet, or null). */
  duration: number | null;
  data: Uint8Array;
}

export type DemuxEvent =
  /** A new initialization: the audio track's config (null: no audio track in this stream). */
  | { type: 'init'; audio: AudioTrackConfig | null }
  /** Audio frames, in order. */
  | { type: 'samples'; samples: EncodedSample[] }
  /** Something the demuxer skipped or couldn't read (counted for diagnostics). */
  | { type: 'warning'; message: string };

/**
 * Bytes a demuxer won't follow: sizes or counts past its limits (a corrupt stream, or bytes made
 * to exhaust memory). The SourceBuffer is given up on; the live path covers it.
 */
export class DemuxError extends Error {
  override readonly name = 'DemuxError';
}

/** Limits for what a page's bytes may claim, so they can't exhaust memory or time. */
export const DEMUX_LIMITS = {
  /** An index or fragment header (`moov`, `moof`), or a WebM element read whole. */
  headerBytes: 16 * 1024 * 1024,
  /** Any box or element buffered whole (an `mdat` of a muxed fragment included). */
  boxBytes: 128 * 1024 * 1024,
  /** Samples in one fragment (10 s of 48 kHz AAC is 469). */
  fragmentSamples: 65_536,
  /** Samples in a progressive file's index (about 6 h of AAC). */
  indexSamples: 1_000_000,
} as const;

/** A streaming demuxer for what a page appends to one SourceBuffer. */
export interface Demuxer {
  /**
   * Feeds the next bytes (any slice; boxes and elements may span pushes). Throws `DemuxError`
   * when they claim more than `DEMUX_LIMITS` allows.
   */
  push(bytes: Uint8Array): DemuxEvent[];
  /** `SourceBuffer.abort()`: drop a partly parsed segment; the init stays. */
  reset(): void;
  /**
   * Bytes were skipped before the next push: drop the partial state and look for the start of a
   * segment (a fragment, a cluster, or a new init) before parsing again.
   */
  resync(): void;
}

/** A span of media time, seconds `[start, end)`. */
export type Span = readonly [start: number, end: number];
