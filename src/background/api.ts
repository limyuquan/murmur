/** The service worker's dispatcher for popup/options requests. */
import { browser } from 'wxt/browser';
import type { Op, Ops } from '@/messaging/protocol';
import { modelsFor, totalMB } from '@/models/catalog';
import { siteKey } from '@/settings/positions';
import { loadSettings } from '@/settings/settings';
import { deviceHardware, registry } from './engines';
import { modelStore, models } from './models';
import { engineLabels, getStatus, plannedEngines, startSession, stopSession } from './session';

export async function dispatch<K extends Op>(op: K, args: Ops[K][0]): Promise<Ops[K][1]> {
  const handlers: { [P in Op]: (a: Ops[P][0]) => Promise<Ops[P][1]> } = {
    async view({ tabId }) {
      const settings = await loadSettings();
      const status = await getStatus();
      const engines = await plannedEngines(settings);
      const needed = modelsFor(settings.profile, settings.custom, registry, await deviceHardware());
      const downloaded = await modelStore.downloaded(needed);
      const missing = needed.filter((m) => !downloaded.has(m.id));
      const tab = tabId >= 0 ? await browser.tabs.get(tabId).catch(() => null) : null;
      return {
        tabId,
        status,
        thisTab: status.state !== 'idle' && status.tabId === tabId,
        engines: { ...engineLabels(engines), notes: engines.notes },
        profile: settings.profile,
        models: {
          ready: missing.length === 0,
          missingMB: totalMB(missing),
        },
        site: tab?.url ? siteKey(tab.url) : null,
      };
    },
    start: ({ tabId }) => startSession(tabId),
    stop: () => stopSession(),
    models: () => models.view(),
    downloadModels: ({ ids }) => models.download(ids),
    cancelDownload: ({ id }) => models.cancel(id),
    deleteModel: ({ id }) => models.remove(id),
  };
  const handler = handlers[op] as ((a: Ops[K][0]) => Promise<Ops[K][1]>) | undefined;
  if (!handler) throw new Error(`Unknown operation: ${String(op)}`);
  return handler(args);
}
