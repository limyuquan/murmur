import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { PROFILES } from '@/engines/profiles';
import { sitePatterns } from '@/lookahead/sites';
import { call } from '@/messaging/client';
import type { SessionStatus, TabView } from '@/messaging/protocol';
import { DOWNLOADS_KEY, type DownloadProgress } from '@/models/types';
import { loadPosition, savePosition, watchPositions } from '@/settings/positions';
import { type Settings, SIZE_PRESETS } from '@/settings/settings';
import { Dot, Icon, Logo, ProgressBar, Segmented, Switch } from '@/ui/components';
import { useSettings } from '@/ui/hooks';
import { listNames } from '@/ui/languages';
import { SetupButtons } from '@/ui/setup';
import {
  type BetterState,
  betterState,
  describeBetter,
  describeStatus,
  type FixAction,
  isOn,
} from './status';

function openOptions(section?: string): void {
  if (section) {
    void browser.tabs.create({ url: browser.runtime.getURL(`/options.html#${section}`) });
  } else {
    void browser.runtime.openOptionsPage();
  }
  window.close();
}

/**
 * Subtitles ahead of time on this site (beta). Turning it on asks for access to the site (the
 * click is what lets the browser ask), then registers the page scripts; they start with the next
 * page load.
 */
function AheadRow({ view, onChange }: { view: TabView; onChange(on: boolean): void }) {
  const site = view.site as string;
  const [on, setOn] = useState(view.lookahead.on);
  const [changed, setChanged] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const toggle = (next: boolean) => {
    setProblem(null);
    const apply = () =>
      call('setLookahead', { site, on: next }).then(
        () => {
          setOn(next);
          setChanged(true);
          onChange(next);
        },
        (err: unknown) => setProblem(err instanceof Error ? err.message : String(err)),
      );
    if (!next) {
      void apply();
      return;
    }
    // Asked for straight from the click.
    browser.permissions.request({ origins: sitePatterns(site) }).then(
      (granted) => {
        if (granted) void apply();
        else setProblem(`Murmur needs access to ${site} for this.`);
      },
      (err: unknown) => setProblem(err instanceof Error ? err.message : String(err)),
    );
  };
  return (
    <div data-testid="ahead">
      <div className="flex h-9 items-center justify-between gap-3">
        <span id="ahead-label">Show subtitles ahead of time (beta)</span>
        <Switch checked={on} onChange={toggle} labelledBy="ahead-label" testId="ahead-switch" />
      </div>
      {on && !view.lookahead.supported && (
        <p className="text-[12px] text-[var(--color-muted)]">
          Needs the Balanced or Best model size. Until then, subtitles come as they’re heard.
        </p>
      )}
      {on && changed && (
        <p className="flex items-center justify-between gap-3 text-[12px] text-[var(--color-muted)]">
          <span>Starts when the page reloads.</span>
          <button
            type="button"
            className="link flex-none"
            onClick={() => {
              void browser.tabs.reload(view.tabId);
              window.close();
            }}
          >
            Reload
          </button>
        </p>
      )}
      {problem && <p className="text-[12px] text-[var(--color-danger)]">{problem}</p>}
    </div>
  );
}

/**
 * A translation model the profile would use but runs without (Chrome's translator stands in):
 * a plain offer to download it, followed here while the popup is open.
 */
function BetterTranslations({ better }: { better: NonNullable<TabView['models']['better']> }) {
  const [state, setState] = useState<BetterState>({ state: 'offer' });
  useEffect(() => {
    const apply = (progress: DownloadProgress) =>
      setState((previous) => betterState(better, progress, previous));
    browser.storage.session.get(DOWNLOADS_KEY).then(
      (stored) => apply((stored[DOWNLOADS_KEY] ?? {}) as DownloadProgress),
      () => {},
    );
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      const change = changes[DOWNLOADS_KEY];
      if (area === 'session' && change) apply((change.newValue ?? {}) as DownloadProgress);
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, [better]);
  const download = () => {
    setState({ state: 'downloading', fraction: null });
    call('downloadModels', { ids: better.ids }).catch((err: unknown) =>
      setState({ state: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
  };
  const line = describeBetter(better, state);
  return (
    <div className="mt-3 ml-[18px]" data-testid="better">
      <p className="text-[12px] text-[var(--color-muted)]">{line.text}</p>
      {line.progress !== undefined && (
        <div className="mt-1.5">
          <ProgressBar value={line.progress} label={line.text} />
        </div>
      )}
      {line.button && (
        <button type="button" className="btn btn-sm mt-2" onClick={download}>
          {line.button}
        </button>
      )}
    </div>
  );
}

export function Popup({
  initial,
  settings: initialSettings,
}: {
  initial: TabView;
  settings: Settings;
}) {
  const [view, setView] = useState(initial);
  const [settings, update] = useSettings(initialSettings);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);
  /** The newest request: answers to older ones are dropped. */
  const latest = useRef(0);
  const starting = useRef(false);

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

  // Whether subtitles were dragged on this site.
  useEffect(() => {
    const site = view.site;
    if (!site) return;
    loadPosition(site).then(
      (p) => setMoved(p !== null),
      () => {},
    );
    return watchPositions((all) => setMoved(!!all[site]));
  }, [view.site]);

  // A start under way shows as on, so the switch can stop it at once.
  const on = isOn(view) || starting.current;
  const run = async (work: () => Promise<SessionStatus>, isStart = false) => {
    const id = ++latest.current;
    setBusy(true);
    setFailure(null);
    if (isStart) starting.current = true;
    try {
      const status = await work();
      // A later click wins over an earlier answer (a stop while the start was under way).
      if (id !== latest.current) return;
      setView((v) => ({
        ...v,
        status,
        thisTab: status.state !== 'idle' && status.tabId === v.tabId,
      }));
    } catch (err) {
      if (id === latest.current) setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      if (isStart) starting.current = false;
      if (id === latest.current) setBusy(false);
    }
  };
  const start = () => run(() => call('start', { tabId: view.tabId }), true);
  const toggle = () => {
    if (on) {
      starting.current = false;
      return run(() => call('stop', {}));
    }
    return start();
  };

  const fix = (action: FixAction) => {
    switch (action.kind) {
      case 'retry':
        void start();
        break;
      case 'settings':
        openOptions(action.section);
        break;
      case 'profile':
        update({ profile: action.profile });
        setView((v) => ({ ...v, profile: action.profile }));
        // Restart with the new models.
        void run(async () => {
          await call('stop', {});
          return call('start', { tabId: view.tabId });
        }, true);
        break;
    }
  };

  const status = failure
    ? { tone: 'error' as const, title: 'Something went wrong', detail: failure }
    : describeStatus(view);
  const activity =
    view.status.state === 'running' && view.thisTab ? view.status.activity : undefined;
  // Downloads only a click can start (Chrome language packs), asked for by the session.
  const setup =
    view.thisTab && (view.status.state === 'running' || view.status.state === 'error')
      ? (view.status.setup ?? [])
      : [];
  const failedForSetup = view.status.state === 'error' && setup.length > 0;
  const languages = activity?.languages ?? [];
  const sizePreset = SIZE_PRESETS.find(
    (p) => Math.abs(p.scale - settings.overlay.fontScale) < 0.01,
  );
  const profileLabel = view.profile === 'custom' ? 'Custom' : PROFILES[view.profile].label;

  return (
    <main className="flex w-[340px] flex-col text-[13px]">
      <header className="flex items-center gap-2 px-4 pt-3 pb-2">
        <Logo size={20} />
        <h1 className="text-[14px] font-semibold tracking-[-0.01em]">Murmur</h1>
        <button
          type="button"
          className="icon-btn ml-auto"
          aria-label="Settings"
          title="Settings"
          onClick={() => openOptions()}
        >
          <Icon name="gear" size={17} />
        </button>
      </header>

      <section className="card mx-3 p-3.5" aria-labelledby="toggle-label">
        <div className="flex items-center justify-between gap-3">
          <span id="toggle-label" className="text-[14px] font-semibold">
            Subtitles on this tab
          </span>
          <Switch
            large
            checked={on}
            onChange={() => void toggle()}
            labelledBy="toggle-label"
            // Never disabled while busy: switching off must cut a start short.
            disabled={view.tabId < 0}
            testId="toggle"
          />
        </div>

        <div className="mt-2.5 flex items-start gap-2.5" data-testid="status" aria-live="polite">
          <span className="mt-[5px]">
            <Dot tone={status.tone} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium">{status.title}</p>
            {status.detail && <p className="mt-0.5 text-[var(--color-muted)]">{status.detail}</p>}
          </div>
        </div>
        {'progress' in status && status.progress !== undefined && (
          <div className="mt-2.5 ml-[18px]">
            <ProgressBar value={status.progress} label={status.title} />
          </div>
        )}
        {languages.length > 0 && (
          <p
            className="mt-2 ml-[18px] text-[12px] text-[var(--color-muted)]"
            data-testid="languages"
          >
            Heard: {listNames(languages)}
          </p>
        )}
        {setup.length > 0 && (
          <div className="mt-3 ml-[18px]">
            <SetupButtons
              key={setup.map((a) => a.id).join('|')}
              actions={setup}
              // The session stopped for these: start it again once they're in.
              onAllDone={failedForSetup ? () => void start() : undefined}
            />
          </div>
        )}
        {view.models.better && view.models.ready && !failedForSetup && (
          <BetterTranslations better={view.models.better} />
        )}
        {'action' in status && status.action && (
          <div className="mt-3 ml-[18px]">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => fix(status.action as FixAction)}
              disabled={busy}
            >
              {status.action.label}
            </button>
          </div>
        )}
      </section>

      <section className="grid gap-1 px-4 py-3" aria-label="Quick settings">
        <div className="flex h-9 items-center justify-between gap-3">
          <span id="original-label">Show the original too</span>
          <Switch
            checked={settings.overlay.display === 'both'}
            onChange={(both) => update({ overlay: { display: both ? 'both' : 'translation' } })}
            labelledBy="original-label"
            testId="dual"
          />
        </div>
        <div className="flex h-9 items-center justify-between gap-3">
          <span>Text size</span>
          <Segmented
            label="Text size"
            value={sizePreset?.id ?? null}
            options={SIZE_PRESETS.map((p) => ({ value: p.id, label: p.label, title: p.name }))}
            onChange={(id) => {
              const preset = SIZE_PRESETS.find((p) => p.id === id);
              if (preset) update({ overlay: { fontScale: preset.scale } });
            }}
            testId="size"
          />
        </div>
        {view.site && !view.lookahead.off && view.tabId >= 0 && (
          <AheadRow
            view={view}
            onChange={(on) => setView((v) => ({ ...v, lookahead: { ...v.lookahead, on } }))}
          />
        )}
        {moved && view.site && (
          <div className="flex h-9 items-center justify-between gap-3">
            <span className="text-[var(--color-muted)]">Moved on {view.site}</span>
            <button
              type="button"
              className="link text-[12px]"
              onClick={() => void savePosition(view.site as string, null)}
            >
              Reset position
            </button>
          </div>
        )}
      </section>

      <footer className="divider flex items-center justify-between gap-3 px-4 py-2.5 text-[12px] text-[var(--color-muted)]">
        <span className="truncate" title={`${view.engines.asr} · ${view.engines.translation}`}>
          Models: {profileLabel}
        </span>
        <button type="button" className="link flex-none" onClick={() => openOptions()}>
          All settings
        </button>
      </footer>
    </main>
  );
}
