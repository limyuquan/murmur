/**
 * Chrome speech recognizers: one that fails restarts after a growing delay and is given up on
 * (with the reason) instead of spinning; one that Chrome ends after a silence restarts at once;
 * and results are compared from `resultIndex` only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecognizerClass, SpeechResultEvent } from '@/engines/chrome/api';
import { FAILURE_WINDOW_MS, Listener, MAX_FAILURES } from '@/engines/chrome/webspeech';

type Fake = {
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

/** A recognizer class whose `start()` runs `behaviour` on the new recognizer. */
function fakeApi(behaviour: (r: Fake) => void): { api: RecognizerClass; made: Fake[] } {
  const made: Fake[] = [];
  class FakeRecognizer {
    lang = '';
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    processLocally = false;
    onresult = null;
    onerror = null;
    onend = null;
    onstart = null;
    start() {
      made.push(this);
      behaviour(this);
    }
    stop() {}
    abort() {}
  }
  return { api: FakeRecognizer as unknown as RecognizerClass, made };
}

function listener(api: RecognizerClass, onFatal = vi.fn(), onChange = vi.fn()) {
  const l = new Listener(api, {} as MediaStreamTrack, 'fr-FR', [], () => 0, onChange, onFatal);
  return { l, onFatal, onChange };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Listener', () => {
  it('backs off a recognizer that keeps failing, then gives up and says why', async () => {
    const { api, made } = fakeApi((r) => {
      r.onerror?.({ error: 'not-allowed' });
      r.onend?.();
    });
    const { onFatal } = listener(api);
    await vi.advanceTimersByTimeAsync(200);
    // Not a 0 ms loop: one start, then waiting.
    expect(made.length).toBe(1);
    await vi.advanceTimersByTimeAsync(FAILURE_WINDOW_MS);
    expect(made.length).toBe(MAX_FAILURES);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0]?.[0]).toMatchObject({
      name: 'EngineUnavailableError',
      message: 'Speech recognition (fr-FR) stopped: not-allowed.',
    });
    await vi.advanceTimersByTimeAsync(5 * FAILURE_WINDOW_MS);
    expect(made.length).toBe(MAX_FAILURES);
  });

  it('gives up at once on a language Chrome does not offer', async () => {
    const { api, made } = fakeApi((r) => {
      r.onerror?.({ error: 'language-not-supported' });
      r.onend?.();
    });
    const { onFatal } = listener(api);
    await vi.advanceTimersByTimeAsync(FAILURE_WINDOW_MS);
    expect(made.length).toBe(1);
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('restarts at once after Chrome ends it at a long silence', async () => {
    const { api, made } = fakeApi(() => {});
    const { onFatal } = listener(api);
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      made.at(-1)?.onerror?.({ error: 'no-speech' });
      made.at(-1)?.onend?.();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(made.length).toBe(21);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it('counts an update only when a changed result differs', () => {
    const { api, made } = fakeApi(() => {});
    const { l, onChange } = listener(api);
    const r = made[0] as Fake;
    const event = (resultIndex: number, texts: string[], final = false) =>
      ({
        resultIndex,
        results: Object.assign(
          texts.map((t) => Object.assign([{ transcript: t, confidence: 1 }], { isFinal: final })),
          { item: () => null },
        ),
      }) as unknown as SpeechResultEvent;
    r.onresult?.(event(0, ['bonjour']));
    r.onresult?.(event(0, ['bonjour'], true));
    r.onresult?.(event(1, ['bonjour', 'à tous']));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(l.updates).toBe(2);
    expect(l.pending()).toBe('bonjour à tous');
  });
});
