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
import { loadWithFallback } from '@/engines/loading';
import { LINE_FALLBACKS } from '@/engines/profiles';
import { type FallbackEvent, sessionTranslator } from '@/engines/translators';
import type {
  AsrEngine,
  AsrEngineInfo,
  LoadProgress,
  SessionLanguages,
  SetupAction,
  TranslationEngine,
  TranslationEngineInfo,
} from '@/engines/types';
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
import { LOG_PREFIX } from '@/shared/ids';
import { ActivityTracker, activityChanged } from './activity';

/** How often the session's activity is checked (and reported, when it changed). */
const ACTIVITY_MS = 1000;

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
  /** Overlay ports, with whether their frame has a video to draw on. */
  private readonly ports = new Map<OverlayPort, { video: boolean }>();
  /** Last `videoInFrame` sent to each tab's top frame. */
  private readonly framesSent = new Map<number, boolean>();
  private session: Running | null = null;
  /** Last chip status per tab, for overlays that connect late. */
  private overlayStatus: { tabId: number; status: OverlayStatus } | null = null;

  constructor(private readonly deps: HostDeps) {}

  /** An overlay frame connected. Cues for its tab go to it until it disconnects. */
  addOverlay(port: OverlayPort): void {
    this.ports.set(port, { video: false });
    port.onDisconnect.addListener(() => {
      this.ports.delete(port);
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

  /**
   * Opens the capture, then loads the engines without waiting for them: resolves once the
   * capture is open (or rejects with a `SessionFailureError`). Loading reports its progress and
   * any failure as status events; `stop()` cancels it.
   */
  async start(config: SessionConfig): Promise<void> {
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
    };
    this.session = running;
    this.broadcast(config.tabId, { type: 'reset' });
    // Capture first: the tab's stream ID expires seconds after it is minted, and models can
    // take minutes to load. Frames heard before the pipeline exists are only measured.
    try {
      running.capture = await startCapture(sourceFor(config.source), (frame) => {
        running.activity.onFrame(frame.samples, Date.now());
        running.pipeline?.push(frame);
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
      const loading = (label: string, p: LoadProgress | null) =>
        this.isCurrent(running) &&
        this.report({
          state: 'loading',
          tabId: config.tabId,
          sessionId: config.sessionId,
          progress: p?.fraction ?? null,
          detail: loadingDetail(label, p),
        });
      const chosen = this.registry.asrInfo(config.asrEngine);
      loading(chosen?.label ?? config.asrEngine, null);
      // The speech detector loads alongside the engines; it is small.
      if (chosen && wantsModelVad(chosen)) running.vad = this.loadVad();
      // Engines that can't run here at all hand over to their fallback (profiles.ts).
      const options = (label: string) => ({
        hardware,
        session,
        signal,
        onProgress: (p: LoadProgress) => loading(label, p),
      });
      running.asr = await loadWithFallback(
        config.asrEngine,
        (id) => this.registry.createAsr(id),
        (engine) => engine.load(options(engine.info.label)),
        signal,
      );
      // A translation model that isn't downloaded or doesn't load doesn't stop the session:
      // another translator takes over (and the popup offers the download).
      running.translator = await loadWithFallback(
        config.translationEngine,
        (id) => this.registry.createTranslation(id),
        (engine) => engine.load(options(engine.info.label)),
        signal,
        {
          onModelError: true,
          onFallback: (_id, err) => {
            running.translatorFailure ??= err;
          },
        },
      );
      if (!this.isCurrent(running)) {
        // Stopped while loading: the teardown ran before these existed.
        await this.teardown(running);
        return;
      }
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

      const pipeline = new Pipeline({
        asr: running.asr,
        translator: running.translator,
        targetLanguage: config.targetLanguage,
        sourceLanguage: config.sourceLanguage,
        spokenLanguages: config.spokenLanguages ?? [],
        onlySpoken: config.onlySpoken ?? false,
        detectLanguages,
        translatePartials: config.translatePartials,
        track: running.capture?.track ?? null,
        vad,
        onVadFailure: (err) =>
          console.warn(LOG_PREFIX, 'speech detector failed, using loudness', err),
        onCue: (cue) => {
          running.activity.onCue(cue, Date.now());
          this.deps.onCue?.(cue);
          if (!running.heard) {
            running.heard = true;
            this.reportRunning(running);
          }
          this.broadcast(config.tabId, { type: 'cue', cue });
        },
        onHealth: (health) => running.activity.onHealth(health),
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
    if (!running) return;
    running.controller.abort(new DOMException('The session stopped.', 'AbortError'));
    await this.teardown(running);
  }

  private async teardown(running: Running): Promise<void> {
    if (running.ticker) clearInterval(running.ticker);
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
    const chosen = this.registry.translationInfo(config.translationEngine);
    const failure = running.translatorFailure;
    if (translator.info.id !== config.translationEngine && chosen) {
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
