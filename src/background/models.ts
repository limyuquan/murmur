/** The service worker's one model manager, over the Cache API store. */
import { browser } from 'wxt/browser';
import { allModels, knownModels } from '@/models/catalog';
import { ModelManager } from '@/models/manager';
import { CacheModelStore } from '@/models/store';
import { loadSettings } from '@/settings/settings';
import { deviceHardware, registry } from './engines';

export const modelStore = new CacheModelStore({
  caches: globalThis.caches,
  fetch: (input, init) => fetch(input, init),
});

export const models = new ModelManager({
  async catalog() {
    const settings = await loadSettings();
    return allModels(settings.custom, registry, await deviceHardware());
  },
  async known() {
    return knownModels(registry);
  },
  store: modelStore,
  // A cheap extension API call: keeps the worker from being stopped as idle while a download
  // waits on a slow network.
  keepAlive: () => void browser.runtime.getPlatformInfo().catch(() => {}),
});
