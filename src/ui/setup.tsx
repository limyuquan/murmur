/**
 * Chrome language packs in the extension pages: their status, and a button per download. Chrome
 * only starts a pack download from a click, so each button calls `runSetupAction` straight from
 * its click handler, before anything is awaited (engines/chrome/setup.ts).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Availability } from '@/engines/chrome/api';
import { runSetupAction, setupState } from '@/engines/chrome/setup';
import type { SetupAction } from '@/engines/types';
import { Icon, ProgressBar } from './components';

export type PackState =
  | { state: Availability }
  /** Started from a click here: `fraction` when Chrome reports progress. */
  | { state: 'running'; fraction: number | null }
  | { state: 'failed'; message: string };

/** How often packs being downloaded are checked again, ms. */
const POLL_MS = 2000;

/**
 * Each action's state, checked on mount and every few seconds while any is downloading, and a
 * `run` to call from a click handler. `onDone` runs after an action started here finishes.
 */
export function usePacks(
  actions: readonly SetupAction[],
  onDone?: (action: SetupAction) => void,
): [Record<string, PackState>, (action: SetupAction) => void] {
  const [states, setStates] = useState<Record<string, PackState>>({});
  const key = actions.map((a) => a.id).join('|');
  const done = useRef(onDone);
  done.current = onDone;
  const list = useRef(actions);
  list.current = actions;

  const check = useCallback(async () => {
    const entries = await Promise.all(
      list.current.map(
        async (a) => [a.id, await setupState(a).catch(() => 'unavailable' as const)] as const,
      ),
    );
    setStates((prev) => {
      const next: Record<string, PackState> = {};
      for (const [id, state] of entries) {
        const p = prev[id];
        // Keep the progress of a download started here until Chrome says it's done.
        next[id] = p?.state === 'running' && state !== 'available' ? p : { state };
      }
      return next;
    });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-check when the list changes.
  useEffect(() => {
    void check();
  }, [key, check]);

  const busy = Object.values(states).some(
    (s) => s.state === 'downloading' || s.state === 'running',
  );
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void check(), POLL_MS);
    return () => clearInterval(timer);
  }, [busy, check]);

  const run = useCallback((action: SetupAction) => {
    // Synchronously, inside the click: Chrome needs the click's activation for the download.
    const work = runSetupAction(action, (fraction) =>
      setStates((s) => ({ ...s, [action.id]: { state: 'running', fraction } })),
    );
    setStates((s) => ({ ...s, [action.id]: { state: 'running', fraction: null } }));
    work.then(
      () => {
        setStates((s) => ({ ...s, [action.id]: { state: 'available' } }));
        done.current?.(action);
      },
      (err: unknown) =>
        setStates((s) => ({
          ...s,
          [action.id]: {
            state: 'failed',
            message: err instanceof Error ? err.message : String(err),
          },
        })),
    );
  }, []);
  return [states, run];
}

/** One row per pack: what it is, its state, and Download when it needs one. */
export function PackRow({
  action,
  state,
  run,
  compact,
}: {
  action: SetupAction;
  state: PackState | undefined;
  run(action: SetupAction): void;
  compact?: boolean;
}) {
  const name = action.label.replace(/^Download /, '');
  let status: React.ReactNode;
  let button: React.ReactNode = null;
  switch (state?.state) {
    case undefined:
      status = <span className="text-[var(--color-muted)]">Checking…</span>;
      break;
    case 'available':
      status = (
        <span className="inline-flex items-center gap-1 text-[var(--color-accent)]">
          <Icon name="check" size={14} /> Downloaded
        </span>
      );
      break;
    case 'downloadable':
      status = <span className="text-[var(--color-muted)]">Not downloaded</span>;
      button = (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => run(action)}
          aria-label={action.label}
        >
          <Icon name="download" size={14} /> Download
        </button>
      );
      break;
    case 'downloading':
    case 'running': {
      const fraction = state.state === 'running' ? state.fraction : null;
      status = (
        <span className="flex min-w-[140px] flex-col gap-1">
          <span className="text-[var(--color-muted)]">
            {fraction === null
              ? 'Chrome is downloading it…'
              : `Downloading… ${Math.round(fraction * 100)}%`}
          </span>
          <ProgressBar value={fraction} label={`Downloading ${name}`} />
        </span>
      );
      break;
    }
    case 'unavailable':
      status = <span className="text-[var(--color-muted)]">Not offered by this browser</span>;
      break;
    case 'failed':
      status = <span className="text-[var(--color-danger)]">{state.message}</span>;
      button = (
        <button type="button" className="btn btn-sm" onClick={() => run(action)}>
          Try again
        </button>
      );
      break;
  }
  return (
    <li
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 ${compact ? 'py-2' : 'py-3'}`}
      data-testid={`pack-${action.id}`}
    >
      {!compact && (
        <span className="grid size-8 flex-none place-items-center rounded-lg bg-[var(--color-sunken)] text-[var(--color-muted)]">
          <Icon name={action.kind === 'speech-pack' ? 'speech' : 'globe'} />
        </span>
      )}
      <span className="min-w-[160px] flex-1">
        <span className="block font-medium first-letter:uppercase">{name}</span>
        {!compact && <span className="block text-[12px] text-[var(--color-muted)]">By Chrome</span>}
      </span>
      <span className="text-[13px]">{status}</span>
      {button && <span className="ml-auto">{button}</span>}
    </li>
  );
}

/**
 * Buttons for the downloads a session asked for (popup): one per action, each showing its
 * progress once clicked. `onAllDone` runs when every listed pack is on disk after a click here.
 */
export function SetupButtons({
  actions,
  onAllDone,
}: {
  actions: readonly SetupAction[];
  onAllDone?: (() => void) | undefined;
}) {
  const [states, run] = usePacks(actions);
  const started = useRef(false);
  const fired = useRef(false);
  const allDone = actions.length > 0 && actions.every((a) => states[a.id]?.state === 'available');
  const onAllDoneRef = useRef(onAllDone);
  onAllDoneRef.current = onAllDone;
  useEffect(() => {
    if (!allDone || !started.current || fired.current) return;
    fired.current = true;
    onAllDoneRef.current?.();
  }, [allDone]);
  const click = (action: SetupAction) => {
    started.current = true;
    run(action);
  };
  return (
    <ul className="grid gap-2" data-testid="setup-actions">
      {actions.map((a) => {
        const s = states[a.id];
        if (s?.state === 'available') {
          return (
            <li
              key={a.id}
              className="flex items-center gap-1.5 text-[12px] text-[var(--color-accent)]"
            >
              <Icon name="check" size={13} /> {a.label.replace(/^Download /, '')}: downloaded
            </li>
          );
        }
        if (s?.state === 'running' || s?.state === 'downloading') {
          const fraction = s.state === 'running' ? s.fraction : null;
          return (
            <li key={a.id} className="grid gap-1">
              <span className="text-[12px] text-[var(--color-muted)]">
                {a.label.replace(/^Download/, 'Downloading')}
                {fraction !== null && ` · ${Math.round(fraction * 100)}%`}
              </span>
              <ProgressBar value={fraction} label={a.label} />
            </li>
          );
        }
        if (s?.state === 'unavailable') {
          return (
            <li key={a.id} className="text-[12px] text-[var(--color-muted)]">
              {a.label.replace(/^Download /, '')}: Chrome doesn’t offer this on this device.
            </li>
          );
        }
        return (
          <li key={a.id} className="grid gap-1">
            <button
              type="button"
              className="btn btn-sm btn-wrap justify-self-start"
              onClick={() => click(a)}
            >
              <Icon name="download" size={14} /> <span>{a.label}</span>
            </button>
            {s?.state === 'failed' && (
              <span className="text-[12px] text-[var(--color-danger)]">{s.message}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
