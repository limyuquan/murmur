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

import { matchesHash } from './digest';
import {
  cacheKey,
  fileUrl,
  isVerified,
  MODEL_CACHE,
  type ModelFile,
  type ModelSource,
  PART_BYTES,
  partCount,
  partKey,
  partRange,
  pendingPartKey,
  storedBytes,
  storedPart,
  verifiedKey,
} from './hub';
import { DISK_RESERVE_MB, DiskSpaceError, MB, type ModelInfo, type ModelStore } from './types';

export interface StoreDeps {
  caches: Pick<CacheStorage, 'open'>;
  fetch: typeof fetch;
  estimate?: () => Promise<StorageEstimate>;
  partBytes?: number;
  /** Least time between progress reports, ms. */
  progressMs?: number;
  /** Disk space downloads leave free, MB. Default `DISK_RESERVE_MB`. */
  reserveMB?: number;
  /**
   * Check each file against its pinned hash once all of it arrived (until it passes once: see
   * `verifiedKey`). Off for the e2e stand-in for Hugging Face, whose files are a pattern.
   */
  verify?: boolean;
}

export class CacheModelStore implements ModelStore {
  private readonly partBytes: number;
  private readonly progressMs: number;
  private readonly reserveMB: number;

  constructor(private readonly deps: StoreDeps) {
    this.partBytes = deps.partBytes ?? PART_BYTES;
    this.progressMs = deps.progressMs ?? 250;
    this.reserveMB = deps.reserveMB ?? DISK_RESERVE_MB;
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
    onProgress: (receivedMB: number, checking?: number) => void,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const cache = await this.open();
    const { source } = model;
    let received = await this.storedBytes(source, cache);
    let reported = 0;
    const report = (force = false, checking?: number) => {
      const now = Date.now();
      if (!force && now - reported < this.progressMs) return;
      reported = now;
      if (checking === undefined) onProgress(received / MB);
      else onProgress(received / MB, checking);
    };
    report(true);
    const size = source.files.reduce((n, f) => n + f.bytes, 0);
    // Refused up front when it can't fit: the browser would stop saving part-way, with an error
    // that reads like a network fault.
    await this.ensureSpace(size - received);
    for (const file of source.files) {
      const url = fileUrl(source, file);
      const key = cacheKey(source, file);
      const parts = partCount(file.bytes, this.partBytes);
      for (let i = 0; i < parts; i++) {
        const [start, end] = partRange(file.bytes, i, this.partBytes);
        if ((await storedPart(cache, key, i, end - start)) !== null) continue;
        // A part to fetch: whatever check the file passed no longer holds.
        await cache.delete(verifiedKey(key));
        const before = received;
        try {
          await this.fetchPart(cache, url, key, file, i, parts, start, end, signal, (n) => {
            received = before + n;
            report();
          });
        } catch (err) {
          received = before;
          throw await this.saveError(err, size - before, signal);
        }
        report(true);
      }
      if (await isVerified(cache, source, file)) continue;
      // Checked until it passes: a check cut short (the browser closed) runs again next time.
      if (this.deps.verify && file.hash) {
        report(true, 0);
        const ok = await matchesHash(file.hash, file.bytes, () => readParts(cache, key, parts), {
          signal,
          onProgress: (bytes) => report(false, bytes / file.bytes),
        });
        if (!ok) {
          for (let i = 0; i < parts; i++) await cache.delete(partKey(key, i));
          received -= file.bytes;
          report(true);
          throw new Error(
            `${file.path.split('/').pop()} didn’t arrive intact. Download again to fetch it anew.`,
          );
        }
        report(true);
      }
      signal.throwIfAborted();
      await cache.put(
        verifiedKey(key),
        new Response(file.hash ?? 'whole', { headers: { 'content-type': 'text/plain' } }),
      );
    }
    report(true);
  }

  private async fetchPart(
    cache: Cache,
    url: string,
    keyUrl: string,
    file: ModelFile,
    index: number,
    parts: number,
    start: number,
    end: number,
    signal: AbortSignal,
    onBytes: (n: number) => void,
  ): Promise<void> {
    const name = file.path.split('/').pop() ?? file.path;
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
    // A part must be the bytes asked for, of a file the size the list says (when the server
    // says which bytes it sent).
    const range = res.status === 206 ? res.headers.get('content-range') : null;
    if (range !== null && !rangeMatches(range, start, end, file.bytes)) {
      await res.body.cancel().catch(() => {});
      throw new Error(`Downloading ${name} failed: the server sent other bytes (${range}).`);
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
    const key = partKey(keyUrl, index);
    const pending = pendingPartKey(keyUrl, index);
    try {
      await cache.put(
        pending,
        new Response(res.body.pipeThrough(counter, { signal }), {
          headers: {
            'content-length': String(expected),
            'content-type': 'application/octet-stream',
          },
        }),
      );
    } catch (err) {
      // Whatever was written of it (a full disk) goes.
      await cache.delete(pending).catch(() => false);
      throw err;
    }
    if (count !== expected) {
      await cache.delete(pending);
      signal.throwIfAborted();
      throw new Error(`Downloading ${name} stopped early. Try again to resume.`);
    }
    // Whole: only now under its real key.
    const whole = await cache.match(pending);
    if (!whole) throw new Error(`Downloading ${name} failed: the part wasn't kept.`);
    try {
      await cache.put(key, whole);
    } finally {
      await cache.delete(pending);
    }
  }

  async remove(model: ModelInfo, keep: readonly ModelInfo[]): Promise<void> {
    const cache = await this.open();
    const kept = new Set(keep.flatMap((m) => m.source.files.map((f) => cacheKey(m.source, f))));
    for (const file of model.source.files) {
      const url = cacheKey(model.source, file);
      if (kept.has(url)) continue;
      await cache.delete(verifiedKey(url));
      for (let i = 0; i < partCount(file.bytes, this.partBytes); i++) {
        await cache.delete(partKey(url, i));
        await cache.delete(pendingPartKey(url, i));
      }
    }
  }

  /**
   * Deletes every stored entry no model in `known` has: files of a revision no longer pinned, or
   * of a model that was dropped (gigabytes each, which nothing else would ever delete).
   */
  async prune(known: readonly ModelInfo[]): Promise<void> {
    const cache = await this.open();
    const href = (url: string) => new URL(url).href;
    const keep = new Set(
      known.flatMap((m) => m.source.files.map((f) => href(cacheKey(m.source, f)))),
    );
    for (const req of await cache.keys()) {
      const base = req.url.replace(/\?(?:part=\d+(?:&pending)?|verified)$/, '');
      if (!keep.has(href(base))) await cache.delete(req.url);
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

  /** Throws a `DiskSpaceError` when `bytes` more won't fit with the reserve left free. */
  private async ensureSpace(bytes: number): Promise<void> {
    if (bytes <= 0) return;
    const available = await this.availableMB();
    const neededMB = bytes / MB;
    if (available !== null && neededMB + this.reserveMB > available) {
      throw new DiskSpaceError(neededMB, available);
    }
  }

  /**
   * What a failed part becomes: running out of space when the browser says so
   * (`QuotaExceededError`) or when the disk is now too full for the rest of the model (Chrome
   * reports a write it refused as "Cache.put() encountered a network error", like a dropped
   * connection); otherwise `err` as it is.
   */
  private async saveError(err: unknown, bytesLeft: number, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted || err instanceof DiskSpaceError) return err;
    const neededMB = bytesLeft / MB;
    if (isQuotaError(err)) return new DiskSpaceError(neededMB, await this.availableMB());
    const available = await this.availableMB();
    if (available !== null && neededMB + this.reserveMB > available) {
      return new DiskSpaceError(neededMB, available);
    }
    return err;
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
      if (!(await isVerified(c, source, file))) return false;
      if ((await storedBytes(c, source, file, this.partBytes)) !== file.bytes) return false;
    }
    return true;
  }
}

/** The browser's own "out of space" (a `QuotaExceededError` DOMException, or one like it). */
function isQuotaError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name: unknown }).name === 'QuotaExceededError'
  );
}

/** Whether `Content-Range` says bytes [start, end) of a `size`-byte file. */
export function rangeMatches(header: string, start: number, end: number, size: number): boolean {
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(header.trim());
  if (!m) return false;
  return (
    Number(m[1]) === start && Number(m[2]) === end - 1 && (m[3] === '*' || Number(m[3]) === size)
  );
}

/** The parts of a stored file, in order, as chunks. */
async function* readParts(cache: Cache, key: string, parts: number): AsyncIterable<Uint8Array> {
  for (let i = 0; i < parts; i++) {
    const res = await cache.match(partKey(key, i));
    if (!res?.body) throw new Error('A part of the file went missing.');
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
  }
}
