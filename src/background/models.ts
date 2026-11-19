/** The service worker's one model manager, over the Cache API store. */
import { browser } from 'wxt/browser';
import { allModels, knownModels } from '@/models/catalog';
import { HUGGING_FACE, MODEL_HOST } from '@/models/hub';
import { ModelManager } from '@/models/manager';
import { CacheModelStore } from '@/models/store';
import { loadMemoryFit, resolveOptions } from '@/settings/memoryfit';
import { loadSettings } from '@/settings/settings';
import { deviceHardware, registry } from './engines';

export const modelStore = new CacheModelStore({
  caches: globalThis.caches,
  fetch: (input, init) => fetch(input, init),
  // The hashes are Hugging Face's; the e2e stand-in serves a pattern.
  verify: MODEL_HOST === HUGGING_FACE,
});

export const models = new ModelManager({
  async catalog() {
    const settings = await loadSettings();
    const hardware = await deviceHardware();
    const fit = await loadMemoryFit();
    return allModels(settings.custom, registry, hardware, (profile) =>
      resolveOptions(settings, profile, hardware, fit),
    );
  },
  async known() {
    return knownModels(registry);
  },
  store: modelStore,
  // A cheap extension API call: keeps the worker from being stopped as idle while a download
  // waits on a slow network.
  keepAlive: () => void browser.runtime.getPlatformInfo().catch(() => {}),
});
