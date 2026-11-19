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
import { fetchReader, ProgressiveSource, type RangeReader } from './progressive';
import type { PlayheadReport, TeeWire } from './protocol';
import { LookaheadRunner, type PipelineHooks } from './runner';
import { playheadAt } from './scheduler';
import type { Span } from './types';

/** Decoded audio kept, at most, seconds (16-bit, 16 kHz: 32 KB/s; 10 min ≈ 19 MB). */
export const PCM_CAP_S = 600;
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

interface Buffer {
  ms: string;
  mime: string;
  appends: number;
  mirror: SourceBufferMirror;
  runs: AudioRuns;
}

interface PortState {
  frameUrl: string;
  report: PlayheadReport | null;
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
  private readonly progressive = new Map<string, { source: ProgressiveSource; runs: AudioRuns }>();
  private readonly ports = new Map<LookaheadPort, PortState>();
  private readonly runner: LookaheadRunner;
  private readonly now: () => number;
  private readonly warnings = new Map<string, number>();
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
        deps.post({ type: 'cue', cue });
      },
      onCoverage: (key, spans) =>
        deps.post({ type: 'coverage', timeline: key, spans: spans.map(([s, e]) => [s, e]) }),
      onDrop: (key, start, end) => deps.post({ type: 'drop', timeline: key, start, end }),
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
  onPlayhead(port: LookaheadPort, frameUrl: string, report: PlayheadReport): void {
    if (this.stopped) return;
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
    const current = this.target;
    const keep =
      current &&
      current.port !== port &&
      !current.report.paused &&
      report.paused &&
      this.now() - current.report.at < PLAYING_WINS_MS;
    if (!keep) this.retarget({ port, report });
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
      state = { frameUrl, report: null, waiting: new Map() };
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
          }
        : null,
    );
  }

  private tick(): void {
    this.evict();
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
        this.buffers.set(wire.sb, { ms: wire.ms, mime: wire.mime, appends: 0, mirror, runs });
        return;
      }
      case 'append': {
        const b = this.buffers.get(wire.sb);
        if (!b || b.mirror.kind === 'video') return;
        b.appends++;
        b.mirror.append({
          bytes: fromBase64(wire.bytes),
          timestampOffset: wire.tso,
          appendWindowStart: wire.aws,
          appendWindowEnd: wire.awe ?? Number.POSITIVE_INFINITY,
          sequence: wire.sequence,
          ...(wire.resync ? { resync: true } : {}),
        });
        return;
      }
      case 'remove': {
        const b = this.buffers.get(wire.sb);
        if (b) this.removed(b.ms, wire.start, wire.end);
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
    this.deps.post({ type: 'drop', timeline: t.key, start: from, end: to });
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
      const reader = sameOrigin(url, state.frameUrl)
        ? this.pageReader(port, state, url)
        : fetchReader(url, this.deps.fetch);
      entry = { source: new ProgressiveSource(reader, runs), runs };
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
