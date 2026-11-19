/** The service worker's one model manager. */
import { allModels } from '@/models/catalog';
import { ModelManager } from '@/models/manager';
import { SimulatedModelStore } from '@/models/simulated';
import { loadSettings } from '@/settings/settings';
import { deviceHardware, registry } from './session';

export const models = new ModelManager({
  async catalog() {
    const settings = await loadSettings();
    return allModels(settings.custom, registry, await deviceHardware());
  },
  simulated: new SimulatedModelStore(),
  // The real store (Cache API / OPFS) arrives with the first engine that downloads a model.
  real: null,
});
