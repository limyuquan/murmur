/**
 * Lookahead in the offscreen document, for the session's tab: takes what the overlays forward
 * (the tee's events, playhead reports), mirrors each SourceBuffer (mirror.ts), decodes its audio
 * (decode.ts) into 16 kHz PCM per MediaSource (pcm.ts), reads progressive sources by range
 * (progressive.ts), and runs the speech pipeline over it ahead of the playhead (runner.ts).
 * Cues, coverage and drops go to the tab's overlays; the live path is told when to step aside.
 *
 * Memory: decoded audio is capped at `PCM_CAP_S` seconds over all timelines (stretches far from
 * the playhead go first, behind it before ahead of it). Cues are kept by the overlays.
 */
import type { OverlayMessage } from '@/messaging/protocol';
import type { Pipeline } from '@/pipeline/pipeline';
import type { Cue } from '@/pipeline/types';
import { fromBase64 } from './bytes';
import { LagCalibrator, type LagEstimate } from './calibrate';
import { AudioRuns, type CreateDecoder, webCodecsDecoder } from './decode';
import { SourceBufferMirror } from './mirror';
import { BLOCK_BYTES, PcmTimeline, toSample } from './pcm';
import { fallbackReader, fetchReader, ProgressiveSource, type RangeReader } from './progressive';
import type { PlayheadReport, TeeWire } from './protocol';
import { LookaheadRunner, type PipelineHooks } from './runner';
import { playheadAt } from './scheduler';
import type { Span } from './types';

/** Decoded audio kept, at most, seconds (16-bit, 16 kHz: 32 KB/s; 10 min ≈ 19 MB). */
export const PCM_CAP_S = 600;
/**
 * Lookahead cues kept here too, at most (those far from the playhead go first, and their stretch
 * is done again when it comes near): an overlay that comes back (the page reloaded) is given
 * them again. Below the overlay's own bound (`MAX_MEDIA_CUES`).
 */
export const KEPT_CUES = 2500;
/** Distinct warnings kept, and their length (for diagnostics only). */
const MAX_WARNINGS = 50;
const MAX_WARNING_CHARS = 120;
/** A playing video's report wins over a paused one's from another frame for this long. */
const PLAYING_WINS_MS = 3000;

/** The part of an overlay port the host uses (OffscreenHost's `OverlayPort`). */
export interface LookaheadPort {
  postMessage(message: OverlayMessage): void;
}

export interface LookaheadDeps {
  /** To every overlay of the session's tab. */
  post(message: OverlayMessage): void;
  /** A pipeline over the session's engines for one lookahead job; null when not ready. */
  createPipeline(
    media: { timeline: string; idPrefix: string },
    hooks: PipelineHooks,
  ): Pipeline | null;
  /** Live recognition should pause (lookahead is far enough ahead) or resume. */
  setLivePaused(paused: boolean): void;
  /**
   * How long after the page plays a moment the person hears it, seconds: measured from the live
   * frames (`onLiveFrame`, calibrate.ts) when true, else none (the audio isn't played back).
   */
  measureLag: boolean;
  /** Sees every lookahead cue (e2e builds log them). */
  onCue?(cue: Cue): void;
  createDecoder?: CreateDecoder;
  fetch?: typeof fetch;
  now?(): number;
}

type AppendWire = Extract<TeeWire, { t: 'append' }>;

interface Buffer {
  ms: string;
  mime: string;
  appends: number;
  mirror: SourceBufferMirror;
  runs: AudioRuns;
  /**
   * A video plays its MediaSource (a report named it): only then is its audio decoded. Until
   * then appends are held, undecoded (a live stream, which gets no timeline, is never decoded).
   */
  active: boolean;
  held: AppendWire[];
  heldBytes: number;
  /** Held appends were let go: the first one kept starts mid-stream. */
  heldCut: boolean;
  /** The latest init segment seen while held (base64), to start decoding with. */
  init: string | null;
  /** When it was last appended to, or its MediaSource last played (`now()`). */
  seenAt: number;
}

/** Undecoded appends held per SourceBuffer until a video plays it, at most (base64 chars). */
const HELD_CHARS = 8 * 1024 * 1024;
/** A SourceBuffer, or progressive source, not appended to or played for this long is let go, ms. */
const STALE_MS = 5 * 60_000;

interface PortState {
  frameUrl: string;
  report: PlayheadReport | null;
  /** Content keys this overlay was given the kept cues of. */
  keys: Set<string>;
  /** Answers to `fetch` requests sent to this frame. */
  waiting: Map<number, (wire: Extract<TeeWire, { t: 'fetched' }>) => void>;
}

export interface LookaheadSnapshot {
  /** Decoded audio per timeline, seconds. */
  decoded: Record<string, Span[]>;
  /** Finished subtitles per content key. */
  processed: Record<string, readonly Span[]>;
  target: { timeline: string; key: string; ad: boolean; playhead: number } | null;
  lead: number;
  livePaused: boolean;
  decodedSeconds: number;
  warnings: string[];
  /** Each SourceBuffer mirrored: MIME type, appends seen, decoder problems. */
  buffers: { sb: string; ms: string; mime: string; appends: number; errors: string[] }[];
  /** Why recent jobs were dropped. */
  drops: string[];
  /** The playback lag in use, and how it was measured (null: none, the audio isn't played back). */
  lag: LagEstimate | null;
}

export class LookaheadHost {
  private readonly buffers = new Map<string, Buffer>();
  private readonly pcm = new Map<string, PcmTimeline>();
  private readonly progressive = new Map<
    string,
    { source: ProgressiveSource; runs: AudioRuns; seenAt: number }
  >();
  private readonly ports = new Map<LookaheadPort, PortState>();
  private readonly runner: LookaheadRunner;
  private readonly now: () => number;
  private readonly warnings = new Map<string, number>();
  /** Lookahead cues by content key, then id (`KEPT_CUES` in all). */
  private readonly kept = new Map<string, Map<string, Cue>>();
  private keptCount = 0;
  private target: { port: LookaheadPort; report: PlayheadReport } | null = null;
  private fetchId = 0;
  private announced = false;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly calibrator: LagCalibrator | null;

  constructor(private readonly deps: LookaheadDeps) {
    this.calibrator = deps.measureLag ? new LagCalibrator() : null;
    this.now = deps.now ?? (() => performance.timeOrigin + performance.now());
    this.runner = new LookaheadRunner({
      createPipeline: (media, hooks) => deps.createPipeline(media, hooks),
      pcm: (timeline) => this.pcm.get(timeline),
      onCue: (cue) => {
        deps.onCue?.(cue);
        this.keep(cue);
        deps.post({ type: 'cue', cue });
      },
      onCoverage: (key, spans) =>
        deps.post({ type: 'coverage', timeline: key, spans: spans.map(([s, e]) => [s, e]) }),
      onDrop: (key, start, end) => {
        this.unkeep(key, start, end);
        deps.post({ type: 'drop', timeline: key, start, end });
      },
      onLivePaused: (paused) => deps.setLivePaused(paused),
      now: this.now,
    });
  }

  /** The engines are ready (or changed): look for work. */
  kick(): void {
    this.runner.kick();
  }

  /** A live frame of the tab's audio (16 kHz), heard at `epochMs`: for measuring the lag. */
  onLiveFrame(samples: Float32Array, epochMs: number): void {
    if (this.stopped || !this.announced) return;
    this.calibrator?.onLiveFrame(samples, epochMs);
  }

  /** How long after the page plays a moment the person hears it, seconds. */
  get lagS(): number {
    return this.calibrator?.lagS ?? 0;
  }

  /** A message from an overlay: the tee's events. */
  onTee(port: LookaheadPort, frameUrl: string, wire: TeeWire): void {
    if (this.stopped) return;
    this.portState(port, frameUrl);
    try {
      this.apply(port, wire);
    } catch (err) {
      this.warn(`tee: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A message from an overlay: where its video is. */
  onPlayhead(port: LookaheadPort, frameUrl: string, given: PlayheadReport): void {
    if (this.stopped) return;
    // On this document's clock: the page's may disagree (another document, reloaded, asleep).
    // The message took milliseconds, so the time it gives is the time now, near enough.
    const report = { ...given, at: this.now() };
    const state = this.portState(port, frameUrl);
    state.report = report;
    if (report.timeline) {
      const { time, rate, paused, at } = report;
      this.calibrator?.onPlayhead(report.timeline, { time, rate, paused, at });
    }
    if (!report.timeline || !report.key) {
      if (this.target?.port === port) this.retarget(null);
      return;
    }
    // An overlay new to this video (the page reloaded, or navigated back to it): what was made
    // for it before, so the stretches already done don't come up blank.
    if (!state.keys.has(report.key)) {
      state.keys.add(report.key);
      this.replay(port, report.key);
    }
    const current = this.target;
    const keep =
      current &&
      current.port !== port &&
      !current.report.paused &&
      report.paused &&
      this.now() - current.report.at < PLAYING_WINS_MS;
    if (!keep) this.retarget({ port, report });
    if (!report.ad) this.activate(report.timeline);
    if (report.timeline.startsWith('p:')) this.feedProgressive(port, state, report);
  }

  /** An overlay went away. */
  removePort(port: LookaheadPort): void {
    this.ports.delete(port);
    if (this.target?.port === port) this.retarget(null);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.ticker) clearInterval(this.ticker);
    for (const b of this.buffers.values()) b.runs.end();
    for (const p of this.progressive.values()) p.runs.end();
    await this.runner.stop();
  }

  /** Whether lookahead is making subtitles now, on the session's models. */
  get busy(): boolean {
    return this.runner.busy;
  }

  snapshot(): LookaheadSnapshot {
    const decoded: Record<string, Span[]> = {};
    for (const [id, t] of this.pcm) decoded[id] = t.coverage();
    const processed: Record<string, readonly Span[]> = {};
    const key = this.target?.report.key;
    if (key) processed[key] = this.runner.spans(key);
    const t = this.target?.report;
    let decodedSeconds = 0;
    for (const b of this.buffers.values()) decodedSeconds += b.runs.decodedSeconds;
    for (const p of this.progressive.values()) decodedSeconds += p.runs.decodedSeconds;
    return {
      decoded,
      processed,
      target:
        t?.timeline && t.key
          ? { timeline: t.timeline, key: t.key, ad: t.ad, playhead: playheadAt(t, this.now()) }
          : null,
      lead: this.runner.leadS,
      livePaused: this.runner.livePaused,
      decodedSeconds,
      warnings: [...this.warnings.keys()],
      drops: [...this.runner.drops],
      lag: this.calibrator?.estimate ?? null,
      buffers: [...this.buffers].map(([sb, b]) => ({
        sb,
        ms: b.ms,
        mime: b.mime,
        appends: b.appends,
        errors: b.runs.errors,
      })),
    };
  }

  private portState(port: LookaheadPort, frameUrl: string): PortState {
    let state = this.ports.get(port);
    if (!state) {
      state = { frameUrl, report: null, keys: new Set(), waiting: new Map() };
      this.ports.set(port, state);
      if (!this.announced) {
        this.announced = true;
        this.ticker = setInterval(() => this.tick(), 500);
      }
      // Every overlay of the tab learns lookahead runs (and when to show its cues).
      this.deps.post({ type: 'lookahead', lagS: this.lagS });
    }
    return state;
  }

  private retarget(next: { port: LookaheadPort; report: PlayheadReport } | null): void {
    this.target = next;
    const r = next?.report;
    this.runner.setTarget(
      r?.timeline && r.key
        ? {
            timeline: r.timeline,
            key: r.key,
            ad: r.ad,
            playhead: { time: r.time, rate: r.rate, paused: r.paused, at: r.at },
            duration: r.duration ?? null,
          }
        : null,
    );
  }

  private tick(): void {
    this.evict();
    this.prune();
    const lag = this.calibrator?.attempt(this.now(), (timeline) => this.pcm.get(timeline));
    if (lag != null) this.deps.post({ type: 'lookahead', lagS: lag });
    this.runner.kick();
    const target = this.target;
    if (target?.report.timeline?.startsWith('p:')) {
      const state = this.ports.get(target.port);
      if (state) this.feedProgressive(target.port, state, target.report);
    }
  }

  private apply(port: LookaheadPort, wire: TeeWire): void {
    switch (wire.t) {
      case 'url':
        return;
      case 'sb': {
        if (this.buffers.has(wire.sb)) return;
        const timeline = wire.ms;
        const runs = new AudioRuns(
          (start, samples) => this.write(timeline, start, samples),
          this.deps.createDecoder ?? webCodecsDecoder,
        );
        const mirror = new SourceBufferMirror(wire.mime, {
          config: (c) => runs.config(c),
          frame: (time, duration, data, jump) => runs.frame(time, duration, data, jump),
          warn: (m) => this.warn(m),
          failed: (m) => {
            this.warn(`gave up on a SourceBuffer: ${m}`);
            runs.end();
          },
        });
        this.buffers.set(wire.sb, {
          ms: wire.ms,
          mime: wire.mime,
          appends: 0,
          mirror,
          runs,
          active: this.playing(wire.ms),
          held: [],
          heldBytes: 0,
          heldCut: false,
          init: null,
          seenAt: this.now(),
        });
        return;
      }
      case 'append': {
        const b = this.buffers.get(wire.sb);
        if (!b || b.mirror.kind === 'video') return;
        b.appends++;
        b.seenAt = this.now();
        if (b.active) this.feed(b, wire);
        else this.hold(b, wire);
        return;
      }
      case 'remove': {
        const b = this.buffers.get(wire.sb);
        if (b) this.removed(b.ms, wire.start, wire.end ?? Number.POSITIVE_INFINITY);
        return;
      }
      case 'abort':
        this.buffers.get(wire.sb)?.mirror.abort();
        return;
      case 'ctype':
        this.buffers.get(wire.sb)?.mirror.changeType(wire.mime);
        return;
      case 'sbrm': {
        const b = this.buffers.get(wire.sb);
        b?.runs.end();
        this.buffers.delete(wire.sb);
        return;
      }
      case 'fetched': {
        const state = this.ports.get(port);
        const done = state?.waiting.get(wire.id);
        state?.waiting.delete(wire.id);
        done?.(wire);
        return;
      }
    }
  }

  /** Gives one overlay the kept cues of `key`, then where they are finished. */
  private replay(port: LookaheadPort, key: string): void {
    for (const cue of this.kept.get(key)?.values() ?? []) port.postMessage({ type: 'cue', cue });
    const spans = this.runner.spans(key);
    if (spans.length > 0) {
      port.postMessage({ type: 'coverage', timeline: key, spans: spans.map(([s, e]) => [s, e]) });
    }
  }

  private keep(cue: Cue): void {
    const key = cue.media?.timeline;
    if (!key) return;
    let cues = this.kept.get(key);
    if (!cues) {
      cues = new Map();
      this.kept.set(key, cues);
    }
    if (!cues.has(cue.id)) this.keptCount++;
    cues.set(cue.id, cue);
    if (this.keptCount > KEPT_CUES) this.trimKept();
  }

  /** Drops kept cues of `key` starting in `[start, end)`. */
  private unkeep(key: string, start: number, end: number): void {
    const cues = this.kept.get(key);
    if (!cues) return;
    for (const [id, cue] of cues) {
      const at = cue.media?.start ?? 0;
      if (at >= start && at < end) {
        cues.delete(id);
        this.keptCount--;
      }
    }
  }

  /**
   * Lets the kept cues farthest from the playhead go (other videos first), and has their
   * stretches done again when the playhead comes near (the overlays drop them as well).
   */
  private trimKept(): void {
    const t = this.target?.report;
    const key = t?.key ?? null;
    const playhead = t ? playheadAt(t, this.now()) : 0;
    const all: Cue[] = [];
    for (const cues of this.kept.values()) all.push(...cues.values());
    const distance = (c: Cue) =>
      c.media?.timeline !== key
        ? Number.POSITIVE_INFINITY
        : Math.abs((c.media?.start ?? 0) - playhead);
    all.sort((a, b) => distance(b) - distance(a));
    for (const cue of all) {
      if (this.keptCount <= KEPT_CUES * 0.9) break;
      const media = cue.media;
      if (!media) continue;
      if (!this.runner.forget(media.timeline, media.start, media.end)) continue;
      this.kept.get(media.timeline)?.delete(cue.id);
      this.keptCount--;
      this.deps.post({
        type: 'drop',
        timeline: media.timeline,
        start: media.start,
        end: media.start + 1e-6,
      });
    }
    for (const [k, cues] of this.kept) if (cues.size === 0) this.kept.delete(k);
  }

  private feed(b: Buffer, wire: AppendWire): void {
    b.mirror.append({
      bytes: fromBase64(wire.bytes),
      timestampOffset: wire.tso,
      appendWindowStart: wire.aws,
      appendWindowEnd: wire.awe ?? Number.POSITIVE_INFINITY,
      sequence: wire.sequence,
      ...(wire.resync ? { resync: true } : {}),
    });
  }

  /** Keeps an append, undecoded, until a video plays its MediaSource (the latest only). */
  private hold(b: Buffer, wire: AppendWire): void {
    // An init segment starts the append (MSE inits are small): kept apart, to start with.
    const head = fromBase64(wire.bytes.slice(0, 64));
    if (startsInit(head, b.mime) && wire.bytes.length <= 1024 * 1024) b.init = wire.bytes;
    b.held.push(wire);
    b.heldBytes += wire.bytes.length;
    while (b.heldBytes > HELD_CHARS && b.held.length > 1) {
      const old = b.held.shift() as AppendWire;
      b.heldBytes -= old.bytes.length;
      b.heldCut = true;
    }
  }

  /** Whether a report names `ms` as what a video plays (not an ad). */
  private playing(ms: string): boolean {
    for (const state of this.ports.values()) {
      if (state.report?.timeline === ms && !state.report.ad) return true;
    }
    return false;
  }

  /** A video plays `ms`: decode its SourceBuffers' audio, what was held first. */
  private activate(ms: string): void {
    for (const b of this.buffers.values()) {
      if (b.ms !== ms) continue;
      b.seenAt = this.now();
      if (b.active) continue;
      b.active = true;
      const held = b.held;
      b.held = [];
      b.heldBytes = 0;
      const first = held[0];
      const startsWithInit = first !== undefined && first.bytes === b.init;
      if (b.init && !startsWithInit) {
        this.feed(b, {
          t: 'append',
          sb: '',
          bytes: b.init,
          tso: 0,
          aws: 0,
          awe: null,
          sequence: false,
          resync: true,
        });
      }
      held.forEach((wire, i) => {
        this.feed(
          b,
          i === 0 && (b.heldCut || b.init) && !startsWithInit ? { ...wire, resync: true } : wire,
        );
      });
      b.init = null;
    }
  }

  private write(timeline: string, start: number, samples: Float32Array): void {
    let pcm = this.pcm.get(timeline);
    if (!pcm) {
      pcm = new PcmTimeline();
      this.pcm.set(timeline, pcm);
    }
    pcm.write(start, samples);
    if (this.target?.report.timeline === timeline) this.runner.kick();
  }

  /**
   * `SourceBuffer.remove()`: ahead of the playhead the audio is being replaced (another
   * language, a re-fetch), so what was made from it goes too; behind it, only the audio goes
   * (the cues were real).
   */
  private removed(timeline: string, start: number, end: number): void {
    const pcm = this.pcm.get(timeline);
    pcm?.remove(toSample(start), Number.isFinite(end) ? toSample(end) : Number.MAX_SAFE_INTEGER);
    const t = this.target?.report;
    if (!t || t.timeline !== timeline || !t.key) return;
    const playhead = playheadAt(t, this.now());
    const from = Math.max(start, playhead);
    if (end <= from) return;
    const to = Number.isFinite(end) ? end : Number.MAX_SAFE_INTEGER;
    this.runner.invalidate(t.key, from, to);
    // Made again from the new audio. Until then the overlays keep showing what they have:
    // players that clear their whole buffer on a seek (Shaka, dash.js) append the same audio
    // again, and seeking back should show kept cues at once.
    this.unkeep(t.key, from, to);
    this.deps.post({ type: 'drop', timeline: t.key, start: from, end: to, keep: true });
  }

  private feedProgressive(port: LookaheadPort, state: PortState, report: PlayheadReport): void {
    const timeline = report.timeline;
    if (!timeline?.startsWith('p:')) return;
    let entry = this.progressive.get(timeline);
    if (!entry) {
      const url = timeline.slice(2);
      const runs = new AudioRuns(
        (start, samples) => this.write(timeline, start, samples),
        this.deps.createDecoder ?? webCodecsDecoder,
      );
      // Through the page first, like the player's own requests (another origin's server may not
      // let the page read it: then the offscreen document reads it).
      const page = this.pageReader(port, state, url);
      const reader = sameOrigin(url, state.frameUrl)
        ? page
        : fallbackReader(page, fetchReader(url, this.deps.fetch));
      entry = { source: new ProgressiveSource(reader, runs), runs, seenAt: this.now() };
      this.progressive.set(timeline, entry);
    }
    const source = entry.source;
    void source.ensure(playheadAt(report, this.now())).then(() => {
      if (source.failed) this.warn(`progressive: ${source.failed}`);
    });
  }

  /** Reads through the page (the relay), with its cookies and origin. */
  private pageReader(port: LookaheadPort, state: PortState, url: string): RangeReader {
    return {
      read: (start, end) =>
        new Promise((resolve, reject) => {
          const id = ++this.fetchId;
          const timer = setTimeout(() => {
            state.waiting.delete(id);
            reject(new Error('The page did not answer.'));
          }, 20_000);
          state.waiting.set(id, (wire) => {
            clearTimeout(timer);
            if (wire.bytes === undefined) reject(new Error(wire.error ?? 'read failed'));
            else resolve({ bytes: fromBase64(wire.bytes), total: wire.total ?? null });
          });
          port.postMessage({ type: 'fetch', id, url, start, end });
        }),
    };
  }

  /**
   * Lets go of SourceBuffers and progressive sources nothing has used for `STALE_MS` (players
   * that drop a MediaSource by changing `src` never remove its buffers): their decoders, demuxer
   * state and held bytes.
   */
  private prune(): void {
    const now = this.now();
    const target = this.target?.report.timeline;
    for (const [sb, b] of this.buffers) {
      if (b.ms === target) b.seenAt = now;
      else if (now - b.seenAt > STALE_MS) {
        b.runs.end();
        this.buffers.delete(sb);
      }
    }
    for (const [timeline, p] of this.progressive) {
      if (timeline === target) p.seenAt = now;
      else if (now - p.seenAt > STALE_MS) {
        p.runs.end();
        this.progressive.delete(timeline);
      }
    }
  }

  /** Keeps decoded audio under the cap: other timelines first, then far from the playhead. */
  private evict(): void {
    let total = 0;
    for (const t of this.pcm.values()) total += t.bytes;
    const cap = PCM_CAP_S * BLOCK_BYTES;
    if (total <= cap) return;
    const target = this.target?.report;
    for (const [id, t] of this.pcm) {
      if (total <= cap) return;
      if (id === target?.timeline) continue;
      total -= t.bytes;
      this.pcm.delete(id);
    }
    const active = target?.timeline ? this.pcm.get(target.timeline) : undefined;
    if (!active || !target) return;
    const sample = toSample(playheadAt(target, this.now()));
    for (const index of active.evictionOrder(sample)) {
      if (total <= cap) break;
      active.dropBlock(index);
      total -= BLOCK_BYTES;
    }
  }

  /** Counts a warning. The texts come from the page's bytes, so both are bounded. */
  private warn(message: string): void {
    const key =
      message.length > MAX_WARNING_CHARS ? `${message.slice(0, MAX_WARNING_CHARS)}…` : message;
    if (!this.warnings.has(key) && this.warnings.size >= MAX_WARNINGS) return;
    this.warnings.set(key, (this.warnings.get(key) ?? 0) + 1);
  }
}

function sameOrigin(url: string, frameUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(frameUrl).origin;
  } catch {
    return false;
  }
}

/** Whether `head` (an append's first bytes) starts with an init segment. */
function startsInit(head: Uint8Array, mime: string): boolean {
  if (/webm|matroska/i.test(mime)) {
    return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  }
  // An init starts with `ftyp` or `moov` (fragments with `styp`, `moof`, `sidx`...).
  const type = String.fromCharCode(...head.subarray(4, 8));
  return type === 'ftyp' || type === 'moov';
}
