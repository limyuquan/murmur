import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { call } from '@/messaging/client';
import type { SessionStatus, TabView } from '@/messaging/protocol';

/** Status line under the switch, in plain words. */
export function statusText(view: TabView): string {
  const s = view.status;
  if (s.state === 'idle') return 'Off.';
  if (!view.thisTab) {
    return 'On in another tab. Turning it on here stops that one.';
  }
  switch (s.state) {
    case 'starting':
      return 'Starting…';
    case 'loading':
      return s.progress === null ? `${s.detail}…` : `${s.detail}: ${Math.round(s.progress * 100)}%`;
    case 'running':
      return s.heard ? 'Listening.' : 'Listening. No speech heard yet.';
    case 'error':
      return s.message;
  }
}

function isOn(view: TabView): boolean {
  return view.thisTab && view.status.state !== 'error' && view.status.state !== 'idle';
}

export function Popup({ initial }: { initial: TabView }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // The session's status lives in storage.session; follow it while the popup is open.
  useEffect(() => {
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      const change = changes.session;
      if (area !== 'session' || !change) return;
      const status = (change.newValue as SessionStatus | undefined) ?? { state: 'idle' };
      setView((v) => ({
        ...v,
        status,
        thisTab: status.state !== 'idle' && status.tabId === v.tabId,
      }));
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);

  const on = isOn(view);
  const toggle = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const status = on ? await call('stop', {}) : await call('start', { tabId: view.tabId });
      setView((v) => ({
        ...v,
        status,
        thisTab: status.state !== 'idle' && status.tabId === v.tabId,
      }));
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const error =
    failure ?? (view.thisTab && view.status.state === 'error' ? statusText(view) : null);

  return (
    <main className="w-[320px] p-4 text-sm flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="toggle" className="font-medium">
          Subtitles on this tab
        </label>
        <button
          id="toggle"
          type="button"
          role="switch"
          aria-checked={on}
          className="switch"
          disabled={busy || view.tabId < 0}
          onClick={() => void toggle()}
          data-testid="toggle"
        />
      </div>
      <p
        className={error ? 'text-[var(--color-danger)]' : 'text-[var(--color-muted)]'}
        data-testid="status"
        aria-live="polite"
      >
        {error ?? statusText(view)}
      </p>
      <p className="text-xs text-[var(--color-muted)]">
        Speech: {view.engines.asr}
        <br />
        Translation: {view.engines.translation}
      </p>
      <footer className="flex justify-end">
        <button
          type="button"
          className="link text-xs"
          onClick={() => void browser.runtime.openOptionsPage()}
        >
          Settings
        </button>
      </footer>
    </main>
  );
}
