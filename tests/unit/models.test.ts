import { describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createBuiltinRegistry } from '@/engines/builtin';
import { type HardwareInfo, NO_HARDWARE } from '@/engines/hardware';
import { DEMO_ASR_ID, DEMO_TRANSLATION_ID } from '@/engines/profiles';
import { WHISPER_BASE_INFO, WHISPER_TURBO_INFO } from '@/engines/whisper/info';
import { allModels, knownModels, modelsFor, totalMB } from '@/models/catalog';
import {
  cacheKey,
  fileUrl,
  isComplete,
  type ModelSource,
  modelFileCache,
  parseFileUrl,
  partCount,
  partKey,
  pendingPartKey,
} from '@/models/hub';
import { ModelManager } from '@/models/manager';
import { CacheModelStore, rangeMatches } from '@/models/store';
import { DOWNLOADS_KEY, formatSize, type ModelInfo } from '@/models/types';

const custom = { asr: DEMO_ASR_ID, translation: DEMO_TRANSLATION_ID };
const GPU: HardwareInfo = {
  webgpu: { available: true, shaderF16: true, maxBufferMB: 4096 },
  deviceMemoryGB: 8,
  cores: 12,
  companion: false,
};

describe('catalog', () => {
  const registry = createBuiltinRegistry();

  it('needs the WebGPU or the WebAssembly build of the profile’s speech model', () => {
    // Light: Chrome's own engines, nothing to download from Murmur.
    expect(modelsFor('light', custom, registry, GPU)).toEqual([]);
    expect(modelsFor('balanced', custom, registry, GPU).map((m) => m.id)).toEqual([
      'whisper-large-v3-turbo-webgpu',
    ]);
    // No WebGPU: turbo doesn't fit, so base, in its processor build.
    expect(modelsFor('balanced', custom, registry, NO_HARDWARE).map((m) => m.id)).toEqual([
      'whisper-base-wasm',
    ]);
    const all = allModels(custom, registry, GPU);
    // The demo engines of the custom choice exist in e2e builds only: here it falls back to base.
    expect(all.map((m) => [m.info.id, m.profiles])).toEqual([
      ['whisper-large-v3-turbo-webgpu', ['balanced', 'best']],
      ['whisper-base-webgpu', []],
    ]);
    expect(knownModels(registry).map((m) => m.id)).toEqual([
      'whisper-base-webgpu',
      'whisper-base-wasm',
      'whisper-large-v3-turbo-webgpu',
    ]);
  });

  it('declares exact files whose sizes add up to the download', () => {
    for (const info of [WHISPER_BASE_INFO, WHISPER_TURBO_INFO]) {
      for (const m of info.models ?? []) {
        const bytes = m.source.files.reduce((n, f) => n + f.bytes, 0);
        expect(Math.round(bytes / 1e6)).toBe(m.sizeMB);
        expect(m.source.files.map((f) => f.path)).toContain('tokenizer.json');
        expect(m.source.revision).toMatch(/^[0-9a-f]{40}$/);
      }
    }
    const sizes = knownModels(registry).map((m) => formatSize(m.sizeMB));
    expect(sizes).toEqual(['209 MB', '80 MB', '1.6 GB']);
    expect(totalMB(knownModels(registry))).toBeGreaterThan(1800);
  });
});

// ---------------------------------------------------------------------------------------------
// A Cache API and a file server, in memory.

class FakeCache {
  readonly entries = new Map<string, { body: Uint8Array; headers: [string, string][] }>();
  async match(key: string | Request): Promise<Response | undefined> {
    const e = this.entries.get(typeof key === 'string' ? key : key.url);
    return e ? new Response(e.body.slice(), { headers: e.headers }) : undefined;
  }
  async put(key: string, res: Response): Promise<void> {
    const body = new Uint8Array(await res.arrayBuffer());
    this.entries.set(key, { body, headers: [...res.headers] });
  }
  async delete(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }
  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((k) => new Request(k));
  }
}

class FakeCaches {
  readonly cache = new FakeCache();
  async open(): Promise<Cache> {
    return this.cache as unknown as Cache;
  }
}

const bytes = (n: number, seed: number) =>
  Uint8Array.from({ length: n }, (_, i) => (i + seed) % 251);

const SOURCE: ModelSource = {
  repo: 'org/model',
  revision: 'abc',
  files: [
    { path: 'config.json', bytes: 7 },
    { path: 'onnx/model.onnx', bytes: 25 },
  ],
};
const OTHER: ModelSource = {
  repo: 'org/model',
  revision: 'abc',
  files: [
    { path: 'config.json', bytes: 7 },
    { path: 'onnx/model_small.onnx', bytes: 12 },
  ],
};
const model = (id: string, source: ModelSource): ModelInfo => ({
  id,
  label: id,
  role: 'speech',
  sizeMB: source.files.reduce((n, f) => n + f.bytes, 0) / 1e6,
  runtime: 'browser',
  source,
});
const A = model('a', SOURCE);
const B = model('b', OTHER);
const CONTENT = new Map<string, Uint8Array>([
  ['config.json', bytes(7, 1)],
  ['onnx/model.onnx', bytes(25, 2)],
  ['onnx/model_small.onnx', bytes(12, 3)],
]);

/** Serves CONTENT with Range support; `fail(url, range)` returning true makes that request fail. */
function server(fail: (url: string, range: string | null) => boolean = () => false) {
  const requests: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const range = new Headers(init?.headers).get('range');
    requests.push(`${parseFileUrl(url)?.path} ${range ?? 'all'}`);
    if (fail(url, range)) throw new TypeError('network');
    const body = CONTENT.get(parseFileUrl(url)?.path ?? '');
    if (!body) return new Response('no', { status: 404 });
    const m = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
    if (!m) return new Response(body.slice(), { status: 200 });
    return new Response(body.slice(Number(m[1]), Number(m[2]) + 1), { status: 206 });
  }) as typeof fetch;
  return { fetch: fetchFn, requests };
}

const PART = 10;

function store(caches: FakeCaches, s = server()) {
  return new CacheModelStore({
    caches,
    fetch: s.fetch,
    partBytes: PART,
    progressMs: 0,
    estimate: async () => ({ quota: 5e9, usage: 1e9 }),
  });
}

describe('CacheModelStore', () => {
  it('downloads every file in parts, reports progress and finds it complete', async () => {
    const caches = new FakeCaches();
    const s = server();
    const st = store(caches, s);
    const progress: number[] = [];
    await st.download(A, (mb) => progress.push(Math.round(mb * 1e6)), new AbortController().signal);
    expect(progress.at(-1)).toBe(32);
    expect(progress).toEqual([...progress].sort((x, y) => x - y));
    // The small file whole; the 25-byte file as three ranges.
    expect(s.requests).toEqual([
      'config.json all',
      'onnx/model.onnx bytes=0-9',
      'onnx/model.onnx bytes=10-19',
      'onnx/model.onnx bytes=20-24',
    ]);
    expect(await st.downloaded([A, B])).toEqual(new Set(['a']));
    expect(await st.storedMB(A)).toBeCloseTo(32 / 1e6);
    expect(await st.usageMB()).toBeCloseTo(32 / 1e6);
    expect(await st.availableMB()).toBe(4000);
    expect(partCount(25, PART)).toBe(3);
  });

  it('keeps whole parts when a download fails, and resumes from them', async () => {
    const caches = new FakeCaches();
    let broken = true;
    const s = server((_, range) => broken && range === 'bytes=20-24');
    const st = store(caches, s);
    await expect(st.download(A, () => {}, new AbortController().signal)).rejects.toThrow(
      /Couldn't reach/,
    );
    expect(await st.downloaded([A])).toEqual(new Set());
    expect(Math.round((await st.storedMB(A)) * 1e6)).toBe(27);
    broken = false;
    s.requests.length = 0;
    await st.download(A, () => {}, new AbortController().signal);
    expect(s.requests).toEqual(['onnx/model.onnx bytes=20-24']);
    expect(await st.downloaded([A])).toEqual(new Set(['a']));
  });

  it('refuses a server that ignores Range, and a short part', async () => {
    const caches = new FakeCaches();
    const noRange = (async () => new Response(bytes(25, 2), { status: 200 })) as typeof fetch;
    const st = new CacheModelStore({ caches, fetch: noRange, partBytes: PART, progressMs: 0 });
    await expect(
      st.download(
        model('x', { ...SOURCE, files: [SOURCE.files[1] as never] }),
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow(/HTTP 200/);

    const short = (async () => new Response(bytes(4, 0), { status: 206 })) as typeof fetch;
    const st2 = new CacheModelStore({ caches, fetch: short, partBytes: PART, progressMs: 0 });
    await expect(
      st2.download(
        model('x', { ...SOURCE, files: [SOURCE.files[1] as never] }),
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow(/stopped early/);
    expect(caches.cache.entries.size).toBe(0);
  });

  it('refuses a part the server sent for other bytes, or of a file of another size', async () => {
    const one = model('x', { ...SOURCE, files: [SOURCE.files[1] as never] });
    const lying = (header: string) =>
      (async () =>
        new Response(bytes(10, 0), {
          status: 206,
          headers: { 'content-range': header },
        })) as typeof fetch;
    for (const header of ['bytes 10-19/25', 'bytes 0-9/999']) {
      const caches = new FakeCaches();
      const st = new CacheModelStore({ caches, fetch: lying(header), partBytes: PART });
      await expect(st.download(one, () => {}, new AbortController().signal)).rejects.toThrow(
        /other bytes/,
      );
      expect(caches.cache.entries.size).toBe(0);
    }
    expect(rangeMatches('bytes 0-9/25', 0, 10, 25)).toBe(true);
    expect(rangeMatches('bytes 0-9/*', 0, 10, 25)).toBe(true);
  });

  it('never counts a part left half-written as downloaded', async () => {
    const caches = new FakeCaches();
    const key = cacheKey(SOURCE, 'onnx/model.onnx');
    // The worker stopped while writing part 1: only its pending entry is there.
    caches.cache.entries.set(pendingPartKey(key, 1), {
      body: bytes(4, 0),
      headers: [['content-length', '10']],
    });
    const s = server();
    const st = store(caches, s);
    expect(Math.round((await st.storedMB(A)) * 1e6)).toBe(0);
    await st.download(A, () => {}, new AbortController().signal);
    expect(await st.downloaded([A])).toEqual(new Set(['a']));
    expect([...caches.cache.entries.keys()].some((k) => k.endsWith('&pending'))).toBe(false);
  });

  it('checks each file against its pinned hash, and drops one that doesn’t match', async () => {
    const hashOf = async (data: Uint8Array<ArrayBuffer>) => {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
      return `sha256:${Array.from(digest, (x) => x.toString(16).padStart(2, '0')).join('')}`;
    };
    const good = await hashOf(CONTENT.get('onnx/model.onnx') as Uint8Array<ArrayBuffer>);
    const pinned = (hash: string): ModelInfo =>
      model('a', {
        ...SOURCE,
        files: [SOURCE.files[0] as never, { path: 'onnx/model.onnx', bytes: 25, hash }],
      });
    const caches = new FakeCaches();
    const verified = (fetch = server().fetch) =>
      new CacheModelStore({ caches, fetch, partBytes: PART, progressMs: 0, verify: true });
    await expect(
      verified().download(
        pinned(`sha256:${'0'.repeat(64)}`),
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow(/didn’t arrive intact/);
    // The bad file is gone (to fetch anew); the good one stays.
    expect(Math.round((await verified().storedMB(pinned(good))) * 1e6)).toBe(7);
    await verified().download(pinned(good), () => {}, new AbortController().signal);
    expect(await verified().downloaded([pinned(good)])).toEqual(new Set(['a']));
  });

  it('stops on abort', async () => {
    const st = store(new FakeCaches());
    const controller = new AbortController();
    controller.abort();
    await expect(st.download(A, () => {}, controller.signal)).rejects.toThrow();
  });

  it('removes a model but keeps files another downloaded model uses', async () => {
    const caches = new FakeCaches();
    const st = store(caches);
    const signal = new AbortController().signal;
    await st.download(A, () => {}, signal);
    await st.download(B, () => {}, signal);
    await st.remove(A, [B]);
    expect(await st.downloaded([A, B])).toEqual(new Set(['b']));
    expect(Math.round((await st.usageMB()) * 1e6)).toBe(19);
  });
});

describe('modelFileCache', () => {
  it('serves whole files to transformers.js, for any revision, and nothing else', async () => {
    const caches = new FakeCaches();
    await store(caches).download(A, () => {}, new AbortController().signal);
    const original = globalThis.caches;
    Object.defineProperty(globalThis, 'caches', { value: caches, configurable: true });
    try {
      // The real part size: one part per file here, so store again with it.
      const big = new FakeCaches();
      await new CacheModelStore({ caches: big, fetch: server().fetch, progressMs: 0 }).download(
        A,
        () => {},
        new AbortController().signal,
      );
      Object.defineProperty(globalThis, 'caches', { value: big, configurable: true });
      const cache = modelFileCache(SOURCE);
      const res = await cache.match(
        'https://huggingface.co/org/model/resolve/main/onnx/model.onnx',
      );
      expect(res?.headers.get('content-length')).toBe('25');
      expect(new Uint8Array((await res?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(
        CONTENT.get('onnx/model.onnx'),
      );
      expect(await cache.match('/models/org/model/onnx/model.onnx')).toBeUndefined();
      expect(await cache.match(fileUrl(SOURCE, 'processor_config.json'))).toBeUndefined();
      expect(await isComplete(SOURCE)).toBe(true);
      expect(await isComplete(OTHER)).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'caches', { value: original, configurable: true });
    }
  });

  it('parses Hugging Face file URLs', () => {
    expect(parseFileUrl('http://127.0.0.1:4392/hf/a/b/resolve/r1/onnx/x%20y.onnx')).toEqual({
      repo: 'a/b',
      path: 'onnx/x y.onnx',
    });
    expect(parseFileUrl('/models/a/b/config.json')).toBeNull();
  });

  it('takes a file from another repo and commit where the file says so', async () => {
    const mixed: ModelSource = {
      ...SOURCE,
      files: [
        { path: 'config.json', bytes: 7 },
        { path: 'onnx/model.onnx', bytes: 25, from: { repo: 'up/stream', revision: 'def' } },
      ],
    };
    const caches = new FakeCaches();
    const urls: string[] = [];
    const s = server();
    const st = new CacheModelStore({
      caches,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(String(input).replace(/^.*?\/([^/]+\/[^/]+\/resolve\/)/, '$1'));
        return s.fetch(input, init);
      }) as typeof fetch,
      progressMs: 0,
    });
    await st.download(model('m', mixed), () => {}, new AbortController().signal);
    expect([...new Set(urls)]).toEqual([
      'org/model/resolve/abc/config.json',
      'up/stream/resolve/def/onnx/model.onnx',
    ]);
    expect(cacheKey(mixed, 'onnx/model.onnx')).toBe(
      'https://huggingface.co/up/stream/resolve/def/onnx/model.onnx',
    );
    expect(await st.downloaded([model('m', mixed)])).toEqual(new Set(['m']));
    const original = globalThis.caches;
    try {
      Object.defineProperty(globalThis, 'caches', { value: caches, configurable: true });
      const reader = modelFileCache(mixed);
      expect(await reader.match(cacheKey(mixed, 'onnx/model.onnx'))).toBeDefined();
      expect(
        await reader.match('https://huggingface.co/org/model/resolve/abc/onnx/model.onnx'),
      ).toBeUndefined();
      expect(await isComplete(mixed)).toBe(true);
    } finally {
      Object.defineProperty(globalThis, 'caches', { value: original, configurable: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A store whose downloads finish when told to. */
function manualStore() {
  const caches = new FakeCaches();
  const real = store(caches);
  const pending = new Map<string, { resolve(): void; progress(mb: number): void }>();
  const st = Object.assign(Object.create(real) as CacheModelStore, {
    download(m: ModelInfo, onProgress: (mb: number) => void, signal: AbortSignal) {
      return new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          pending.delete(m.id);
          reject(new DOMException('x', 'AbortError'));
        });
        pending.set(m.id, {
          progress: onProgress,
          resolve: () => {
            pending.delete(m.id);
            real.download(m, () => {}, signal).then(resolve, reject);
          },
        });
      });
    },
  });
  return { st, pending, real };
}

describe('ModelManager', () => {
  const deps = (st: CacheModelStore) => ({
    catalog: async () => [{ info: A, profiles: ['balanced' as const] }],
    known: async () => [A, B],
    store: st,
  });

  it('downloads one at a time, reports progress, and remembers what is downloaded', async () => {
    const { st, pending } = manualStore();
    const manager = new ModelManager({ ...deps(st), known: async () => [A, B] });
    const view = await manager.download(['a', 'b']);
    expect(view.models.map((m) => [m.info.id, m.status.state])).toEqual([
      ['a', 'downloading'],
      ['b', 'queued'],
    ]);
    await tick();
    pending.get('a')?.progress(0.00001);
    await tick();
    const progress = (await fakeBrowser.storage.session.get(DOWNLOADS_KEY))[DOWNLOADS_KEY];
    expect(progress).toMatchObject({ a: { state: 'downloading', receivedMB: 0.00001 } });
    expect(pending.has('b')).toBe(false);

    pending.get('a')?.resolve();
    await expect.poll(() => pending.has('b')).toBe(true);
    const after = await manager.view();
    expect(after.models[0]?.status).toEqual({ state: 'ready' });
    expect(after.storage.modelsMB).toBeCloseTo(32 / 1e6);
  });

  it('cancels (keeping a partial download to resume) and deletes', async () => {
    const caches = new FakeCaches();
    let broken = true;
    const st = store(
      caches,
      server((_, range) => broken && range === 'bytes=20-24'),
    );
    const manager = new ModelManager(deps(st));
    await manager.download(['a']);
    await expect.poll(async () => (await manager.view()).models[0]?.status.state).toBe('error');
    // Not listed by any profile, but on disk: still shown so it can be deleted.
    broken = false;
    expect((await manager.view()).models.map((m) => m.info.id)).toEqual(['a']);

    // An error clears when downloading again; the download resumes.
    await manager.download(['a']);
    await expect.poll(async () => (await manager.view()).models[0]?.status.state).toBe('ready');
    await manager.remove('a');
    expect((await manager.view()).models[0]?.status).toEqual({ state: 'absent' });
  });

  it('shows a cancelled download as partial, and cancels a queued one at once', async () => {
    const { st, pending, real } = manualStore();
    const manager = new ModelManager(deps(st));
    // Part of `a` already on disk.
    const partial = new AbortController();
    const half = server((_, range) => range === 'bytes=10-19');
    await new CacheModelStore({
      caches: (real as unknown as { deps: { caches: FakeCaches } }).deps.caches,
      fetch: half.fetch,
      partBytes: PART,
      progressMs: 0,
    })
      .download(A, () => {}, partial.signal)
      .catch(() => {});
    expect((await manager.view()).models[0]?.status).toMatchObject({ state: 'partial' });

    await manager.download(['a', 'b']);
    await tick();
    const queued = manager.cancel('b');
    expect((await queued).models.find((m) => m.info.id === 'b')).toBeUndefined();
    await manager.cancel('a');
    expect(pending.size).toBe(0);
    expect((await manager.view()).models[0]?.status.state).toBe('partial');
  });

  it('keeps the files a model being downloaded shares when another is deleted', async () => {
    const { st, pending, real } = manualStore();
    await real.download(A, () => {}, new AbortController().signal);
    const manager = new ModelManager(deps(st));
    await manager.download(['b']);
    await expect.poll(() => pending.has('b')).toBe(true);
    await manager.remove('a');
    const caches = (real as unknown as { deps: { caches: FakeCaches } }).deps.caches;
    const config = partKey(cacheKey(SOURCE, 'config.json'), 0);
    expect(caches.cache.entries.has(config)).toBe(true);
    pending.get('b')?.resolve();
    await expect
      .poll(async () => (await manager.view()).models.find((m) => m.info.id === 'b')?.status)
      .toEqual({ state: 'ready' });
  });

  it('keeps the worker awake while downloading', async () => {
    const { st, pending } = manualStore();
    let calls = 0;
    const manager = new ModelManager({ ...deps(st), keepAlive: () => calls++, keepAliveMs: 5 });
    await manager.download(['a']);
    await expect.poll(() => calls).toBeGreaterThan(1);
    pending.get('a')?.resolve();
    await expect.poll(async () => (await manager.view()).models[0]?.status.state).toBe('ready');
    const after = calls;
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(after);
  });
});
