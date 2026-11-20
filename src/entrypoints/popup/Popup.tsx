import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { PROFILES } from '@/engines/profiles';
import { sitePatterns } from '@/lookahead/sites';
import { call } from '@/messaging/client';
import { LOOKAHEAD_PENDING_KEY, type SessionStatus, type TabView } from '@/messaging/protocol';
import { DOWNLOADS_KEY, type DownloadProgress } from '@/models/types';
import { loadPosition, savePosition, watchPositions } from '@/settings/positions';
import { lookaheadOn, type Settings, SIZE_PRESETS } from '@/settings/settings';
import { COMMANDS } from '@/shared/commands';
import { Icon, Keys, Logo, ProgressBar, Segmented, State, Switch } from '@/ui/components';
import { openShortcutSettings, useSettings, useShortcut } from '@/ui/hooks';
import { listNames } from '@/ui/languages';
import { SetupButtons } from '@/ui/setup';
import {
  type BetterState,
  betterKey,
  betterState,
  describeBetter,
  describeStatus,
  type FixAction,
  isOn,
  type StatusLine,
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
 * page load. The switch shows what is stored, and says so while access is being asked for, when
 * it was refused, and that the page needs a reload. Chrome may close the popup while it asks: the
 * service worker then turns it on once access is given (`LOOKAHEAD_PENDING_KEY`).
 */
function AheadRow({ view, settings }: { view: TabView; settings: Settings }) {
  const site = view.site as string;
  // Live from storage: a change from the service worker or the options page shows at once.
  const on = lookaheadOn(settings, site);
  /** The state a click asked for, while access or the change is under way. */
  const [pending, setPending] = useState<{ on: boolean; asking: boolean } | null>(null);
  const [changed, setChanged] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fail = (err: unknown) => {
    setPending(null);
    setProblem(`Couldn’t change this: ${err instanceof Error ? err.message : String(err)}`);
  };
  const apply = (next: boolean) => {
    setPending({ on: next, asking: false });
    call('setLookahead', { site, on: next }).then((result) => {
      setPending(null);
      if (result.sites.includes(site) !== next) {
        setProblem(`Murmur can’t show subtitles ahead of time on ${site}.`);
        return;
      }
      setChanged(true);
    }, fail);
  };
  const toggle = (next: boolean) => {
    setProblem(null);
    if (!next) {
      apply(false);
      return;
    }
    setPending({ on: true, asking: true });
    // Asked for straight from the click; noted first, in case the popup closes meanwhile.
    void browser.storage.session
      .set({ [LOOKAHEAD_PENDING_KEY]: { site, at: Date.now() } })
      .catch(() => {});
    let request: Promise<boolean>;
    try {
      request = browser.permissions.request({ origins: sitePatterns(site) });
    } catch (err) {
      request = Promise.reject(err);
    }
    request.then(
      (granted) => {
        if (granted) {
          apply(true);
        } else {
          setPending(null);
          setProblem(`Murmur needs access to ${site} for this. Chrome didn’t give it.`);
        }
        void browser.storage.session.remove(LOOKAHEAD_PENDING_KEY).catch(() => {});
      },
      (err: unknown) => {
        fail(err);
        void browser.storage.session.remove(LOOKAHEAD_PENDING_KEY).catch(() => {});
      },
    );
  };
  const shown = pending?.on ?? on;
  return (
    <div data-testid="ahead">
      <div className="popup-row">
        <span id="ahead-label">Show subtitles ahead of time (beta)</span>
        <Switch
          checked={shown}
          onChange={toggle}
          labelledBy="ahead-label"
          disabled={pending !== null}
          testId="ahead-switch"
        />
      </div>
      {pending?.asking && (
        <p className="popup-sub" data-testid="ahead-note">
          <span>Waiting for access to {site}…</span>
        </p>
      )}
      {!pending && on && !view.lookahead.supported && (
        <p className="popup-sub">
          <span>
            Needs the Balanced or Best model size. Until then, subtitles come as they’re heard.
          </span>
        </p>
      )}
      {!pending && changed && (
        <p className="popup-sub" data-testid="ahead-note">
          <span>{on ? 'Starts when the page reloads.' : 'Stops when the page reloads.'}</span>
          <button
            type="button"
            className="link"
            onClick={() => {
              void browser.tabs.reload(view.tabId);
              window.close();
            }}
          >
            Reload
          </button>
        </p>
      )}
      {problem && (
        <p className="popup-sub" data-tone="error" data-testid="ahead-problem">
          <span className="tone-text">{problem}</span>
        </p>
      )}
    </div>
  );
}

/**
 * A translation model the profile would use but runs without (Chrome's translator stands in):
 * a plain offer to download it, followed here while the popup is open. "Not now" puts it away
 * for good (`Settings.dismissed`); Settings still lists the model.
 */
function BetterTranslations({
  better,
  dismissed,
  onDismiss,
}: {
  better: NonNullable<TabView['models']['better']>;
  /** The person said "Not now" to this offer: it isn't made again. */
  dismissed: boolean;
  onDismiss(): void;
}) {
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
  if (state.state === 'offer' && dismissed) return null;
  const line = describeBetter(better, state);
  return (
    <div className="panel-extra" data-testid="better">
      {state.state === 'done' ? (
        <State tone="success" icon="check">
          {line.text}
        </State>
      ) : (
        <p
          className={state.state === 'error' ? 't-small tone-text' : 't-small'}
          data-tone={state.state === 'error' ? 'error' : undefined}
        >
          {line.text}
        </p>
      )}
      {line.progress !== undefined && <ProgressBar value={line.progress} label={line.text} />}
      {line.button && (
        <div className="row g2">
          <button type="button" className="btn btn-sm" onClick={download}>
            <Icon name={state.state === 'error' ? 'reload' : 'download'} /> {line.button}
          </button>
          {state.state === 'offer' && (
            <button
              type="button"
              className="btn btn-sm btn-quiet"
              onClick={onDismiss}
              data-testid="better-dismiss"
            >
              Not now
            </button>
          )}
        </div>
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

  const status: StatusLine = failure
    ? { tone: 'error', icon: 'alert', title: 'Something went wrong', detail: failure }
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
    <main className="popup">
      <header className="popup-head">
        <Logo size={24} />
        <h1 className="t-heading grow">Murmur</h1>
        <button
          type="button"
          className="icon-btn"
          aria-label="Settings"
          title="Settings"
          onClick={() => openOptions()}
        >
          <Icon name="gear" size={20} />
        </button>
      </header>

      <section className="popup-main" aria-labelledby="toggle-label">
        <div className="row between g3">
          <span id="toggle-label" className="t-heading">
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

        <div className="panel" data-tone={status.tone} data-testid="status" aria-live="polite">
          <span className="disc">
            <Icon name={status.icon} size={20} />
          </span>
          <div className="panel-body">
            <p className="t-label">{status.title}</p>
            {status.detail && <p className="t-small">{status.detail}</p>}
            {status.progress !== undefined && (
              <ProgressBar value={status.progress} label={status.title} />
            )}
            {languages.length > 0 && (
              <p className="t-small" data-testid="languages">
                Heard: {listNames(languages)}
              </p>
            )}
            {setup.length > 0 && (
              <SetupButtons
                key={setup.map((a) => a.id).join('|')}
                actions={setup}
                primaryFirst={!status.action}
                // The session stopped for these: start it again once they're in.
                onAllDone={failedForSetup ? () => void start() : undefined}
              />
            )}
            {view.models.better && view.models.ready && !failedForSetup && (
              <BetterTranslations
                better={view.models.better}
                dismissed={settings.dismissed.includes(betterKey(view.models.better))}
                onDismiss={() => {
                  const key = betterKey(
                    view.models.better as NonNullable<TabView['models']['better']>,
                  );
                  update((current) => ({ dismissed: [...current.dismissed, key] }));
                }}
              />
            )}
            {status.action && (
              <div className="panel-actions">
                <button
                  type="button"
                  className={
                    status.action.primary === false ? 'btn btn-sm' : 'btn btn-sm btn-primary'
                  }
                  onClick={() => fix(status.action as FixAction)}
                  disabled={busy}
                >
                  {status.action.icon && <Icon name={status.action.icon} />}
                  {status.action.label}
                </button>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="popup-rows" aria-label="Quick settings">
        <div className="popup-row">
          <span id="original-label">Show the original too</span>
          <Switch
            checked={settings.overlay.display === 'both'}
            onChange={(both) => update({ overlay: { display: both ? 'both' : 'translation' } })}
            labelledBy="original-label"
            testId="dual"
          />
        </div>
        <div className="popup-row">
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
          <AheadRow view={view} settings={settings} />
        )}
        {moved && view.site && (
          <div className="popup-row">
            <span className="muted">Moved on {view.site}</span>
            <button
              type="button"
              className="link"
              onClick={() => void savePosition(view.site as string, null)}
            >
              Reset position
            </button>
          </div>
        )}
        <ShortcutRow />
      </section>

      <footer className="popup-foot">
        <span title={`${view.engines.asr} · ${view.engines.translation}`}>
          Models: {profileLabel}
        </span>
        <button type="button" className="link" onClick={() => openOptions()}>
          All settings
        </button>
      </footer>
    </main>
  );
}

/** The key that turns subtitles on or off here, as Chrome has it, and where to change it. */
function ShortcutRow() {
  const shortcut = useShortcut(COMMANDS.toggle);
  if (shortcut === null) return null;
  return (
    <div className="popup-row" data-testid="shortcut">
      <span id="shortcut-label">Keyboard shortcut</span>
      <span className="row g3">
        {shortcut ? <Keys shortcut={shortcut} /> : <span className="t-small muted">Not set</span>}
        <button
          type="button"
          className="link t-small"
          aria-label={shortcut ? 'Change the keyboard shortcut' : 'Set a keyboard shortcut'}
          onClick={() => {
            openShortcutSettings();
            window.close();
          }}
        >
          {shortcut ? 'Change' : 'Set'}
        </button>
      </span>
    </div>
  );
}
