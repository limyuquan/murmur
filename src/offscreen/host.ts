/**
 * The offscreen document's job: run one session. Opens the capture, loads the engines, feeds the
 * pipeline, sends cues to the overlay ports of the captured tab, and reports status to the service
 * worker. Everything heavy (audio graph, models) lives here because this document, unlike the
 * service worker, isn't shut down when idle.
 */
import { type CaptureHandle, startCapture } from '@/capture/graph';
import { type AudioSource, tabAudioSource, toneSource } from '@/capture/sources';
import { createBuiltinRegistry } from '@/engines/builtin';
import { isActionRequired } from '@/engines/errors';
import { ENGINE_FACTORIES } from '@/engines/factories';
import { detectHardware } from '@/engines/hardware';
import { loadWithFallback } from '@/engines/loading';
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
} from '@/messaging/protocol';
import { Pipeline } from '@/pipeline/pipeline';
import type { Cue } from '@/pipeline/types';
import { LOG_PREFIX } from '@/shared/ids';
import { ActivityTracker, activityChanged } from './activity';

/** How often the session's activity is checked (and reported, when it changed). */
const ACTIVITY_MS = 1000;

/** The part of `browser.runtime.Port` the host uses. */
export interface OverlayPort {
  readonly sender?: { tab?: { id?: number } };
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
}

interface Running {
  config: SessionConfig;
  capture: CaptureHandle | null;
  pipeline: Pipeline | null;
  asr: AsrEngine | null;
  translator: TranslationEngine | null;
  heard: boolean;
  activity: ActivityTracker;
  reported: SessionActivity | undefined;
  ticker: ReturnType<typeof setInterval> | null;
  /** Downloads a line needed while running (each reported once). */
  setup: SetupAction[];
}

export class OffscreenHost {
  private readonly registry = createBuiltinRegistry(ENGINE_FACTORIES);
  private readonly ports = new Set<OverlayPort>();
  private session: Running | null = null;
  /** Last chip status per tab, for overlays that connect late. */
  private overlayStatus: { tabId: number; status: OverlayStatus } | null = null;

  constructor(private readonly deps: HostDeps) {}

  /** An overlay frame connected. Cues for its tab go to it until it disconnects. */
  addOverlay(port: OverlayPort): void {
    this.ports.add(port);
    port.onDisconnect.addListener(() => this.ports.delete(port));
    const last = this.overlayStatus;
    if (last && port.sender?.tab?.id === last.tabId) {
      try {
        port.postMessage({ type: 'status', status: last.status });
      } catch {
        this.ports.delete(port);
      }
    }
  }

  async start(config: SessionConfig): Promise<void> {
    await this.stop();
    const running: Running = {
      config,
      capture: null,
      pipeline: null,
      asr: null,
      translator: null,
      heard: false,
      activity: new ActivityTracker(Date.now()),
      reported: undefined,
      ticker: null,
      setup: [],
    };
    this.session = running;
    this.broadcast(config.tabId, { type: 'reset' });
    try {
      // Capture first: the tab's stream ID expires seconds after it is minted, and models can
      // take minutes to load. Frames heard before the pipeline exists are only measured.
      let pipeline: Pipeline | null = null;
      running.capture = await startCapture(sourceFor(config.source), (frame) => {
        running.activity.onFrame(frame.samples, Date.now());
        pipeline?.push(frame);
      });
      if (!this.isCurrent(running)) {
        await running.capture.stop();
        return;
      }
      const session: SessionLanguages = {
        targetLanguage: config.targetLanguage,
        sourceLanguage: config.sourceLanguage,
        spokenLanguages: config.spokenLanguages ?? [],
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
      loading(this.registry.asrInfo(config.asrEngine)?.label ?? config.asrEngine, null);
      // Engines that can't run here at all hand over to their fallback (profiles.ts).
      running.asr = await loadWithFallback(
        config.asrEngine,
        (id) => this.registry.createAsr(id),
        (engine) =>
          engine.load({ hardware, session, onProgress: (p) => loading(engine.info.label, p) }),
      );
      running.translator = await loadWithFallback(
        config.translationEngine,
        (id) => this.registry.createTranslation(id),
        (engine) =>
          engine.load({ hardware, session, onProgress: (p) => loading(engine.info.label, p) }),
      );
      if (!this.isCurrent(running)) {
        // Stopped while loading: the teardown ran before these existed.
        await this.teardown(running);
        return;
      }
      this.deps.onEngines?.(running.asr, running.translator);
      const asrInfo = running.asr.info;
      const mtInfo = running.translator.info;
      running.activity = new ActivityTracker(Date.now(), {
        supports: (language) => supports(asrInfo, mtInfo, language, config.targetLanguage),
      });

      pipeline = new Pipeline({
        asr: running.asr,
        translator: running.translator,
        targetLanguage: config.targetLanguage,
        sourceLanguage: config.sourceLanguage,
        spokenLanguages: config.spokenLanguages ?? [],
        translatePartials: config.translatePartials,
        track: running.capture.track,
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
        onError: (err) => {
          if (isActionRequired(err)) {
            const fresh = err.actions.filter((a) => !running.setup.some((b) => b.id === a.id));
            if (fresh.length > 0) {
              running.setup.push(...fresh);
              this.reportRunning(running);
            }
            return;
          }
          console.error(LOG_PREFIX, 'pipeline', err);
        },
      });
      running.pipeline = pipeline;
      this.reportRunning(running, mtInfo.label);
      running.ticker = setInterval(() => {
        const next = running.activity.snapshot(Date.now());
        if (activityChanged(running.reported, next)) this.reportRunning(running);
      }, ACTIVITY_MS);
    } catch (err) {
      if (!this.isCurrent(running)) return;
      const { message, code } = describeError(err);
      console.error(LOG_PREFIX, 'session failed', err);
      this.report({
        state: 'error',
        tabId: config.tabId,
        sessionId: config.sessionId,
        message,
        code,
        ...(isActionRequired(err) ? { setup: err.actions } : {}),
      });
      await this.teardown(running);
      if (this.session === running) this.session = null;
      throw new Error(message);
    }
  }

  async stop(): Promise<void> {
    const running = this.session;
    this.session = null;
    if (running) await this.teardown(running);
  }

  private async teardown(running: Running): Promise<void> {
    if (running.ticker) clearInterval(running.ticker);
    await running.capture?.stop().catch(() => {});
    await running.pipeline?.close().catch(() => {});
    await running.asr?.unload().catch(() => {});
    await running.translator?.unload().catch(() => {});
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
    for (const port of this.ports) {
      if (port.sender?.tab?.id !== tabId) continue;
      try {
        port.postMessage(message);
      } catch {
        this.ports.delete(port);
      }
    }
  }
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

function describeError(err: unknown): { message: string; code: SessionErrorCode } {
  if (isActionRequired(err)) {
    return { message: `Chrome needs to download first: ${err.message}.`, code: 'setup' };
  }
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return {
      message:
        'Chrome did not allow capturing this tab. Click the Earshot button on the tab and try again.',
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
