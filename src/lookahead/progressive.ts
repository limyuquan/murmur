/**
 * Progressive MP4 sources (`<video src="….mp4">`, no MediaSource): the file's own index tells
 * where each audio frame is, so the audio ahead of the playhead is read by byte range and decoded
 * like a SourceBuffer's. A few small reads find the index (`moov`, at the start or the end of the
 * file), one reads it; then only the byte ranges that hold audio near the playhead are read
 * (neighbouring frames are read together, interleaved video between them included when the gap is
 * small).
 *
 * Reading goes through a `RangeReader`: the page's own access (cookies included for a file on the
 * page's origin; a file from another origin only where its server allows the page to read it),
 * else the offscreen document's, where the browser applies the person's site permissions (CORS
 * without them). A read that fails is tried again later, a few times, before the source gives up.
 */

import { rangeBody } from './bytes';
import { type IndexedSample, type MovieAudio, parseMovie, topLevelBoxes } from './fmp4';
import { DISCONTINUITY_S, type MirrorSink } from './mirror';
import { HORIZON_S } from './scheduler';
import { SpanSet } from './spans';

export interface RangeReader {
  /** Bytes `[start, end)`, and the file's size when the server says. */
  read(start: number, end: number): Promise<{ bytes: Uint8Array; total: number | null }>;
}

/** A reader using `fetch` with a Range header. */
export function fetchReader(
  url: string,
  fetcher: typeof fetch = (...a) => fetch(...a),
): RangeReader {
  return {
    async read(start, end) {
      const response = await fetcher(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
      return rangeBody(response, start, end);
    },
  };
}

/**
 * Reads with `first`; once a read fails there, with `second` from then on (a cross-origin file is
 * read through the page, like the player's own requests, unless its server refuses that).
 */
export function fallbackReader(first: RangeReader, second: RangeReader): RangeReader {
  let current = first;
  return {
    async read(start, end) {
      if (current === second) return second.read(start, end);
      try {
        return await first.read(start, end);
      } catch {
        current = second;
        return second.read(start, end);
      }
    },
  };
}

/** Failed reads in a row before a source gives up; the waits between them double from this, ms. */
const MAX_RETRIES = 5;
const RETRY_MS = 2000;

/** Frames read together when the bytes between them are fewer than this. */
const MERGE_GAP = 64 * 1024;
/** Longest single read. */
const MAX_READ = 4 * 1024 * 1024;
/** Read this much audio per step. */
const STEP_S = 30;
const HEAD = 64 * 1024;
const MAX_WALK = 32;

export class ProgressiveSource {
  private movie: Promise<MovieAudio | null> | null = null;
  private readonly done = new SpanSet(DISCONTINUITY_S);
  private busy = false;
  private lastEnd: number | null = null;
  /** Failed reads in a row, and when the next try may go. */
  private retries = 0;
  private retryAt = 0;
  /** Why the source gave up for good (no audio track, a broken index, reads failing on). */
  failed: string | null = null;

  constructor(
    private readonly reader: RangeReader,
    private readonly sink: MirrorSink,
    private readonly horizon = HORIZON_S,
    private readonly now: () => number = Date.now,
  ) {}

  /** Reads and decodes what's missing from the playhead to the horizon (one step at a time). */
  async ensure(playhead: number): Promise<void> {
    if (this.busy || this.failed || this.now() < this.retryAt) return;
    this.busy = true;
    try {
      const movie = await this.index();
      if (!movie) return;
      const until = playhead + this.horizon;
      let from = Math.max(0, playhead - 1);
      const covered = this.done.at(from);
      if (covered) from = covered[1];
      if (from >= until) return;
      const to = Math.min(until, from + STEP_S);
      const samples = movie.samples.between(from, to);
      if (samples.length === 0) {
        this.done.add(from, to);
        return;
      }
      for (const range of groupRanges(samples)) {
        const { bytes } = await this.reader.read(range.start, range.end);
        for (const s of range.samples) {
          const at = s.offset - range.start;
          if (at < 0 || at + s.size > bytes.length) continue;
          const jump = this.lastEnd === null || Math.abs(s.time - this.lastEnd) > DISCONTINUITY_S;
          this.sink.frame(s.time, s.duration, bytes.subarray(at, at + s.size), jump);
          this.lastEnd = s.time + s.duration;
        }
      }
      const first = samples[0] as IndexedSample;
      const last = samples.at(-1) as IndexedSample;
      this.done.add(first.time, last.time + last.duration);
      this.retries = 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A broken index won't mend; a read (a 503, a timeout) may work later.
      if ((err instanceof Error && err.name === 'DemuxError') || ++this.retries > MAX_RETRIES) {
        this.failed = message;
      } else {
        this.retryAt = this.now() + RETRY_MS * 2 ** (this.retries - 1);
      }
    } finally {
      this.busy = false;
    }
  }

  /** Seconds of audio read so far. */
  get spans(): readonly (readonly [number, number])[] {
    return this.done.list;
  }

  private index(): Promise<MovieAudio | null> {
    this.movie ??= this.readIndex().then(
      (movie) => {
        if (!movie) this.failed = 'no audio track';
        else this.sink.config(movie.config);
        return movie;
      },
      (err: unknown) => {
        // Read again next time.
        this.movie = null;
        throw err;
      },
    );
    return this.movie;
  }

  private async readIndex(): Promise<MovieAudio | null> {
    const head = await this.reader.read(0, HEAD);
    const boxes = topLevelBoxes(head.bytes);
    let moov = boxes.find((b) => b.type === 'moov') ?? null;
    if (!moov) {
      // Walk the top-level boxes with tiny reads until the index.
      const last = boxes.at(-1);
      let offset = last ? last.start + last.size : head.bytes.length;
      for (let i = 0; i < MAX_WALK; i++) {
        if (head.total !== null && offset >= head.total) break;
        const { bytes } = await this.reader.read(offset, offset + 16);
        const box = topLevelBoxes(bytes)[0];
        if (!box || box.size < 8) break;
        if (box.type === 'moov') {
          moov = { type: 'moov', start: offset, size: box.size };
          break;
        }
        offset += box.size;
      }
    }
    if (!moov) return null;
    const inHead = moov.start + moov.size <= head.bytes.length;
    const bytes = inHead
      ? head.bytes.subarray(moov.start, moov.start + moov.size)
      : (await this.reader.read(moov.start, moov.start + moov.size)).bytes;
    return parseMovie(bytes);
  }
}

/** Neighbouring frames grouped into reads. */
export function groupRanges(
  samples: readonly IndexedSample[],
): { start: number; end: number; samples: IndexedSample[] }[] {
  const sorted = [...samples].sort((a, b) => a.offset - b.offset);
  const out: { start: number; end: number; samples: IndexedSample[] }[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    const end = s.offset + s.size;
    if (last && s.offset - last.end < MERGE_GAP && end - last.start <= MAX_READ) {
      last.end = Math.max(last.end, end);
      last.samples.push(s);
    } else {
      out.push({ start: s.offset, end, samples: [s] });
    }
  }
  // Decode in time order within each read.
  for (const r of out) r.samples.sort((a, b) => a.time - b.time);
  return out.sort((a, b) => (a.samples[0]?.time ?? 0) - (b.samples[0]?.time ?? 0));
}
