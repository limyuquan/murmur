/**
 * Model downloads, run by the service worker so they continue when the page that asked closes.
 * One download at a time, in the order asked. Progress goes to `storage.session` (DOWNLOADS_KEY)
 * a few times a second; pages follow it with `storage.onChanged`. Nothing downloads unless a page
 * asks for it (a click on Download).
 */
import { browser } from 'wxt/browser';
import type { ProfileId } from '@/engines/profiles';
import { cacheKey, type ModelFile } from './hub';
import {
  DOWNLOADS_KEY,
  type DownloadProgress,
  type ModelEntry,
  type ModelInfo,
  type ModelState,
  type ModelStore,
  type ModelsView,
} from './types';

export interface ManagerDeps {
  /** The models this device's profiles use, with the profiles that use them. */
  catalog(): Promise<{ info: ModelInfo; profiles: ProfileId[] }[]>;
  /** Every model there is (all backends), so ones on disk that no profile needs still show. */
  known(): Promise<ModelInfo[]>;
  store: ModelStore;
  /** Called every `keepAliveMs` while downloading (an extension API call keeps the worker up). */
  keepAlive?(): void;
  keepAliveMs?: number;
}

interface Job {
  controller: AbortController;
  /** Settles when the job has stopped writing. */
  done: Promise<void>;
}

export class ModelManager {
  private readonly jobs = new Map<string, Job>();
  private progress: DownloadProgress = {};
  private queue: Promise<void> = Promise.resolve();
  private writing: Promise<void> = Promise.resolve();
  private awake: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ManagerDeps) {}

  /** Forgets progress left by a previous worker (its downloads stopped with it). */
  async reconcile(): Promise<void> {
    this.progress = {};
    await browser.storage.session.remove(DOWNLOADS_KEY);
    await this.prune();
  }

  /** Frees files no known model uses (a revision bump leaves the old ones behind). */
  private async prune(): Promise<void> {
    if (this.jobs.size > 0) return;
    try {
      await this.deps.store.prune?.(await this.deps.known());
    } catch {
      // Pruning is housekeeping: never in the way of anything else.
    }
  }

  async view(): Promise<ModelsView> {
    const [catalog, known] = await Promise.all([this.deps.catalog(), this.deps.known()]);
    const { store } = this.deps;
    const downloaded = await store.downloaded(known);
    const listed = new Set(catalog.map((c) => c.info.id));
    const entries: ModelEntry[] = [];
    const add = async (info: ModelInfo, profiles: ProfileId[], always: boolean) => {
      const status = await this.stateOf(info, downloaded, known);
      if (always || status.state !== 'absent') entries.push({ info, profiles, status });
    };
    for (const { info, profiles } of catalog) await add(info, profiles, true);
    for (const info of known) if (!listed.has(info.id)) await add(info, [], false);
    const [modelsMB, availableMB] = await Promise.all([store.usageMB(), store.availableMB()]);
    return { models: entries, storage: { modelsMB, availableMB } };
  }

  /** Queues downloads of `ids` (ones already downloaded or under way are skipped). */
  async download(ids: readonly string[]): Promise<ModelsView> {
    const known = await this.deps.known();
    const downloaded = await this.deps.store.downloaded(known);
    for (const id of ids) {
      const info = known.find((m) => m.id === id);
      if (!info || downloaded.has(id) || this.jobs.has(id)) continue;
      const controller = new AbortController();
      let settle: () => void = () => {};
      const done = new Promise<void>((r) => {
        settle = r;
      });
      this.jobs.set(id, { controller, done });
      this.set(id, { state: 'queued' });
      this.queue = this.queue.then(() => this.run(info, controller).finally(settle));
    }
    this.wake();
    return this.view();
  }

  /** Stops a download; what arrived is kept, and downloading again resumes. */
  async cancel(id: string): Promise<ModelsView> {
    await this.stop(id);
    return this.view();
  }

  async remove(id: string): Promise<ModelsView> {
    await this.stop(id);
    const known = await this.deps.known();
    const info = known.find((m) => m.id === id);
    if (info) {
      const downloaded = await this.deps.store.downloaded(known);
      // Files another model has, or is downloading, stay (configs and tokenizers are shared).
      const keep = known.filter(
        (m) => m.id !== id && (downloaded.has(m.id) || this.jobs.has(m.id)),
      );
      await this.deps.store.remove(info, keep);
    }
    await this.prune();
    if (this.progress[id]) this.finish(id);
    return this.view();
  }

  /** Aborts `id`'s job; waits for a running one to stop writing (a queued one just leaves). */
  private async stop(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.controller.abort();
    if (this.progress[id]?.state === 'queued') this.finish(id);
    else await job.done;
  }

  private async run(info: ModelInfo, controller: AbortController): Promise<void> {
    // Cancelled while queued: `stop` already cleared it (and a new job may have the id now).
    if (controller.signal.aborted) return;
    try {
      this.set(info.id, { state: 'downloading', receivedMB: 0 });
      await this.deps.store.download(
        info,
        (receivedMB, checking) => {
          if (controller.signal.aborted) return;
          this.set(info.id, {
            state: 'downloading',
            receivedMB,
            ...(checking !== undefined ? { checking } : {}),
          });
        },
        controller.signal,
      );
      this.finish(info.id);
    } catch (err) {
      if (controller.signal.aborted) {
        if (this.jobs.get(info.id)?.controller === controller) this.finish(info.id);
      } else {
        this.jobs.delete(info.id);
        this.set(info.id, {
          state: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      this.sleepIfIdle();
    }
  }

  private async stateOf(
    info: ModelInfo,
    downloaded: Set<string>,
    known: readonly ModelInfo[],
  ): Promise<ModelState> {
    const p = this.progress[info.id];
    if (p) return p;
    if (downloaded.has(info.id)) return { state: 'ready' };
    // Partial when some of its own files arrived: files it shares with another model (configs,
    // tokenizer) don't count, or downloading one build would show the other as started.
    const own = ownFiles(info, known);
    if (own.source.files.length === 0) return { state: 'absent' };
    const ownMB = await this.deps.store.storedMB(own);
    if (ownMB === 0) return { state: 'absent' };
    return { state: 'partial', receivedMB: await this.deps.store.storedMB(info) };
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

  private wake(): void {
    if (this.awake || !this.deps.keepAlive || this.jobs.size === 0) return;
    this.awake = setInterval(() => this.deps.keepAlive?.(), this.deps.keepAliveMs ?? 20_000);
  }

  private sleepIfIdle(): void {
    if (this.jobs.size > 0 || !this.awake) return;
    clearInterval(this.awake);
    this.awake = null;
  }
}

/** `info` with only the files no other model in `known` has. */
function ownFiles(info: ModelInfo, known: readonly ModelInfo[]): ModelInfo {
  const key = (m: ModelInfo, f: ModelFile) => cacheKey(m.source, f);
  const shared = new Set(
    known.filter((m) => m.id !== info.id).flatMap((m) => m.source.files.map((f) => key(m, f))),
  );
  return {
    ...info,
    source: {
      ...info.source,
      files: info.source.files.filter((f) => !shared.has(key(info, f))),
    },
  };
}
