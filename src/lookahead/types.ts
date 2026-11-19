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

/** A streaming demuxer for what a page appends to one SourceBuffer. */
export interface Demuxer {
  /** Feeds the next bytes (any slice; boxes and elements may span pushes). */
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
