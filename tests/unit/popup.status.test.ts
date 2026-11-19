import { describe, expect, it } from 'vitest';
import { describeStatus, isOn, NO_SOUND_MS } from '@/entrypoints/popup/status';
import type { SessionActivity, SessionStatus, TabView } from '@/messaging/protocol';

function view(status: SessionStatus, patch: Partial<TabView> = {}): TabView {
  return {
    tabId: 1,
    status,
    thisTab: status.state !== 'idle' && status.tabId === 1,
    engines: { asr: 'Demo', translation: 'Demo', notes: [] },
    profile: 'balanced',
    models: { ready: true, missingMB: 0 },
    site: 'example.com',
    ...patch,
  };
}

const activity = (patch: Partial<SessionActivity> = {}): SessionActivity => ({
  stage: 'listening',
  languages: ['fr'],
  unsupported: [],
  delayMs: 2400,
  behind: false,
  rtf: null,
  backlogMs: 0,
  queue: 0,
  silentMs: 0,
  soundEver: true,
  ...patch,
});

const running = (a?: SessionActivity, heard = true): SessionStatus => ({
  state: 'running',
  tabId: 1,
  sessionId: 's',
  asr: 'Demo',
  translation: 'Demo',
  heard,
  ...(a && { activity: a }),
});

describe('describeStatus', () => {
  it('is off, and offers the download when models are missing', () => {
    expect(describeStatus(view({ state: 'idle' }))).toEqual({ tone: 'off', title: 'Off' });
    const missing = describeStatus(
      view({ state: 'idle' }, { models: { ready: false, missingMB: 2400 } }),
    );
    expect(missing.detail).toContain('2.4 GB');
    expect(missing.action).toMatchObject({ kind: 'settings', section: 'models' });
  });

  it('says when the session is on another tab', () => {
    const s = describeStatus(view(running(activity()), { tabId: 2, thisTab: false }));
    expect(s.title).toBe('On in another tab');
    expect(isOn(view(running(activity()), { tabId: 2, thisTab: false }))).toBe(false);
  });

  it('shows loading progress', () => {
    const s = describeStatus(
      view({ state: 'loading', tabId: 1, sessionId: 's', progress: 0.5, detail: 'Loading model' }),
    );
    expect(s).toMatchObject({ tone: 'busy', title: 'Loading model…', progress: 0.5 });
  });

  it('names the stage and the delay while running', () => {
    expect(describeStatus(view(running(activity({ stage: 'translating' }))))).toMatchObject({
      tone: 'ok',
      title: 'Translating',
      detail: 'About 2.4 s behind the speech.',
    });
    expect(describeStatus(view(running(undefined, false))).title).toBe('Listening');
  });

  it('explains silence that may be protected video', () => {
    const s = describeStatus(
      view(running(activity({ soundEver: false, silentMs: NO_SOUND_MS }), false)),
    );
    expect(s).toMatchObject({ tone: 'warn', title: 'No sound from this tab' });
    expect(s.detail).toContain('DRM');
  });

  it('offers lighter models when falling behind', () => {
    const s = describeStatus(view(running(activity({ behind: true, delayMs: 7800 }))));
    expect(s).toMatchObject({ tone: 'warn', title: 'Falling behind' });
    expect(s.action).toEqual({ kind: 'profile', label: 'Use Light models', profile: 'light' });
    const light = describeStatus(view(running(activity({ behind: true })), { profile: 'light' }));
    expect(light.action).toBeUndefined();
  });

  it('says why it falls behind: speed, translation queue or speech backlog', () => {
    const slow = describeStatus(view(running(activity({ behind: true, rtf: 1.42 }))));
    expect(slow.detail).toMatch(/^Speech recognition takes 1\.4 s for each second of speech/);
    const queued = describeStatus(view(running(activity({ behind: true, queue: 4 }))));
    expect(queued.detail).toMatch(/^4 lines are waiting for their translation\./);
    const backlog = describeStatus(
      view(running(activity({ behind: true, backlogMs: 6200, delayMs: null }))),
    );
    expect(backlog.detail).toBe('6 s of speech is waiting for speech recognition.');
  });

  it('asks for language packs a running session met', () => {
    const status = running(activity());
    const withSetup = {
      ...status,
      setup: [
        { id: 'translation:de>en', kind: 'translation-pack', label: 'x', languages: ['de', 'en'] },
      ],
    } as SessionStatus;
    expect(describeStatus(view(withSetup))).toMatchObject({
      tone: 'warn',
      title: 'Some lines need a download',
    });
  });

  it('names languages the models lack', () => {
    const s = describeStatus(view(running(activity({ unsupported: ['de'] }))));
    expect(s.title).toMatch(/^Can't translate /);
  });

  it('turns error codes into a fix', () => {
    const err = (code: string) =>
      describeStatus(
        view({ state: 'error', tabId: 1, sessionId: 's', message: 'm', code } as SessionStatus, {
          profile: 'best',
        }),
      );
    expect(err('page').action).toBeUndefined();
    expect(err('busy').action).toMatchObject({ kind: 'retry' });
    expect(err('companion').action).toMatchObject({ kind: 'profile', profile: 'balanced' });
    expect(err('model')).toMatchObject({
      title: 'A model didn’t load',
      action: { kind: 'settings', label: 'Models' },
    });
    expect(err('setup')).toMatchObject({ tone: 'warn' });
    expect(err('setup').action).toBeUndefined();
    const missing = describeStatus(
      view({
        state: 'error',
        tabId: 1,
        sessionId: 's',
        message: 'Whisper base isn’t downloaded yet.',
        code: 'model',
        missingModels: ['whisper-base-wasm'],
      }),
    );
    expect(missing).toMatchObject({
      title: 'The model isn’t downloaded',
      action: { kind: 'settings', label: 'Download', section: 'models' },
    });
    expect(err('anything')).toMatchObject({ tone: 'error', detail: 'm' });
  });
});
