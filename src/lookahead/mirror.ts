/**
 * Mirrors one SourceBuffer from what the page did to it (tee.ts reports it): demuxes the audio it
 * was given, puts each frame on the video's timeline the way MSE does (`timestampOffset` at the
 * time of the append, frames outside the append window dropped), and marks where the stream
 * jumps (a seek, a gap, a re-appended range), so a fresh decoder starts there.
 */
import { Fmp4Demuxer } from './fmp4';
import { kindOf, type TrackKind } from './kind';
import type { AudioTrackConfig, DemuxEvent, Demuxer } from './types';
import { WebmDemuxer } from './webm';

/** A jump bigger than this between one frame's end and the next frame starts a new run. */
export { kindOf, type TrackKind };

export const DISCONTINUITY_S = 0.05;
/** With no frame durations, a step longer than this between frames counts as a jump. */
const UNKNOWN_FRAME_S = 0.25;

/** Whether Murmur can demux what this MIME type carries. */
export function demuxerFor(mime: string): Demuxer | null {
  const t = mime.toLowerCase();
  if (t.includes('webm') || t.includes('matroska')) return new WebmDemuxer();
  if (t.includes('mp4')) return new Fmp4Demuxer();
  return null;
}

export interface AppendInfo {
  bytes: Uint8Array;
  /** `timestampOffset` when it was appended. */
  timestampOffset: number;
  appendWindowStart: number;
  appendWindowEnd: number;
  /** `mode === 'sequence'`: frames are placed one after another, whatever their times. */
  sequence: boolean;
  /** Bytes were skipped before this append: look for the next segment start. */
  resync?: boolean;
}

export interface MirrorSink {
  /** A new audio config (or none: no audio here, or one Murmur can't decode). */
  config(config: AudioTrackConfig | null): void;
  /** One frame on the video's timeline. `jump`: it doesn't follow the previous one. */
  frame(time: number, duration: number | null, data: Uint8Array, jump: boolean): void;
  /** Something was skipped (counted). */
  warn?(message: string): void;
  /**
   * The bytes broke the demuxer's limits (`DemuxError`): nothing more is read from this
   * SourceBuffer, and what it had is given up on.
   */
  failed?(message: string): void;
}

export class SourceBufferMirror {
  private demuxer: Demuxer | null;
  private config: AudioTrackConfig | null = null;
  /** Where the next frame should start if the stream is continuous. */
  private next: number | null = null;
  /** Start of the last frame (for frames of unknown duration). */
  private last: number | null = null;
  /** The bytes broke the demuxer's limits: nothing more is read, whatever comes. */
  private gaveUp = false;

  constructor(
    private mime: string,
    private readonly sink: MirrorSink,
  ) {
    this.demuxer = demuxerFor(mime);
    if (!this.demuxer) sink.warn?.(`unsupported ${mime}`);
  }

  get kind(): TrackKind {
    return kindOf(this.mime);
  }

  append(info: AppendInfo): void {
    const demuxer = this.demuxer;
    if (!demuxer) return;
    if (info.resync) {
      demuxer.resync();
      this.next = null;
      this.last = null;
    }
    let events: DemuxEvent[];
    try {
      events = demuxer.push(info.bytes);
    } catch (err) {
      // Never into the session: this SourceBuffer is given up on, the live path covers it.
      this.demuxer = null;
      this.config = null;
      this.gaveUp = true;
      this.sink.failed?.(err instanceof Error ? err.message : String(err));
      return;
    }
    for (const event of events) {
      if (event.type === 'warning') {
        this.sink.warn?.(event.message);
      } else if (event.type === 'init') {
        this.config = event.audio;
        this.next = null;
        this.last = null;
        this.sink.config(event.audio);
      } else if (this.config && !this.config.encrypted) {
        if (info.sequence) {
          this.sink.warn?.('sequence mode');
          continue;
        }
        for (const s of event.samples) {
          const time = s.time + info.timestampOffset;
          const end = time + (s.duration ?? 0);
          if (end <= info.appendWindowStart || time >= info.appendWindowEnd) continue;
          const jump =
            this.next !== null
              ? Math.abs(time - this.next) > DISCONTINUITY_S
              : this.last === null || time <= this.last || time - this.last > UNKNOWN_FRAME_S;
          this.sink.frame(time, s.duration, s.data, jump);
          this.next = s.duration !== null ? end : null;
          this.last = time;
        }
      }
    }
  }

  /** `abort()`: the segment being parsed is dropped; the next frame starts a new run. */
  abort(): void {
    this.demuxer?.reset();
    this.next = null;
    this.last = null;
  }

  /** `changeType()`: another container or codec from the next init segment on. */
  changeType(mime: string): void {
    this.mime = mime;
    this.demuxer = this.gaveUp ? null : demuxerFor(mime);
    this.config = null;
    this.next = null;
    this.last = null;
    if (!this.demuxer) this.sink.warn?.(`unsupported ${mime}`);
  }
}
