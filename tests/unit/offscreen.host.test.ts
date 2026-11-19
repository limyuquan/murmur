/**
 * The offscreen host: answers `start` once the capture is open, reports a load failure with its
 * whole reason (code, packs), lets a stop cancel a load that never ends, and tells the top frame
 * when a player in another frame shows the subtitles.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineUnavailableError } from '@/engines/errors';
import type { ActiveSessionStatus, OverlayMessage, SessionConfig } from '@/messaging/protocol';
import type { OverlayPort } from '@/offscreen/host';

const capture = vi.hoisted(() => ({ stops: 0, fail: null as Error | null }));

vi.mock('@/capture/graph', () => ({
  startCapture: vi.fn(async () => {
    if (capture.fail) throw capture.fail;
    return {
      track: null,
      stop: async () => {
        capture.stops++;
      },
    };
  }),
}));
vi.mock('@/capture/sources', () => ({ tabAudioSource: () => ({}), toneSource: () => ({}) }));
vi.mock('@/engines/hardware', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/engines/hardware')>();
  return { ...original, detectHardware: async () => original.NO_HARDWARE };
});
// The pipeline's callbacks, to play an engine failing while running.
const pipelines = vi.hoisted(() => ({ last: null as null | { onError(err: Error): void } }));
vi.mock('@/pipeline/pipeline', () => ({
  Pipeline: class {
    constructor(options: { onError(err: Error): void }) {
      pipelines.last = options;
    }
    push() {}
    async close() {}
  },
}));
// The demo engines (with the failing ones) are registered in e2e builds.
vi.mock('@/shared/e2e', () => ({ IS_E2E: true }));

const { OffscreenHost, describeError } = await import('@/offscreen/host');

const CONFIG: SessionConfig = {
  sessionId: 's1',
  tabId: 3,
  source: { kind: 'tone' },
  asrEngine: 'demo-needs-pack',
  translationEngine: 'demo-passthrough',
  targetLanguage: 'en',
  sourceLanguage: null,
  translatePartials: false,
};

let sent: ActiveSessionStatus[];
let host: InstanceType<typeof OffscreenHost>;

beforeEach(() => {
  capture.stops = 0;
  capture.fail = null;
  sent = [];
  host = new OffscreenHost({
    send: async (event) => {
      if (event.type === 'session-status') sent.push(event.status);
    },
  });
});

describe('OffscreenHost', () => {
  it('answers once the capture is open, then reports a load failure with its packs', async () => {
    await host.start(CONFIG);
    await host.loaded();
    const last = sent.at(-1);
    expect(last).toMatchObject({ state: 'error', sessionId: 's1', code: 'setup' });
    expect(last?.state === 'error' && last.setup?.[0]?.id).toBe('speech:fr-FR');
    expect(capture.stops).toBe(1);
  });

  it('cancels a load that never ends when stopped', async () => {
    await host.start({ ...CONFIG, asrEngine: 'demo-stalled' });
    await vi.waitFor(() => expect(sent.at(-1)?.state).toBe('loading'));
    await host.stop();
    await host.loaded();
    expect(capture.stops).toBe(1);
    expect(sent.some((s) => s.state === 'error')).toBe(false);
  });

  it('reports an engine part that stopped for good on the running status', async () => {
    await host.start({ ...CONFIG, asrEngine: 'demo-echo' });
    await host.loaded();
    expect(sent.at(-1)?.state).toBe('running');
    pipelines.last?.onError(new EngineUnavailableError('Speech recognition (fr-FR) stopped.'));
    pipelines.last?.onError(new EngineUnavailableError('Speech recognition (fr-FR) stopped.'));
    expect(sent.at(-1)).toMatchObject({
      state: 'running',
      problems: ['Speech recognition (fr-FR) stopped.'],
    });
    await host.stop();
  });

  it('rejects with the reason when the capture fails', async () => {
    capture.fail = new DOMException('denied', 'NotAllowedError');
    const err = await host.start(CONFIG).catch((e: unknown) => e);
    expect(describeError(err)).toMatchObject({ code: 'access' });
    expect(sent.at(-1)).toMatchObject({ state: 'error', code: 'access' });
  });

  it('tells the top frame when a frame below has a video', () => {
    const port = (frameId: number) => {
      const got: OverlayMessage[] = [];
      const p: OverlayPort & { got: OverlayMessage[] } = {
        sender: { tab: { id: 3 }, frameId },
        postMessage: (m) => got.push(m),
        onDisconnect: { addListener: () => {} },
        got,
      };
      return p;
    };
    const top = port(0);
    const frame = port(5);
    host.addOverlay(top);
    host.addOverlay(frame);
    expect(top.got).toContainEqual({ type: 'frames', videoInFrame: false });
    host.setOverlayVideo(frame, true);
    expect(top.got.at(-1)).toEqual({ type: 'frames', videoInFrame: true });
    expect(frame.got.some((m) => m.type === 'frames')).toBe(false);
    host.setOverlayVideo(top, true);
    host.setOverlayVideo(frame, false);
    expect(top.got.at(-1)).toEqual({ type: 'frames', videoInFrame: false });
  });
});
