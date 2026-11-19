/**
 * Model files from Hugging Face, kept in the Cache API (`MODEL_CACHE`). Shared by the service
 * worker's store (store.ts), which downloads, and the model workers, which only read: they hand
 * transformers.js `modelFileCache(source)` and turn its remote downloads off, so loading a model
 * never fetches anything.
 *
 * Each file is stored in parts of `PART_BYTES` (`<url>?part=<n>`), each fetched with an HTTP
 * Range request and written as it streams in. A part is in the cache only once all of it
 * arrived, so a download that stops (cancelled, network gone, worker stopped) resumes from the
 * first missing part. Reading joins the parts' blobs, which stay on disk until read.
 */
import { IS_E2E } from '@/shared/e2e';

export interface ModelFile {
  /** Path in the repo: `onnx/encoder_model.onnx`. */
  path: string;
  bytes: number;
}

export interface ModelSource {
  /** Hugging Face repo: `onnx-community/whisper-base`. */
  repo: string;
  /** Commit, so every install gets the same files. */
  revision: string;
  files: readonly ModelFile[];
}

/**
 * Where model files come from. e2e builds use the fixture server's stand-in
 * (scripts/serve-fixtures.mjs), so tests never touch the network.
 */
export const MODEL_HOST = IS_E2E ? 'http://127.0.0.1:4392/hf' : 'https://huggingface.co';
export const MODEL_CACHE = 'murmur-models';
/** 64 MiB: a stopped download loses at most this much. */
export const PART_BYTES = 64 * 1024 * 1024;

export function fileUrl(source: ModelSource, path: string, host = MODEL_HOST): string {
  return `${host}/${source.repo}/resolve/${source.revision}/${path}`;
}

/** The repo and path of a Hugging Face file URL (any host, any revision), or null. */
export function parseFileUrl(url: string): { repo: string; path: string } | null {
  const m = /([^/]+\/[^/]+)\/resolve\/[^/]+\/([^?#]+)/.exec(url);
  return m ? { repo: m[1] as string, path: decodeURIComponent(m[2] as string) } : null;
}

export function partCount(bytes: number, partBytes = PART_BYTES): number {
  return Math.max(1, Math.ceil(bytes / partBytes));
}

/** Byte range [start, end) of part `index`. */
export function partRange(bytes: number, index: number, partBytes = PART_BYTES): [number, number] {
  const start = index * partBytes;
  return [start, Math.min(bytes, start + partBytes)];
}

export function partKey(url: string, index: number): string {
  return `${url}?part=${index}`;
}

/** The part's length as stored, or null when it isn't (fully) there. */
export async function storedPart(
  cache: Cache,
  url: string,
  index: number,
  expected: number,
): Promise<number | null> {
  const res = await cache.match(partKey(url, index));
  if (!res) return null;
  const length = Number(res.headers.get('content-length'));
  return length === expected ? length : null;
}

/** Bytes of `file` on disk (whole parts only). */
export async function storedBytes(
  cache: Cache,
  source: ModelSource,
  file: ModelFile,
  partBytes = PART_BYTES,
): Promise<number> {
  const url = fileUrl(source, file.path);
  let total = 0;
  for (let i = 0; i < partCount(file.bytes, partBytes); i++) {
    const [start, end] = partRange(file.bytes, i, partBytes);
    total += (await storedPart(cache, url, i, end - start)) ?? 0;
  }
  return total;
}

/** `file` as one response, when every part is on disk. */
export async function readFile(
  cache: Cache,
  source: ModelSource,
  file: ModelFile,
  partBytes = PART_BYTES,
): Promise<Response | undefined> {
  const url = fileUrl(source, file.path);
  const blobs: Blob[] = [];
  for (let i = 0; i < partCount(file.bytes, partBytes); i++) {
    const res = await cache.match(partKey(url, i));
    if (!res) return undefined;
    blobs.push(await res.blob());
  }
  const body = new Blob(blobs);
  if (body.size !== file.bytes) return undefined;
  return new Response(body, {
    headers: { 'content-length': String(file.bytes), 'content-type': 'application/octet-stream' },
  });
}

/** Whether every file of `source` is on disk. */
export async function isComplete(
  source: ModelSource,
  cache?: Cache,
  partBytes = PART_BYTES,
): Promise<boolean> {
  const c = cache ?? (await caches.open(MODEL_CACHE));
  for (const file of source.files) {
    if ((await storedBytes(c, source, file, partBytes)) !== file.bytes) return false;
  }
  return true;
}

/**
 * A transformers.js `env.customCache` that serves `source`'s files from the model cache. Requests
 * for other files (optional ones the library probes for) find nothing.
 */
export function modelFileCache(source: ModelSource): {
  match(key: string): Promise<Response | undefined>;
  put(): Promise<void>;
} {
  let cache: Promise<Cache> | null = null;
  return {
    async match(key) {
      const parsed = parseFileUrl(key);
      if (!parsed || parsed.repo !== source.repo) return undefined;
      const file = source.files.find((f) => f.path === parsed.path);
      if (!file) return undefined;
      cache ??= caches.open(MODEL_CACHE);
      return readFile(await cache, source, file);
    },
    // Nothing is downloaded while loading, so there is never anything to add.
    async put() {},
  };
}
