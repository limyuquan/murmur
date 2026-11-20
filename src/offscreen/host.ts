/**
 * The offscreen document's job: run one session. Opens the capture, loads the engines, feeds the
 * pipeline, sends cues to the overlay ports of the captured tab, and reports status to the service
 * worker. Everything heavy (audio graph, models) lives here because this document, unlike the
 * service worker, isn't shut down when idle.
 */
import { type CaptureHandle, startCapture } from '@/capture/graph';
import { type AudioSource, tabAudioSource, toneSource } from '@/capture/sources';
import { createBuiltinRegistry } from '@/engines/builtin';
import { type DetectorInstance, detectorApi } from '@/engines/chrome/api';
import {
  isActionRequired,
  isCompanionError,
  isModelError,
  isUnavailable,
  isUnsupportedLanguage,
} from '@/engines/errors';
import { ENGINE_FACTORIES } from '@/engines/factories';
import { detectHardware, type HardwareInfo } from '@/engines/hardware';
import { loadLadder, loadWithFallback } from '@/engines/loading';
import { type LadderStep, LINE_FALLBACKS } from '@/engines/profiles';
import { describeSlowness, type Slowness, SlownessWatch } from '@/engines/slowness';
import { type FallbackEvent, LINE_BUDGET_MS, sessionTranslator } from '@/engines/translators';
import type {
  AsrEngine,
  AsrEngineInfo,
  LoadProgress,
  SessionLanguages,
  SetupAction,
  TranslationEngine,
  TranslationEngineInfo,
} from '@/engines/types';
import { LookaheadHost, type LookaheadSnapshot } from '@/lookahead/host';
import type { PlayheadReport, TeeWire } from '@/lookahead/protocol';
import type { PipelineHooks } from '@/lookahead/runner';
import {
  type ActiveSessionStatus,
  type CaptureSourceSpec,
  type OffscreenEvent,
  type OverlayMessage,
  type OverlayStatus,
  overlayStatus,
  type SessionActivity,
  type SessionConfig,
  type SessionErrorCode,
  type SessionFailure,
} from '@/messaging/protocol';
import type { DetectLanguages } from '@/pipeline/mixed';
import { Pipeline, type PipelineOptions } from '@/pipeline/pipeline';
import type { SileroVad } from '@/pipeline/silero';
import type { Cue } from '@/pipeline/types';
import { IS_E2E } from '@/shared/e2e';
import { LOG_PREFIX } from '@/shared/ids';
import { ActivityTracker, activityChanged } from './activity';

/** What the popup says when a session runs smaller models than its profile's largest. */
export const FIT_NOTE = 'Using smaller models to fit this device’s graphics memory.';
/** The same, when larger ones fell behind here before. */
export const SLOW_NOTE = 'Using smaller models: larger ones fell behind the speech here.';
/** The same, on graphics that share the computer's memory (profiles.ts `SLOW_ON_SHARED_MEMORY`). */
export const SPEED_NOTE =
  'Using smaller models: the largest translation model is too slow on this device’s graphics.';

/** How often the session's activity is checked (and reported, when it changed). */
const ACTIVITY_MS = 1000;

/**
 * After the tab is shown again, how long lines still don't count towards falling behind (the
 * program that had the graphics card may still be letting go of it), ms.
 */
const SHOWN_GRACE_MS = 10_000;

/** Lookahead messages kept from before a session starts, at most (base64 bytes). */
const EARLY_LOOKAHEAD_BYTES = 32 * 1024 * 1024;

type LookaheadMessage =
  | { type: 'tee'; wire: TeeWire }
  | { type: 'playhead'; report: PlayheadReport };

/** The part of `browser.runtime.Port` the host uses. */
export interface OverlayPort {
  readonly sender?: { tab?: { id?: number }; frameId?: number };
  postMessage(message: OverlayMessage): void;
  onDisconnect: { addListener(cb: () => void): void };
}

export interface HostDeps {
  /** Sends an event to the service worker. */
  send(event: OffscreenEvent): Promise<unknown>;
  /** Sees every cue as it is sent (e2e builds record them for real-model checks). */
  onCue?(cue: Cue): void;
  /** Sees the session's engines once loaded (e2e builds tap their diagnostics). */
  onEngines?(asr: AsrEngine, translator: TranslationEngine): void;
  /** Sees each segment start and end (e2e builds log them). */
  onSegment?: PipelineOptions['onSegment'];
  /** Sees the speech detector the session uses (`null`: the energy gate). */
  onVad?(vad: SileroVad | null): void;
  /** A start-up step is done (e2e builds log when, to measure how late the first line is). */
  onStartup?(step: 'capture' | 'asr' | 'translation' | 'pipeline'): void;
  /** An engine ran out of memory and the session stepped down its ladder (e2e builds log it). */
  onStepDown?(engine: string, error: Error, next: LadderStep | null): void;
  /**
   * The session's models kept falling behind, and the next session starts at `next` (null: below
   * the ladder). e2e builds log it.
   */
  onSlow?(found: Slowness, next: LadderStep | null): void;
  /** Sees every lookahead cue (e2e builds log them). */
  onLookaheadCue?(cue: Cue): void;
  /** Loads the model speech detector (tests replace it). Default: Silero from the extension. */
  loadVad?(): Promise<SileroVad>;
  /**
   * Chrome's language detector when it is ready (tests replace it), to find other languages in
   * lines heard as the target language. Never downloads it.
   */
  languageDetector?(): Promise<DetectorInstance | null>;
}

interface Running {
  config: SessionConfig;
  /** Aborted on stop: cancels model loading and pack waits. */
  controller: AbortController;
  /** Engines and pipeline loading after the capture opened. */
  loading: Promise<void> | null;
  capture: CaptureHandle | null;
  pipeline: Pipeline | null;
  asr: AsrEngine | null;
  translator: TranslationEngine | null;
  /** The model speech detector, loading alongside the engines (null: none wanted). */
  vad: Promise<SileroVad | null> | null;
  /** Chrome's language detector, when it was ready. */
  detector: DetectorInstance | null;
  heard: boolean;
  activity: ActivityTracker;
  reported: SessionActivity | undefined;
  ticker: ReturnType<typeof setInterval> | null;
  /** Downloads a line needed while running (each reported once). */
  setup: SetupAction[];
  /** Engine failures the session carries on despite (each reported once). */
  problems: string[];
  /** Lines another translator did instead of the chosen one, and why (each reported). */
  translationNote: string | null;
  /** Why the chosen translator gave way to another while loading, if it did. */
  translatorFailure: Error | null;
  /** The translator the session meant to run (a ladder's step down changes it). */
  plannedTranslation: string;
  /** Smaller models run to fit the graphics memory, in plain words (null: they don't). */
  fitNote: string | null;
  /** The ladder step that loaded (null: no ladder, or below its last step). */
  ladderStep: LadderStep | null;
  /** Watches for models that keep falling behind (null: no ladder step to go down from). */
  slowness: SlownessWatch | null;
  /** Speech recognition's last real-time factor, and the lines it finished (ids, recent). */
  rtf: number | null;
  recognized: Set<string>;
  /** Lookahead, once an overlay on a site where it's on reported in. */
  lookahead: LookaheadHost | null;
  /** Lookahead's own speech detector (the live one keeps its state per stream). */
  lookaheadVad: SileroVad | null | 'loading';
  /** Lookahead is far enough ahead: live frames aren't recognized. */
  livePaused: boolean;
  /** What the session's pipeline was given, for lookahead pipelines to use too. */
  pipelineOptions: Omit<PipelineOptions, 'onCue' | 'onError' | 'vad' | 'onVadFailure'> | null;
}

/**
 * Engines that take segments get the model speech detector. Engines that listen to the track keep
 * the energy gate (segments are only pause markers for them), and so do the demo engines, which
 * hear a test tone a speech detector rightly ignores.
 */
function wantsModelVad(info: AsrEngineInfo): boolean {
  return info.audioInput !== 'track' && info.runtime !== 'demo';
}

/** A failure to report as it is (the start command's reply carries it). */
export class SessionFailureError extends Error {
  override readonly name = 'SessionFailureError';
  constructor(readonly failure: SessionFailure) {
    super(failure.message);
  }
}

export class OffscreenHost {
  private readonly registry = createBuiltinRegistry(ENGINE_FACTORIES);
  /** Overlay ports, with whether their frame has a video to draw on, and its address. */
  private readonly ports = new Map<OverlayPort, { video: boolean; frameUrl: string }>();
  /** Last `videoInFrame` sent to each tab's top frame. */
  private readonly framesSent = new Map<number, boolean>();
  private session: Running | null = null;
  /** Last chip status per tab, for overlays that connect late. */
  private overlayStatus: { tabId: number; status: OverlayStatus } | null = null;
  /**
   * Lookahead messages that came before the session started (the overlay is injected, and
   * forwards what the page's player did, just before the start command), with their size.
   */
  private early: { port: OverlayPort; message: LookaheadMessage; size: number }[] = [];
  private earlyBytes = 0;
  /**
   * Per tab, until when its lines don't count towards falling behind (Infinity: hidden now), as
   * its top frame reports.
   */
  private readonly unseenUntil = new Map<number, number>();

  constructor(private readonly deps: HostDeps) {}

  /** An overlay frame connected. Cues for its tab go to it until it disconnects. */
  addOverlay(port: OverlayPort, frameUrl = ''): void {
    this.ports.set(port, { video: false, frameUrl });
    port.onDisconnect.addListener(() => {
      this.ports.delete(port);
      this.session?.lookahead?.removePort(port);
      this.updateFrames(port.sender?.tab?.id);
    });
    const last = this.overlayStatus;
    if (last && port.sender?.tab?.id === last.tabId) {
      this.post(port, { type: 'status', status: last.status });
    }
    if (isTopFrame(port)) {
      const tabId = port.sender?.tab?.id;
      this.post(port, { type: 'frames', videoInFrame: this.videoInFrame(tabId) });
    }
  }

  /** An overlay's frame started or stopped having a video. */
  setOverlayVideo(port: OverlayPort, present: boolean): void {
    const entry = this.ports.get(port);
    if (!entry || entry.video === present) return;
    entry.video = present;
    this.updateFrames(port.sender?.tab?.id);
  }

  /** The top frame's tab was shown or hidden. */
  setOverlayVisible(port: OverlayPort, visible: boolean): void {
    const tabId = port.sender?.tab?.id;
    if (tabId === undefined || !isTopFrame(port) || !this.ports.has(port)) return;
    if (!visible) this.unseenUntil.set(tabId, Number.POSITIVE_INFINITY);
    else if (this.unseenUntil.has(tabId)) this.unseenUntil.set(tabId, Date.now() + SHOWN_GRACE_MS);
  }

  /**
   * Whether the session's lines now say little about its models' speed: the tab is hidden (or
   * just shown again), so another program may have the graphics card, or lookahead is making
   * subtitles ahead of time on the same models.
   */
  private unseen(running: Running): boolean {
    const until = this.unseenUntil.get(running.config.tabId);
    if (until !== undefined && Date.now() < until) return true;
    return running.livePaused || (running.lookahead?.busy ?? false);
  }

  /** Lookahead from an overlay: the tee's events, or where its video plays. */
  onLookahead(port: OverlayPort, message: LookaheadMessage): void {
    const running = this.session;
    const entry = this.ports.get(port);
    if (!entry) return;
    if (!running) {
      // The start command is on its way: keep what the page sent (bounded).
      const size =
        message.type === 'tee' && message.wire.t === 'append' ? message.wire.bytes.length : 64;
      if (this.earlyBytes + size > EARLY_LOOKAHEAD_BYTES) return;
      this.early.push({ port, message, size });
      this.earlyBytes += size;
      return;
    }
    if (port.sender?.tab?.id !== running.config.tabId) return;
    running.lookahead ??= this.createLookahead(running);
    const lookahead = running.lookahead;
    if (message.type === 'tee') lookahead.onTee(port, entry.frameUrl, message.wire);
    else lookahead.onPlayhead(port, entry.frameUrl, message.report);
  }

  /** What lookahead is doing (e2e builds read it). */
  lookaheadSnapshot(): LookaheadSnapshot | null {
    return this.session?.lookahead?.snapshot() ?? null;
  }

  private createLookahead(running: Running): LookaheadHost {
    const { config } = running;
    // Lookahead's own speech detector loads now, alongside the engines, not when its first job
    // asks for it (that made the first lines ahead of time wait for it).
    this.loadLookaheadVad(running);
    return new LookaheadHost({
      post: (message) => this.broadcast(config.tabId, message),
      // Only captured tab audio is played back late (the test tone isn't).
      measureLag: config.source.kind === 'tab',
      createPipeline: (media, hooks) => this.lookaheadPipeline(running, media, hooks),
      setLivePaused: (paused) => {
        if (running.livePaused === paused) return;
        running.livePaused = paused;
        // The open live segment ends here; frames are only measured until lookahead falls back.
        if (paused) running.pipeline?.flush();
      },
      onCue: (cue) => this.deps.onLookaheadCue?.(cue),
    });
  }

  /** Starts loading lookahead's speech detector, once, when the speech engine would use one. */
  private loadLookaheadVad(running: Running): void {
    if (running.lookaheadVad !== null) return;
    const chosen = running.asr?.info ?? this.registry.asrInfo(running.config.asrEngine);
    if (!chosen || !wantsModelVad(chosen)) return;
    running.lookaheadVad = 'loading';
    void this.loadVad().then((loaded) => {
      if (!this.isCurrent(running)) {
        void loaded?.dispose().catch(() => {});
        return;
      }
      running.lookaheadVad = loaded;
      running.lookahead?.kick();
    });
  }

  /**
   * A pipeline over the session's engines for a lookahead job, or null while they load (or when
   * the speech engine listens to the live track, which can't take audio ahead of time).
   */
  private lookaheadPipeline(
    running: Running,
    media: { timeline: string; idPrefix: string },
    hooks: PipelineHooks,
  ): Pipeline | null {
    const options = running.pipelineOptions;
    if (!this.isCurrent(running) || !options || !running.asr) return null;
    if (running.asr.info.audioInput === 'track') return null;
    let vad: SileroVad | null = null;
    if (wantsModelVad(running.asr.info)) {
      this.loadLookaheadVad(running);
      if (running.lookaheadVad === 'loading') return null;
      vad = running.lookaheadVad;
    }
    return new Pipeline({
      ...options,
      translatePartials: false,
      track: null,
      vad,
      media,
      onCue: hooks.onCue,
      onSegment: hooks.onSegment,
      onError: hooks.onError,
      untilShownMs: hooks.untilShownMs,
    });
  }

  /**
   * Opens the capture, then loads the engines without waiting for them: resolves once the
   * capture is open (or rejects with a `SessionFailureError`). Loading reports its progress and
   * any failure as status events; `stop()` cancels it.
   */
  async start(config: SessionConfig): Promise<void> {
    // Kept across the stop of any session before this one.
    const kept = this.early;
    await this.stop();
    const running: Running = {
      config,
      controller: new AbortController(),
      loading: null,
      capture: null,
      pipeline: null,
      asr: null,
      translator: null,
      vad: null,
      detector: null,
      heard: false,
      activity: new ActivityTracker(Date.now()),
      reported: undefined,
      ticker: null,
      setup: [],
      problems: [],
      translationNote: null,
      translatorFailure: null,
      plannedTranslation: config.translationEngine,
      fitNote: config.ladder?.smaller ? fitNote(config.ladder.why) : null,
      ladderStep: null,
      slowness: null,
      rtf: null,
      recognized: new Set(),
      lookahead: null,
      lookaheadVad: null,
      livePaused: false,
      pipelineOptions: null,
    };
    this.session = running;
    this.broadcast(config.tabId, { type: 'reset' });
    // What the tab's overlays forwarded before this start reached here.
    const early = [...kept, ...this.early];
    this.early = [];
    this.earlyBytes = 0;
    for (const { port, message } of early) {
      if (this.ports.has(port)) this.onLookahead(port, message);
    }
    // Capture first: the tab's stream ID expires seconds after it is minted, and models can
    // take minutes to load. Frames heard before the pipeline exists are only measured.
    try {
      running.capture = await startCapture(sourceFor(config.source), (frame) => {
        running.activity.onFrame(frame.samples, Date.now());
        running.lookahead?.onLiveFrame(frame.samples, frame.startEpochMs);
        // While lookahead is ahead, live frames are only measured.
        if (!running.livePaused) running.pipeline?.push(frame);
      });
    } catch (err) {
      if (!this.isCurrent(running)) return;
      this.session = null;
      throw new SessionFailureError(this.fail(running, err));
    }
    if (!this.isCurrent(running)) {
      await running.capture.stop().catch(() => {});
      return;
    }
    this.deps.onStartup?.('capture');
    running.loading = this.load(running);
  }

  /** Resolves when the current session's engines have loaded or failed (tests). */
  async loaded(): Promise<void> {
    await this.session?.loading;
  }

  /** Loads the engines and starts the pipeline. Reports a failure; never throws. */
  private async load(running: Running): Promise<void> {
    const { config } = running;
    const { signal } = running.controller;
    try {
      const session: SessionLanguages = {
        targetLanguage: config.targetLanguage,
        sourceLanguage: config.sourceLanguage,
        spokenLanguages: config.spokenLanguages ?? [],
        onlySpoken: config.onlySpoken ?? false,
      };
      const hardware = await detectHardware();
      /** Stepped down a memory ladder in this load. */
      let stepped = false;
      const loading = (label: string, p: LoadProgress | null) =>
        this.isCurrent(running) &&
        this.report({
          state: 'loading',
          tabId: config.tabId,
          sessionId: config.sessionId,
          progress: p?.fraction ?? null,
          detail: stepped ? `${FIT_NOTE} ${loadingDetail(label, p)}` : loadingDetail(label, p),
        });
      const chosen = this.registry.asrInfo(config.asrEngine);
      loading(chosen?.label ?? config.asrEngine, null);
      // The speech detector loads alongside the engines; it is small.
      if (chosen && wantsModelVad(chosen)) running.vad = this.loadVad();
      // Engines that can't run here at all hand over to their fallback (profiles.ts).
      const options = (info: { id: string; label: string }) => {
        // e2e builds only: engines to fail as if out of graphics memory.
        const failure = IS_E2E ? config.simulateOutOfMemory?.[info.id] : undefined;
        return {
          hardware,
          session,
          signal,
          onProgress: (p: LoadProgress) => loading(info.label, p),
          ...(IS_E2E && failure ? { simulateOutOfMemory: failure } : {}),
        };
      };
      const onTranslatorFallback = (_id: string, err: Error) => {
        running.translatorFailure ??= err;
      };
      const ladder = config.ladder;
      if (ladder && ladder.steps.length > 0) {
        // Balanced and Best: speech recognition, then the translator; an engine that runs out of
        // graphics memory steps the session down to smaller ones (profiles.ts `LADDERS`).
        const loaded = await loadLadder(ladder.steps, {
          createAsr: (id) => this.registry.createAsr(id),
          createTranslation: (id) => this.registry.createTranslation(id),
          loadAsr: async (engine) => {
            await engine.load(options(engine.info));
            this.deps.onStartup?.('asr');
          },
          loadTranslation: (engine) => engine.load(options(engine.info)),
          signal,
          onTranslatorFallback,
          asrMemoryFailure: (engine) => engine.memoryFailure?.() ?? null,
          onStepDown: (next, engine, err, from) => {
            console.warn(LOG_PREFIX, `${engine} ran out of graphics memory`, err.message);
            this.deps.onStepDown?.(engine, err, next);
            if (!this.isCurrent(running)) return;
            stepped = true;
            running.fitNote = FIT_NOTE;
            this.deps
              .send({
                target: 'background',
                type: 'memory-fit',
                sessionId: config.sessionId,
                profile: ladder.profile,
                gpu: ladder.gpu,
                ladder: ladder.id,
                startedAt: ladder.startedAt,
                from: from.index,
                step: next?.index ?? ladder.length,
                engine,
                message: err.message,
              })
              .catch(() => {});
            const label = next ? this.registry.asrInfo(next.asr)?.label : undefined;
            loading(label ?? 'Chrome’s speech recognition', null);
          },
        });
        running.asr = loaded.asr;
        running.translator = loaded.translator;
        running.plannedTranslation = loaded.step?.translation ?? loaded.translator.info.id;
        running.ladderStep = loaded.step;
        // A step that fits can still be too slow here: step down for next time if it keeps
        // falling behind (slowness.ts).
        if (loaded.step) running.slowness = new SlownessWatch();
      } else {
        // Engines that run out of graphics memory hand over to smaller ones (`MEMORY_FALLBACKS`).
        running.asr = await loadWithFallback(
          config.asrEngine,
          (id) => this.registry.createAsr(id),
          (engine) => engine.load(options(engine.info)),
          signal,
          { onOutOfMemory: true },
        );
        this.deps.onStartup?.('asr');
        // A translation model that isn't downloaded or doesn't load doesn't stop the session:
        // another translator takes over (and the popup offers the download).
        running.translator = await loadWithFallback(
          config.translationEngine,
          (id) => this.registry.createTranslation(id),
          (engine) => engine.load(options(engine.info)),
          signal,
          { onModelError: true, onOutOfMemory: true, onFallback: onTranslatorFallback },
        );
      }
      if (!this.isCurrent(running)) {
        // Stopped while loading: the teardown ran before these existed.
        await this.teardown(running);
        return;
      }
      this.deps.onStartup?.('translation');
      this.deps.onEngines?.(running.asr, running.translator);
      running.translator = this.withLineHelpers(running, running.translator, hardware);
      const asrInfo = running.asr.info;
      // A fallback engine may want the detector when the chosen one didn't, or not want it.
      if (wantsModelVad(asrInfo)) running.vad ??= this.loadVad();
      else if (running.vad) {
        const unwanted = running.vad;
        running.vad = null;
        void unwanted.then((vad) => vad?.dispose()).catch(() => {});
      }
      const vad = (await running.vad) ?? null;
      if (!this.isCurrent(running)) {
        await this.teardown(running);
        return;
      }
      this.deps.onVad?.(vad);
      running.detector = await (this.deps.languageDetector ?? readyDetector)();
      if (!this.isCurrent(running)) {
        await this.teardown(running);
        return;
      }
      const detector = running.detector;
      const detectLanguages: DetectLanguages | null = detector
        ? async (text) =>
            (await detector.detect(text)).map((r) => ({
              language: r.detectedLanguage,
              confidence: r.confidence,
            }))
        : null;
      const mtInfo = running.translator.info;
      running.activity = new ActivityTracker(Date.now(), {
        supports: (language) => supports(asrInfo, mtInfo, language, config.targetLanguage),
      });

      const shared = {
        asr: running.asr,
        translator: running.translator,
        targetLanguage: config.targetLanguage,
        sourceLanguage: config.sourceLanguage,
        spokenLanguages: config.spokenLanguages ?? [],
        onlySpoken: config.onlySpoken ?? false,
        detectLanguages,
        translatePartials: config.translatePartials,
        track: running.capture?.track ?? null,
      };
      running.pipelineOptions = shared;
      const pipeline = new Pipeline({
        ...shared,
        vad,
        onVadFailure: (err) =>
          console.warn(LOG_PREFIX, 'speech detector failed, using loudness', err),
        onCue: (cue) => {
          running.activity.onCue(cue, Date.now());
          this.onRecognized(running, cue);
          this.deps.onCue?.(cue);
          if (!running.heard) {
            running.heard = true;
            this.reportRunning(running);
          }
          this.broadcast(config.tabId, { type: 'cue', cue });
        },
        onHealth: (health) => {
          running.activity.onHealth(health);
          running.rtf = health.rtf;
        },
        ...(this.deps.onSegment ? { onSegment: this.deps.onSegment } : {}),
        onError: (err) => {
          if (isActionRequired(err)) {
            const fresh = err.actions.filter((a) => !running.setup.some((b) => b.id === a.id));
            if (fresh.length > 0) {
              running.setup.push(...fresh);
              this.reportRunning(running);
            }
            return;
          }
          if (isUnsupportedLanguage(err)) {
            running.activity.onUnsupported(err.language);
            return;
          }
          console.error(LOG_PREFIX, 'pipeline', err);
          // An engine part that stopped for good (a recognizer that keeps failing): say so.
          if (isUnavailable(err) && !running.problems.includes(err.message)) {
            running.problems.push(err.message);
            this.reportRunning(running);
          }
        },
      });
      running.pipeline = pipeline;
      this.deps.onStartup?.('pipeline');
      running.lookahead?.kick();
      this.reportRunning(running, mtInfo.label);
      running.ticker = setInterval(() => {
        const next = running.activity.snapshot(Date.now());
        if (activityChanged(running.reported, next)) this.reportRunning(running);
      }, ACTIVITY_MS);
    } catch (err) {
      if (!this.isCurrent(running)) {
        // Stopped while loading: the stop's teardown ran before some of these existed.
        await this.teardown(running);
        return;
      }
      this.session = null;
      this.fail(running, err);
      await this.teardown(running);
    }
  }

  /** Reports `err` as the session's failure. */
  private fail(running: Running, err: unknown): SessionFailure {
    const failure = describeError(err);
    console.error(LOG_PREFIX, 'session failed', err);
    this.report({
      state: 'error',
      tabId: running.config.tabId,
      sessionId: running.config.sessionId,
      ...failure,
    });
    return failure;
  }

  async stop(): Promise<void> {
    const running = this.session;
    this.session = null;
    this.early = [];
    this.earlyBytes = 0;
    if (!running) return;
    running.controller.abort(new DOMException('The session stopped.', 'AbortError'));
    await this.teardown(running);
  }

  private async teardown(running: Running): Promise<void> {
    if (running.ticker) clearInterval(running.ticker);
    await running.lookahead?.stop().catch(() => {});
    running.lookahead = null;
    const lookaheadVad = running.lookaheadVad;
    running.lookaheadVad = null;
    if (lookaheadVad && lookaheadVad !== 'loading') await lookaheadVad.dispose().catch(() => {});
    await running.capture?.stop().catch(() => {});
    await running.pipeline?.close().catch(() => {});
    await running.asr?.unload().catch(() => {});
    await running.translator?.unload().catch(() => {});
    const vad = await running.vad;
    running.vad = null;
    await vad?.dispose().catch(() => {});
    running.detector?.destroy();
    running.detector = null;
  }

  /** The model speech detector, or null (the energy gate) when it can't load. Never throws. */
  private async loadVad(): Promise<SileroVad | null> {
    try {
      const load =
        this.deps.loadVad ?? (async () => (await import('@/pipeline/silero-load')).loadSileroVad());
      return await load();
    } catch (err) {
      console.warn(LOG_PREFIX, 'speech detector unavailable, using loudness', err);
      return null;
    }
  }

  /**
   * The session's translator: the loaded one with the glossary, and Chrome's translator for any
   * line it is too slow for or fails on (engines/translators.ts). Says so when the chosen one
   * couldn't load and another took its place.
   */
  private withLineHelpers(
    running: Running,
    translator: TranslationEngine,
    hardware: HardwareInfo,
  ): TranslationEngine {
    const { config } = running;
    const chosen = this.registry.translationInfo(running.plannedTranslation);
    const failure = running.translatorFailure;
    if (translator.info.id !== running.plannedTranslation && chosen) {
      // Not downloaded: the popup offers the download instead of a note.
      if (!failure || !isModelError(failure)) {
        running.translationNote = `${chosen.label} couldn’t run here, so ${translator.info.label} translates.`;
      } else if (!failure.missing) {
        running.translationNote = `${chosen.label} didn’t load, so ${translator.info.label} translates.`;
      }
    }
    const backupId = LINE_FALLBACKS[translator.info.id];
    let fellBack = 0;
    return sessionTranslator(translator, {
      glossary: config.glossary ?? [],
      onLine: ({ slow, waitedMs }) => {
        if (!this.isCurrent(running) || this.unseen(running)) return;
        const found = running.slowness?.onTranslated({ slow, waitedMs });
        if (found) this.stepDownForSpeed(running, found);
      },
      backup: backupId
        ? async () => {
            const backup = await this.registry.createTranslation(backupId);
            // No pack check up front: a line whose pack is missing asks for it (`setup`).
            await backup.load({ hardware, signal: running.controller.signal });
            return backup;
          }
        : null,
      onFallback: (event: FallbackEvent) => {
        if (!this.isCurrent(running)) return;
        fellBack++;
        const backupLabel =
          this.registry.translationInfo(backupId ?? '')?.label ?? 'another translator';
        running.translationNote = event.permanent
          ? `${translator.info.label} ${event.reason}, so ${backupLabel} translates.`
          : `${fellBack} ${fellBack === 1 ? 'line' : 'lines'} translated by ${backupLabel}, as ${translator.info.label} ${event.reason}.`;
        console.warn(LOG_PREFIX, 'line translated by the backup', event);
        this.reportRunning(running);
      },
    });
  }

  /** A cue: the first time its line is final with text, speech recognition finished a line. */
  private onRecognized(running: Running, cue: Cue): void {
    if (!running.slowness || !cue.source.final || !cue.source.text.trim()) return;
    if (running.recognized.has(cue.id)) return;
    running.recognized.add(cue.id);
    // Only recent lines can still change.
    if (running.recognized.size > 64) {
      running.recognized.delete(running.recognized.values().next().value as string);
    }
    if (this.unseen(running)) return;
    const found = running.slowness.onRecognized(running.rtf);
    if (found) this.stepDownForSpeed(running, found);
  }

  /**
   * The session's models keep falling behind. The service worker counts it (settings/
   * memoryfit.ts): after a second session that falls behind at this step, the next one starts a
   * step down its ladder, with a smaller translator when the translator fell behind, a smaller
   * speech model when speech recognition did. Never below the ladder's last step: Chrome's own
   * engines take over only when models don't fit. This session runs on as it is; the per-line
   * backup covers the translator's late lines.
   */
  private stepDownForSpeed(running: Running, found: Slowness): void {
    const { config } = running;
    const ladder = config.ladder;
    const at = running.ladderStep;
    if (!ladder || !at) return;
    const i = ladder.steps.findIndex((step) => step.index === at.index);
    const below = ladder.steps.slice(i + 1);
    const next =
      (found.engine === 'translator'
        ? below[0]
        : below.find((step) => step.asr !== at.asr && step.asr !== running.asr?.info.id)) ?? null;
    const engine = found.engine === 'translator' ? at.translation : at.asr;
    const label =
      (found.engine === 'translator'
        ? this.registry.translationInfo(engine)?.label
        : this.registry.asrInfo(engine)?.label) ?? engine;
    const message = `${label} ${describeSlowness(found, LINE_BUDGET_MS)}.`;
    console.warn(LOG_PREFIX, 'falling behind:', message);
    this.deps.onSlow?.(found, next);
    if (next) {
      this.deps
        .send({
          target: 'background',
          type: 'memory-fit',
          sessionId: config.sessionId,
          profile: ladder.profile,
          gpu: ladder.gpu,
          ladder: ladder.id,
          startedAt: ladder.startedAt,
          from: at.index,
          step: next.index,
          engine,
          message,
          cause: 'slow',
        })
        .catch(() => {});
    }
    running.fitNote = next
      ? `${label} is falling behind the speech here. If it happens again, Murmur will start with smaller models.`
      : `${label} is falling behind the speech here.`;
    this.reportRunning(running);
  }

  private isCurrent(running: Running): boolean {
    return this.session === running;
  }

  private reportRunning(running: Running, translationLabel?: string): void {
    const { config } = running;
    running.reported = running.activity.snapshot(Date.now());
    this.report({
      state: 'running',
      tabId: config.tabId,
      sessionId: config.sessionId,
      asr: running.asr?.info.label ?? config.asrEngine,
      translation: translationLabel ?? running.translator?.info.label ?? config.translationEngine,
      heard: running.heard,
      activity: running.reported,
      ...(running.setup.length > 0 ? { setup: [...running.setup] } : {}),
      ...(running.problems.length > 0 ? { problems: [...running.problems] } : {}),
      ...(running.translationNote ? { translationNote: running.translationNote } : {}),
      ...(running.fitNote ? { fitNote: running.fitNote } : {}),
    });
  }

  private report(status: ActiveSessionStatus): void {
    const chip = overlayStatus(status);
    this.overlayStatus = { tabId: status.tabId, status: chip };
    this.broadcast(status.tabId, { type: 'status', status: chip });
    this.deps
      .send({ target: 'background', type: 'session-status', status })
      .catch((err: unknown) => console.warn(LOG_PREFIX, 'status not delivered', err));
  }

  private broadcast(tabId: number, message: OverlayMessage): void {
    for (const port of [...this.ports.keys()]) {
      if (port.sender?.tab?.id === tabId) this.post(port, message);
    }
  }

  private post(port: OverlayPort, message: OverlayMessage): void {
    try {
      port.postMessage(message);
    } catch {
      this.ports.delete(port);
    }
  }

  /** Whether a frame below the top one in `tabId` has a video (and so shows the subtitles). */
  private videoInFrame(tabId: number | undefined): boolean {
    for (const [port, { video }] of this.ports) {
      if (video && port.sender?.tab?.id === tabId && !isTopFrame(port)) return true;
    }
    return false;
  }

  private updateFrames(tabId: number | undefined): void {
    if (tabId === undefined) return;
    const videoInFrame = this.videoInFrame(tabId);
    if (this.framesSent.get(tabId) === videoInFrame) return;
    this.framesSent.set(tabId, videoInFrame);
    for (const port of [...this.ports.keys()]) {
      if (port.sender?.tab?.id === tabId && isTopFrame(port)) {
        this.post(port, { type: 'frames', videoInFrame });
      }
    }
  }
}

/** What the popup says when a session starts below its ladder's top, by why. */
function fitNote(why: 'slow' | 'speed' | undefined): string {
  return why === 'slow' ? SLOW_NOTE : why === 'speed' ? SPEED_NOTE : FIT_NOTE;
}

/** Chrome's language detector, when it is on this device already; null otherwise. */
async function readyDetector(): Promise<DetectorInstance | null> {
  const api = detectorApi();
  if (!api) return null;
  try {
    return (await api.availability()) === 'available' ? await api.create() : null;
  } catch {
    return null;
  }
}

function isTopFrame(port: OverlayPort): boolean {
  return (port.sender?.frameId ?? 0) === 0;
}

function sourceFor(spec: CaptureSourceSpec): AudioSource {
  return spec.kind === 'tab' ? tabAudioSource(spec.streamId) : toneSource();
}

/** "Downloading Whisper base: model_q4.onnx", "Preparing Whisper base", ... */
function loadingDetail(label: string, p: LoadProgress | null): string {
  if (!p) return `Loading ${label}`;
  switch (p.stage) {
    case 'download':
      return `Downloading ${label}`;
    case 'compile':
      return `Preparing ${label}`;
    case 'warmup':
      return `Warming up ${label}`;
  }
}

export function describeError(err: unknown): SessionFailure & { code: SessionErrorCode } {
  if (err instanceof SessionFailureError) return { code: 'unknown', ...err.failure };
  if (isActionRequired(err)) {
    return {
      message: `Chrome needs to download first: ${err.message}.`,
      code: 'setup',
      setup: err.actions,
    };
  }
  if (isModelError(err)) {
    return {
      message: err.message,
      code: 'model',
      ...(err.missing ? { missingModels: err.models } : {}),
    };
  }
  if (isCompanionError(err)) return { message: err.message, code: 'companion' };
  // Nothing in the profile's fallback chain can run here.
  if (isUnavailable(err)) return { message: err.message, code: 'model' };
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return {
      message:
        'Chrome did not allow capturing this tab. Click the Murmur button on the tab and try again.',
      code: 'access',
    };
  }
  if (err instanceof DOMException && err.name === 'AbortError') {
    return { message: 'Another app or extension is already capturing this tab.', code: 'busy' };
  }
  return { message: err instanceof Error ? err.message : String(err), code: 'unknown' };
}

/** Whether the session's engines handle speech in `language` (a primary subtag). */
function supports(
  asr: AsrEngineInfo | undefined,
  mt: TranslationEngineInfo | undefined,
  language: string,
  target: string,
): boolean {
  const has = (list: readonly string[] | 'any' | undefined) =>
    !list || list === 'any' || list.some((l) => l.split('-')[0]?.toLowerCase() === language);
  const sameAsTarget = target.split('-')[0]?.toLowerCase() === language;
  return has(asr?.languages) && (sameAsTarget || has(mt?.sources));
}
