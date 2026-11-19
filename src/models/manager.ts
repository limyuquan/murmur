/**
 * Model downloads, run by the service worker so they continue when the page that asked closes.
 * One download at a time, in the order asked. Progress goes to `storage.session` (DOWNLOADS_KEY)
 * a few times a second; pages follow it with `storage.onChanged`.
 */
import { browser } from 'wxt/browser';
import type { ProfileId } from '@/engines/profiles';
import {
  DOWNLOADS_KEY,
  type DownloadProgress,
  type ModelInfo,
  type ModelState,
  type ModelStore,
  type ModelsView,
} from './types';

export interface ManagerDeps {
  /** Every model there is, with the profiles that use it. */
  catalog(): Promise<{ info: ModelInfo; profiles: ProfileId[] }[]>;
  /** Store for planned (simulated) models. */
  simulated: ModelStore;
  /** Store for real models, once there is one. */
  real: ModelStore | null;
}

export class ModelManager {
  private readonly jobs = new Map<string, AbortController>();
  private progress: DownloadProgress = {};
  private queue: Promise<void> = Promise.resolve();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ManagerDeps) {}

  /** Forgets progress left by a previous worker (its downloads stopped with it). */
  async reconcile(): Promise<void> {
    this.progress = {};
    await browser.storage.session.remove(DOWNLOADS_KEY);
  }

  async view(): Promise<ModelsView> {
    const catalog = await this.deps.catalog();
    const stores = [this.deps.simulated, this.deps.real].filter((s): s is ModelStore => !!s);
    const downloaded = new Set<string>();
    for (const store of stores) for (const id of await store.downloaded()) downloaded.add(id);
    const models = catalog.map(({ info, profiles }) => ({
      info,
      profiles,
      status: this.stateOf(info.id, downloaded),
    }));
    const modelsMB = models
      .filter((m) => m.status.state === 'ready')
      .reduce((n, m) => n + m.info.sizeMB, 0);
    const availableMB = await (this.deps.real ?? this.deps.simulated).availableMB();
    return { models, storage: { modelsMB, availableMB } };
  }

  /** Queues downloads of `ids` (ones already downloaded or under way are skipped). */
  async download(ids: readonly string[]): Promise<ModelsView> {
    const catalog = await this.deps.catalog();
    const current = await this.view();
    for (const id of ids) {
      const info = catalog.find((c) => c.info.id === id)?.info;
      const state = current.models.find((m) => m.info.id === id)?.status.state;
      if (!info || state === 'ready' || this.jobs.has(id)) continue;
      const controller = new AbortController();
      this.jobs.set(id, controller);
      this.set(id, { state: 'queued' });
      this.queue = this.queue.then(() => this.run(info, controller));
    }
    return this.view();
  }

  async cancel(id: string): Promise<ModelsView> {
    this.jobs.get(id)?.abort();
    return this.view();
  }

  async remove(id: string): Promise<ModelsView> {
    this.jobs.get(id)?.abort();
    const catalog = await this.deps.catalog();
    const info = catalog.find((c) => c.info.id === id)?.info;
    if (info) await this.storeFor(info)?.remove(id);
    return this.view();
  }

  private async run(info: ModelInfo, controller: AbortController): Promise<void> {
    if (controller.signal.aborted) {
      this.finish(info.id);
      return;
    }
    const store = this.storeFor(info);
    try {
      if (!store) throw new Error('This model needs the engine update that downloads it.');
      this.set(info.id, { state: 'downloading', receivedMB: 0 });
      await store.download(
        info,
        (receivedMB) => this.set(info.id, { state: 'downloading', receivedMB }),
        controller.signal,
      );
      this.finish(info.id);
    } catch (err) {
      if (controller.signal.aborted) this.finish(info.id);
      else {
        this.jobs.delete(info.id);
        this.set(info.id, {
          state: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private storeFor(info: ModelInfo): ModelStore | null {
    return info.simulated ? this.deps.simulated : this.deps.real;
  }

  private stateOf(id: string, downloaded: Set<string>): ModelState {
    const p = this.progress[id];
    if (p) return p;
    return downloaded.has(id) ? { state: 'ready' } : { state: 'absent' };
  }

  private finish(id: string): void {
    this.jobs.delete(id);
    const { [id]: _, ...rest } = this.progress;
    this.progress = rest;
    this.flush();
  }

  private set(id: string, state: DownloadProgress[string]): void {
    this.progress = { ...this.progress, [id]: state };
    this.flush();
  }

  /** Writes progress in order, never two writes at once. */
  private flush(): void {
    const snapshot = this.progress;
    this.writing = this.writing
      .then(() => browser.storage.session.set({ [DOWNLOADS_KEY]: snapshot }))
      .catch(() => {});
  }
}
