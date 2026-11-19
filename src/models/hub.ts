/**
 * Model files from Hugging Face, kept in the Cache API (`MODEL_CACHE`). Shared by the service
 * worker's store (store.ts), which downloads, and the model workers, which only read: they hand
 * transformers.js `modelFileCache(source)` and turn its remote downloads off, so loading a model
 * never fetches anything.
 *
 * Each file is stored in parts of `PART_BYTES` (`<cacheKey>?part=<n>`), each fetched with an HTTP
 * Range request and written as it streams in (under a pending key, moved once all of it arrived).
 * A part is in the cache only once whole, so a download that stops (cancelled, network gone,
 * worker stopped) resumes from the first missing part. A file whose parts are all in is checked
 * against its pinned hash. Reading joins the parts' blobs, which stay on disk until read.
 */
import { IS_E2E } from '@/shared/e2e';

export interface ModelFile {
  /** Path in the repo: `onnx/encoder_model.onnx`. */
  path: string;
  bytes: number;
  /**
   * The file's hash on the Hub at the pinned revision, checked once it is downloaded:
   * `sha256:<hex>` (Git LFS files) or `git-sha1:<hex>` (files kept in Git). See digest.ts.
   */
  hash?: string;
  /**
   * The repo and commit this file comes from, when it isn't the source's own: a model can take
   * some files from another repo (an upstream export) and the rest from its own.
   */
  from?: FileOrigin;
}

export interface FileOrigin {
  /** Hugging Face repo: `onnx-community/whisper-base`. */
  repo: string;
  /** Commit, so every install gets the same files. */
  revision: string;
}

export interface ModelSource extends FileOrigin {
  /** Each from `repo` at `revision`, unless it says otherwise (`ModelFile.from`). */
  files: readonly ModelFile[];
}

export const HUGGING_FACE = 'https://huggingface.co';

/**
 * Where model files are downloaded from. e2e builds use the fixture server's stand-in
 * (scripts/serve-fixtures.mjs), so tests never touch the network; `WXT_MODEL_HOST` at build time
 * overrides it (`WXT_MODEL_HOST=https://huggingface.co pnpm build:e2e` for real-model checks).
 */
export const MODEL_HOST: string =
  (import.meta.env as Record<string, string | undefined>).WXT_MODEL_HOST ||
  (IS_E2E ? 'http://127.0.0.1:4392/hf' : HUGGING_FACE);
export const MODEL_CACHE = 'murmur-models';

/**
 * TODO(publish): the Hugging Face repo and commit that host the model files Murmur makes itself
 * (re-quantized weights and their sidecars; see each engine's files.json, group `murmur`). They
 * aren't uploaded yet: upload them, then set `repo` to that repo and `revision` to the commit's
 * full hash. Until then `isPublished` is false and the engines that need them are unavailable in
 * builds that download from Hugging Face (e2e builds and `WXT_MODEL_HOST` builds still offer
 * them; scripts/serve-fixtures.mjs serves the files).
 */
export const MURMUR_MODELS: FileOrigin = {
  repo: 'TODO-owner/murmur-qwen3-asr-0.6b',
  revision: 'TODO',
};

/** Whether `origin` names a real repo and commit (not the TODO placeholder). */
export function isPublished(origin: FileOrigin): boolean {
  return !origin.repo.startsWith('TODO') && /^[0-9a-f]{40}$/.test(origin.revision);
}
/** 64 MiB: a stopped download loses at most this much. */
export const PART_BYTES = 64 * 1024 * 1024;

/** The repo and commit `file` of `source` comes from. */
export function fileOrigin(source: ModelSource, file: ModelFile | string): FileOrigin {
  const f = typeof file === 'string' ? source.files.find((x) => x.path === file) : file;
  return f?.from ?? { repo: source.repo, revision: source.revision };
}

/** Where to download `file` (or the file at that path) of `source`. */
export function fileUrl(source: ModelSource, file: ModelFile | string, host = MODEL_HOST): string {
  const { repo, revision } = fileOrigin(source, file);
  const path = typeof file === 'string' ? file : file.path;
  return `${host}/${repo}/resolve/${revision}/${path}`;
}

/** The file's key in the model cache: its Hugging Face URL, whatever host it came from. */
export function cacheKey(source: ModelSource, file: ModelFile | string): string {
  return fileUrl(source, file, HUGGING_FACE);
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

/**
 * Where a part is written while it downloads. It moves to `partKey` only once all of it arrived
 * (and the bytes counted), so a part under its real key is always whole, even if the worker
 * stopped halfway through writing.
 */
export function pendingPartKey(url: string, index: number): string {
  return `${partKey(url, index)}&pending`;
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
  const url = cacheKey(source, file);
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
  const url = cacheKey(source, file);
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
      if (!parsed) return undefined;
      const file = source.files.find(
        (f) => f.path === parsed.path && fileOrigin(source, f).repo === parsed.repo,
      );
      if (!file) return undefined;
      cache ??= caches.open(MODEL_CACHE);
      return readFile(await cache, source, file);
    },
    // Nothing is downloaded while loading, so there is never anything to add.
    async put() {},
  };
}
