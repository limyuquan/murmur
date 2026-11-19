import { describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createBuiltinRegistry } from '@/engines/builtin';
import { ECHO_ASR_INFO, PASSTHROUGH_INFO } from '@/engines/demo/info';
import { NO_HARDWARE } from '@/engines/hardware';
import { DEMO_ASR_ID, DEMO_TRANSLATION_ID } from '@/engines/profiles';
import { EngineRegistry } from '@/engines/registry';
import { allModels, modelsFor, totalMB } from '@/models/catalog';
import { ModelManager } from '@/models/manager';
import { PLANNED_MODELS } from '@/models/planned';
import { DOWNLOADS_KEY, formatSize, type ModelInfo, type ModelStore } from '@/models/types';

const custom = { asr: DEMO_ASR_ID, translation: DEMO_TRANSLATION_ID };

describe('catalog', () => {
  it('uses the planned models while profiles resolve to engines without models', () => {
    const registry = createBuiltinRegistry();
    expect(modelsFor('light', custom, registry, NO_HARDWARE)).toEqual(PLANNED_MODELS.light);
    expect(modelsFor('custom', custom, registry, NO_HARDWARE)).toEqual([]);
    const all = allModels(custom, registry, NO_HARDWARE);
    expect(all).toHaveLength(6);
    expect(all.every((m) => m.profiles.length === 1)).toBe(true);
  });

  it("uses an engine's own models when it declares them", () => {
    const registry = new EngineRegistry()
      .registerAsr({
        info: { ...ECHO_ASR_INFO, models: [{ id: 'm-asr', label: 'Speech', sizeMB: 100 }] },
        create: () => Promise.reject(new Error('unused')),
      })
      .registerTranslation({
        info: PASSTHROUGH_INFO,
        create: () => Promise.reject(new Error('x')),
      });
    const models = modelsFor('balanced', custom, registry, NO_HARDWARE);
    expect(models).toEqual([
      {
        id: 'm-asr',
        label: 'Speech',
        sizeMB: 100,
        role: 'speech',
        runtime: 'browser',
        simulated: false,
      },
    ]);
  });

  it('sizes', () => {
    expect(totalMB(PLANNED_MODELS.balanced)).toBe(2400);
    expect(formatSize(550)).toBe('550 MB');
    expect(formatSize(2400)).toBe('2.4 GB');
    expect(formatSize(12_400)).toBe('12 GB');
  });
});

/** A store that finishes downloads when told to. */
class ManualStore implements ModelStore {
  done = new Set<string>();
  pending = new Map<string, { resolve(): void; progress(mb: number): void }>();
  async downloaded() {
    return new Set(this.done);
  }
  download(model: ModelInfo, onProgress: (mb: number) => void, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')));
      this.pending.set(model.id, {
        progress: onProgress,
        resolve: () => {
          this.done.add(model.id);
          resolve();
        },
      });
    });
  }
  async remove(id: string) {
    this.done.delete(id);
  }
  async availableMB() {
    return 1000;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('ModelManager', () => {
  const catalog = async () =>
    PLANNED_MODELS.light.map((info) => ({ info, profiles: ['light' as const] }));

  it('downloads one at a time, reports progress, and remembers what is downloaded', async () => {
    const store = new ManualStore();
    const manager = new ModelManager({ catalog, simulated: store, real: null });
    const [a, b] = PLANNED_MODELS.light as [ModelInfo, ModelInfo];
    const view = await manager.download([a.id, b.id]);
    // The first starts at once; the second waits its turn.
    expect(view.models.map((m) => m.status.state)).toEqual(['downloading', 'queued']);
    await tick();
    store.pending.get(a.id)?.progress(100);
    await tick();
    const progress = (await fakeBrowser.storage.session.get(DOWNLOADS_KEY))[DOWNLOADS_KEY];
    expect(progress).toMatchObject({ [a.id]: { state: 'downloading', receivedMB: 100 } });
    expect(store.pending.has(b.id)).toBe(false);

    store.pending.get(a.id)?.resolve();
    await tick();
    await tick();
    expect(store.pending.has(b.id)).toBe(true);
    const after = await manager.view();
    expect(after.models[0]?.status).toEqual({ state: 'ready' });
    expect(after.storage).toEqual({ modelsMB: a.sizeMB, availableMB: 1000 });
  });

  it('cancels and deletes', async () => {
    const store = new ManualStore();
    const manager = new ModelManager({ catalog, simulated: store, real: null });
    const [a] = PLANNED_MODELS.light as [ModelInfo];
    await manager.download([a.id]);
    await tick();
    await manager.cancel(a.id);
    await tick();
    expect((await manager.view()).models[0]?.status).toEqual({ state: 'absent' });

    store.done.add(a.id);
    await manager.remove(a.id);
    expect((await manager.view()).models[0]?.status).toEqual({ state: 'absent' });
  });

  it('reports an error for a real model with no store yet', async () => {
    const manager = new ModelManager({
      catalog: async () => [
        { info: { ...(PLANNED_MODELS.light[0] as ModelInfo), simulated: false }, profiles: [] },
      ],
      simulated: new ManualStore(),
      real: null,
    });
    const id = (PLANNED_MODELS.light[0] as ModelInfo).id;
    await manager.download([id]);
    await tick();
    await tick();
    expect((await manager.view()).models[0]?.status.state).toBe('error');
  });
});
