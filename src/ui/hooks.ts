/** State hooks shared by the extension pages. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { detectHardware, type HardwareInfo } from '@/engines/hardware';
import { call } from '@/messaging/client';
import { DOWNLOADS_KEY, type DownloadProgress, type ModelsView } from '@/models/types';
import { loadMemoryFit, type MemoryFit, watchMemoryFit } from '@/settings/memoryfit';
import {
  applyChange,
  loadSettings,
  type Settings,
  type SettingsChange,
  saveSettings,
  watchSettings,
} from '@/settings/settings';

/**
 * Settings, kept in step with storage (another page, the popup or the service worker may change
 * them). `update` stores only the fields it is given (or a function of the stored settings): the
 * page's copy is never written back, so it can't undo a change made elsewhere.
 */
export function useSettings(initial: Settings): [Settings, (change: SettingsChange) => void] {
  const [settings, setSettings] = useState(initial);
  useEffect(() => watchSettings(setSettings), []);
  const update = useCallback((change: SettingsChange) => {
    // Show the change at once (controls stay in step with the click), then store it. The stored
    // result comes back through `watchSettings`, in the order writes happened; the value a save
    // resolves with may already be older than a change from elsewhere.
    setSettings((s) => applyChange(s, change));
    saveSettings(change).catch((err: unknown) => {
      console.error(err);
      loadSettings().then(setSettings, () => {});
    });
  }, []);
  return [settings, update];
}

/** Loads settings once; null until read. */
export function useLoadedSettings(): Settings | null {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    loadSettings().then(setSettings, () => {});
  }, []);
  return settings;
}

export function useHardware(): HardwareInfo | null {
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  useEffect(() => {
    detectHardware().then(setHardware, () => {});
  }, []);
  return hardware;
}

/** Which memory-ladder step worked on this device, per profile (settings/memoryfit.ts), live. */
export function useMemoryFit(): MemoryFit | null {
  const [fit, setFit] = useState<MemoryFit | null>(null);
  useEffect(() => {
    loadMemoryFit().then(setFit, () => setFit({}));
    return watchMemoryFit(setFit);
  }, []);
  return fit;
}

export interface ModelActions {
  download(ids: string[]): void;
  cancel(id: string): void;
  remove(id: string): void;
}

/**
 * Every model and its state, following download progress live. Progress arrives a few times a
 * second through `storage.session`; when a download ends the full view is fetched again.
 */
export function useModels(): [ModelsView | null, ModelActions, string | null] {
  const [view, setView] = useState<ModelsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    call('models', {}).then(setView, (err: Error) => setError(err.message));
  }, []);

  // Ids under way at the last progress report: one that drops out has finished (or failed).
  const underway = useRef(new Set<string>());

  useEffect(() => {
    refresh();
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      const change = changes[DOWNLOADS_KEY];
      if (area !== 'session' || !change) return;
      const progress = (change.newValue ?? {}) as DownloadProgress;
      const ids = new Set(Object.keys(progress));
      const finished = [...underway.current].some((id) => !ids.has(id));
      underway.current = ids;
      if (finished) {
        refresh();
        return;
      }
      setView((v) =>
        v
          ? {
              ...v,
              models: v.models.map((m) => {
                const p = progress[m.info.id];
                return p ? { ...m, status: p } : m;
              }),
            }
          : v,
      );
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, [refresh]);

  const run = useCallback((p: Promise<ModelsView>) => {
    setError(null);
    p.then(setView, (err: Error) => setError(err.message));
  }, []);

  const actions: ModelActions = {
    download: (ids) => run(call('downloadModels', { ids })),
    cancel: (id) => run(call('cancelDownload', { id })),
    remove: (id) => run(call('deleteModel', { id })),
  };
  return [view, actions, error];
}

/** `prefers-reduced-motion`, live. */
export function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setReduced(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return reduced;
}

/**
 * The key binding of a command (`COMMANDS`, src/shared/commands.ts) as Chrome has it now:
 * "Alt+Shift+S", "" when none is set, or null until read.
 */
export function useShortcut(name: string): string | null {
  const [shortcut, setShortcut] = useState<string | null>(null);
  useEffect(() => {
    browser.commands.getAll().then(
      (commands) => setShortcut(commands.find((c) => c.name === name)?.shortcut ?? ''),
      () => setShortcut(''),
    );
  }, [name]);
  return shortcut;
}

/** Chrome's page for changing extension shortcuts (only an extension page can open it). */
export function openShortcutSettings(): void {
  void browser.tabs.create({ url: 'chrome://extensions/shortcuts' });
}
