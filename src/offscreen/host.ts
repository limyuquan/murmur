/**
 * The offscreen document's job: run one session. Opens the capture, loads the engines, feeds the
 * pipeline, sends cues to the overlay ports of the captured tab, and reports status to the service
 * worker. Everything heavy (audio graph, models) lives here because this document, unlike the
 * service worker, isn't shut down when idle.
 */
import { type CaptureHandle, startCapture } from '@/capture/graph';
import { type AudioSource, tabAudioSource, toneSource } from '@/capture/sources';
import { createBuiltinRegistry } from '@/engines/builtin';
import type { AsrEngine, TranslationEngine } from '@/engines/types';
import type {
  ActiveSessionStatus,
  CaptureSourceSpec,
  OffscreenEvent,
  OverlayMessage,
  SessionConfig,
} from '@/messaging/protocol';
import { Pipeline } from '@/pipeline/pipeline';
import { LOG_PREFIX } from '@/shared/ids';

/** The part of `browser.runtime.Port` the host uses. */
export interface OverlayPort {
  readonly sender?: { tab?: { id?: number } };
  postMessage(message: OverlayMessage): void;
  onDisconnect: { addListener(cb: () => void): void };
}

export interface HostDeps {
  /** Sends an event to the service worker. */
  send(event: OffscreenEvent): Promise<unknown>;
}

interface Running {
  config: SessionConfig;
  capture: CaptureHandle | null;
  pipeline: Pipeline | null;
  asr: AsrEngine | null;
  translator: TranslationEngine | null;
  heard: boolean;
}

export class OffscreenHost {
  private readonly registry = createBuiltinRegistry();
  private readonly ports = new Set<OverlayPort>();
  private session: Running | null = null;

  constructor(private readonly deps: HostDeps) {}

  /** An overlay frame connected. Cues for its tab go to it until it disconnects. */
  addOverlay(port: OverlayPort): void {
    this.ports.add(port);
    port.onDisconnect.addListener(() => this.ports.delete(port));
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
    };
    this.session = running;
    this.broadcast(config.tabId, { type: 'reset' });
    try {
      const asrInfo = this.registry.asrInfo(config.asrEngine);
      const mtInfo = this.registry.translationInfo(config.translationEngine);
      this.report({
        state: 'loading',
        tabId: config.tabId,
        sessionId: config.sessionId,
        progress: null,
        detail: `Loading ${asrInfo?.label ?? config.asrEngine}`,
      });
      running.asr = await this.registry.createAsr(config.asrEngine);
      running.translator = await this.registry.createTranslation(config.translationEngine);
      const onProgress = (p: { fraction: number | null }) =>
        this.isCurrent(running) &&
        this.report({
          state: 'loading',
          tabId: config.tabId,
          sessionId: config.sessionId,
          progress: p.fraction,
          detail: `Loading ${asrInfo?.label ?? config.asrEngine}`,
        });
      await running.asr.load({ onProgress });
      await running.translator.load({ onProgress });
      if (!this.isCurrent(running)) return;

      running.pipeline = new Pipeline({
        asr: running.asr,
        translator: running.translator,
        targetLanguage: config.targetLanguage,
        sourceLanguage: config.sourceLanguage,
        translatePartials: config.translatePartials,
        onCue: (cue) => {
          if (!running.heard) {
            running.heard = true;
            this.reportRunning(running);
          }
          this.broadcast(config.tabId, { type: 'cue', cue });
        },
        onError: (err) => console.error(LOG_PREFIX, 'pipeline', err),
      });
      const pipeline = running.pipeline;
      running.capture = await startCapture(sourceFor(config.source), (frame) =>
        pipeline.push(frame),
      );
      if (!this.isCurrent(running)) {
        await running.capture.stop();
        return;
      }
      this.reportRunning(running, mtInfo?.label);
    } catch (err) {
      if (!this.isCurrent(running)) return;
      const message = describeError(err);
      console.error(LOG_PREFIX, 'session failed', err);
      this.report({
        state: 'error',
        tabId: config.tabId,
        sessionId: config.sessionId,
        message,
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
    this.report({
      state: 'running',
      tabId: config.tabId,
      sessionId: config.sessionId,
      asr: running.asr?.info.label ?? config.asrEngine,
      translation: translationLabel ?? running.translator?.info.label ?? config.translationEngine,
      heard: running.heard,
    });
  }

  private report(status: ActiveSessionStatus): void {
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

function describeError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return 'Chrome did not allow capturing this tab. Click the Earshot button on the tab and try again.';
  }
  if (err instanceof DOMException && err.name === 'AbortError') {
    return 'Another app or extension is already capturing this tab.';
  }
  return err instanceof Error ? err.message : String(err);
}
