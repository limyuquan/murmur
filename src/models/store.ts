/**
 * The model store: Hugging Face files in the Cache API, downloaded by the service worker (layout
 * and reading in hub.ts).
 *
 * Downloads run in the service worker, not the offscreen document: they must go on with no
 * session running and no page open, and a worker that is writing progress to `storage.session`
 * (an extension API call) a few times a second isn't stopped as idle. The manager also keeps it
 * awake while a download stalls. If the worker stops anyway, the whole parts already written stay,
 * and the next download resumes from there.
 */
import {
  fileUrl,
  MODEL_CACHE,
  type ModelSource,
  PART_BYTES,
  partCount,
  partKey,
  partRange,
  storedBytes,
  storedPart,
} from './hub';
import { MB, type ModelInfo, type ModelStore } from './types';

export interface StoreDeps {
  caches: Pick<CacheStorage, 'open'>;
  fetch: typeof fetch;
  estimate?: () => Promise<StorageEstimate>;
  partBytes?: number;
  /** Least time between progress reports, ms. */
  progressMs?: number;
}

export class CacheModelStore implements ModelStore {
  private readonly partBytes: number;
  private readonly progressMs: number;

  constructor(private readonly deps: StoreDeps) {
    this.partBytes = deps.partBytes ?? PART_BYTES;
    this.progressMs = deps.progressMs ?? 250;
  }

  private open(): Promise<Cache> {
    return this.deps.caches.open(MODEL_CACHE);
  }

  async downloaded(models: readonly ModelInfo[]): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const m of models) if (await this.complete(m.source)) ids.add(m.id);
    return ids;
  }

  async storedMB(model: ModelInfo): Promise<number> {
    return (await this.storedBytes(model.source)) / MB;
  }

  async download(
    model: ModelInfo,
    onProgress: (receivedMB: number) => void,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const cache = await this.open();
    const { source } = model;
    let received = await this.storedBytes(source, cache);
    let reported = 0;
    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - reported < this.progressMs) return;
      reported = now;
      onProgress(received / MB);
    };
    report(true);
    for (const file of source.files) {
      const url = fileUrl(source, file.path);
      const parts = partCount(file.bytes, this.partBytes);
      for (let i = 0; i < parts; i++) {
        const [start, end] = partRange(file.bytes, i, this.partBytes);
        if ((await storedPart(cache, url, i, end - start)) !== null) continue;
        const before = received;
        try {
          await this.fetchPart(cache, url, file.path, i, parts, start, end, signal, (n) => {
            received = before + n;
            report();
          });
        } catch (err) {
          received = before;
          throw err;
        }
        report(true);
      }
    }
    report(true);
  }

  private async fetchPart(
    cache: Cache,
    url: string,
    path: string,
    index: number,
    parts: number,
    start: number,
    end: number,
    signal: AbortSignal,
    onBytes: (n: number) => void,
  ): Promise<void> {
    const name = path.split('/').pop() ?? path;
    let res: Response;
    try {
      res = await this.deps.fetch(url, {
        // One-part files are fetched whole; Range only where a resume can need it.
        ...(parts > 1 ? { headers: { Range: `bytes=${start}-${end - 1}` } } : {}),
        signal,
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch (err) {
      if (signal.aborted) throw signal.reason ?? err;
      throw new Error(`Couldn't reach ${new URL(url).host}. Check the connection and try again.`);
    }
    const ok = parts > 1 ? res.status === 206 : res.status === 200 || res.status === 206;
    if (!ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`Downloading ${name} failed (HTTP ${res.status}).`);
    }
    const expected = end - start;
    let count = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        count += chunk.byteLength;
        onBytes(count);
        controller.enqueue(chunk);
      },
    });
    const key = partKey(url, index);
    await cache.put(
      key,
      new Response(res.body.pipeThrough(counter, { signal }), {
        headers: {
          'content-length': String(expected),
          'content-type': 'application/octet-stream',
        },
      }),
    );
    if (count !== expected) {
      await cache.delete(key);
      signal.throwIfAborted();
      throw new Error(`Downloading ${name} stopped early. Try again to resume.`);
    }
  }

  async remove(model: ModelInfo, keep: readonly ModelInfo[]): Promise<void> {
    const cache = await this.open();
    const kept = new Set(keep.flatMap((m) => m.source.files.map((f) => fileUrl(m.source, f.path))));
    for (const file of model.source.files) {
      const url = fileUrl(model.source, file.path);
      if (kept.has(url)) continue;
      for (let i = 0; i < partCount(file.bytes, this.partBytes); i++) {
        await cache.delete(partKey(url, i));
      }
    }
  }

  async usageMB(): Promise<number> {
    const cache = await this.open();
    let total = 0;
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      total += Number(res?.headers.get('content-length')) || 0;
    }
    return total / MB;
  }

  async availableMB(): Promise<number | null> {
    try {
      const estimate = this.deps.estimate ?? (() => navigator.storage.estimate());
      const { quota, usage } = await estimate();
      if (quota === undefined) return null;
      return Math.max(0, Math.round((quota - (usage ?? 0)) / MB));
    } catch {
      return null;
    }
  }

  private async storedBytes(source: ModelSource, cache?: Cache): Promise<number> {
    const c = cache ?? (await this.open());
    let total = 0;
    for (const file of source.files) total += await storedBytes(c, source, file, this.partBytes);
    return total;
  }

  private async complete(source: ModelSource): Promise<boolean> {
    const c = await this.open();
    for (const file of source.files) {
      if ((await storedBytes(c, source, file, this.partBytes)) !== file.bytes) return false;
    }
    return true;
  }
}
