/**
 * The service worker's session: a failed start keeps the offscreen document's reason (code,
 * packs, models), a stop cuts a start short, and late reports never bring a session back.
 * The offscreen document is played by a `runtime.sendMessage` stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import type { SetupAction } from '@/engines/types';
import type { ActiveSessionStatus, OffscreenCommand, OffscreenReply } from '@/messaging/protocol';

const offscreen = vi.hoisted(() => ({ open: false, closes: 0 }));

vi.mock('@/capture/offscreen', () => ({
  OFFSCREEN_PATH: '/offscreen.html',
  ensureOffscreenDocument: vi.fn(async () => {
    offscreen.open = true;
  }),
  closeOffscreenDocument: vi.fn(async () => {
    offscreen.open = false;
    offscreen.closes++;
  }),
  hasOffscreenDocument: vi.fn(async () => offscreen.open),
  mintTabStreamId: vi.fn(async () => 'stream'),
}));
vi.mock('@/background/badge', () => ({ showBadge: vi.fn(async () => {}) }));
vi.mock('@/background/models', () => ({
  modelStore: { downloaded: async () => new Set<string>() },
  models: {},
}));

const ACTION: SetupAction = {
  id: 'speech:fr-FR',
  kind: 'speech-pack',
  label: 'Download French speech recognition',
  languages: ['fr-FR'],
};
const ENGINES = { asr: 'demo-echo', translation: 'demo-passthrough' };
const TAB = 7;

type Session = typeof import('@/background/session');
let session: Session;
/** What the offscreen document does with `start`. */
let onStart: (command: Extract<OffscreenCommand, { type: 'start' }>) => Promise<OffscreenReply>;
let lastSessionId = '';

beforeEach(async () => {
  vi.resetModules();
  offscreen.open = false;
  offscreen.closes = 0;
  lastSessionId = '';
  onStart = async () => ({ ok: true });
  vi.spyOn(browser.scripting, 'executeScript').mockImplementation(async () => []);
  vi.spyOn(browser.runtime, 'sendMessage').mockImplementation((async (message: unknown) => {
    const command = message as OffscreenCommand;
    if (command.type !== 'start') return { ok: true };
    lastSessionId = command.config.sessionId;
    return onStart(command);
  }) as typeof browser.runtime.sendMessage);
  session = await import('@/background/session');
});

afterEach(() => {
  vi.restoreAllMocks();
});

const start = () => session.startSession(TAB, { source: 'tone', engines: ENGINES });

function setupFailure(sessionId: string): Extract<ActiveSessionStatus, { state: 'error' }> {
  return {
    state: 'error',
    tabId: TAB,
    sessionId,
    code: 'setup',
    message: 'Chrome needs to download first: Download French speech recognition.',
    setup: [ACTION],
  };
}

describe('a start that fails in the offscreen document', () => {
  it('keeps the code and the pack buttons from the reply', async () => {
    onStart = async (c) => ({ ok: false, error: setupFailure(c.config.sessionId) });
    const status = await start();
    expect(status).toMatchObject({ state: 'error', code: 'setup', setup: [ACTION] });
    expect(await session.getStatus()).toMatchObject({ code: 'setup', setup: [ACTION] });
    expect(offscreen.open).toBe(false);
  });

  it('keeps the report that arrived before the reply', async () => {
    onStart = async (c) => {
      // The document reports first (as it does), then answers with a bare message.
      void session.onOffscreenStatus(setupFailure(c.config.sessionId));
      await vi.waitFor(async () => expect((await session.getStatus()).state).toBe('error'));
      return { ok: false, error: { message: 'Failed.' } };
    };
    await start();
    expect(await session.getStatus()).toMatchObject({ code: 'setup', setup: [ACTION] });
  });

  it('keeps the missing models of a failure while loading, and ends the session', async () => {
    await start();
    expect(offscreen.open).toBe(true);
    await session.onOffscreenStatus({
      state: 'error',
      tabId: TAB,
      sessionId: lastSessionId,
      code: 'model',
      message: 'Whisper base isn’t downloaded yet.',
      missingModels: ['whisper-base-wasm'],
    });
    expect(await session.getStatus()).toMatchObject({
      state: 'error',
      code: 'model',
      missingModels: ['whisper-base-wasm'],
    });
    expect(offscreen.open).toBe(false);
  });
});

describe('stopping', () => {
  it('cuts short a start that never answers', async () => {
    onStart = () => new Promise(() => {});
    const starting = start();
    await vi.waitFor(() => expect(lastSessionId).not.toBe(''));
    const stopped = await session.stopSession();
    expect(stopped).toEqual({ state: 'idle' });
    expect(offscreen.open).toBe(false);
    // The start gives up without writing over the stop.
    expect((await starting).state).not.toBe('error');
    expect(await session.getStatus()).toEqual({ state: 'idle' });
  });

  it('lets another tab take over while a start hangs', async () => {
    onStart = () => new Promise(() => {});
    void start();
    await vi.waitFor(() => expect(lastSessionId).not.toBe(''));
    const first = lastSessionId;
    onStart = async () => ({ ok: true });
    const status = await session.startSession(TAB + 1, { source: 'tone', engines: ENGINES });
    expect(status).toMatchObject({ state: 'starting', tabId: TAB + 1 });
    expect(lastSessionId).not.toBe(first);
  });

  it('ignores reports that arrive after the stop', async () => {
    await start();
    const running: ActiveSessionStatus = {
      state: 'running',
      tabId: TAB,
      sessionId: lastSessionId,
      asr: 'a',
      translation: 't',
      heard: false,
    };
    await session.onOffscreenStatus(running);
    expect((await session.getStatus()).state).toBe('running');
    // A report racing the stop, and one after it.
    await Promise.all([session.onOffscreenStatus(running), session.stopSession()]);
    await session.onOffscreenStatus(running);
    expect(await session.getStatus()).toEqual({ state: 'idle' });
  });

  it('ignores reports from another session', async () => {
    await start();
    await session.onOffscreenStatus(setupFailure('another'));
    expect((await session.getStatus()).state).toBe('starting');
    expect(offscreen.open).toBe(true);
  });
});
