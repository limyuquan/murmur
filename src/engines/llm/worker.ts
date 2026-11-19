/**
 * The LLM translation worker: one Gemma model on LiteRT-LM.js, loaded once, one generation at a
 * time. Spawned by the engine in the offscreen document; terminating it is the only way to free
 * the model's graphics memory (the runtime's own `delete()` keeps it).
 *
 * A classic worker (built from entrypoints/llm-worker.ts as a plain script): LiteRT-LM loads its
 * Emscripten glue with `importScripts()`, which module workers don't have.
 *
 * No remote code: LiteRT-LM's WebAssembly ships in the extension (`litert/`), and the worker
 * names that file itself (the runtime's default is a CDN). Only the build for browsers with
 * relaxed SIMD and JSPI ships (Chrome 137+); older ones can't run the engine. No downloads either:
 * the model file was downloaded when the person asked (models/store.ts), and is read from the
 * model cache as a Blob, which stays on disk.
 */
import { Backend, Engine, loadLiteRtLm, SamplerType } from '@litert-lm/core';
import { MODEL_CACHE, readBlob } from '@/models/hub';
import { looksLikeOutOfMemory } from '../errors';
import { watchGpuDevices } from '../gpuwatch';
import type { FromWorker, GenerationStats, ToWorker } from './messages';

/** The one LiteRT-LM build Murmur ships (relaxed SIMD + JSPI). */
export const LITERT_WASM_JS = 'litertlm_wasm_internal.js';

type Conversation = Awaited<ReturnType<Engine['createConversation']>>;

class Unavailable extends Error {}
class MemoryFailure extends Error {}

/** The part of a worker's global scope the worker uses. */
interface WorkerScope {
  postMessage(message: FromWorker): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
}

export function startLlmWorker(scope: WorkerScope = self as unknown as WorkerScope): void {
  /** Every graphics device LiteRT-LM makes here, watched for running out of memory. */
  const gpu = watchGpuDevices();
  let engine: Engine | null = null;
  /** The generation running now, to cancel. */
  let current: { id: number; conversation: Conversation | null; cancelled: boolean } | null = null;
  /** Generations queued by id, in arrival order (the engine sends one at a time anyway). */
  let queue: Promise<void> = Promise.resolve();
  const cancelled = new Set<number>();

  const post = (message: FromWorker) => scope.postMessage(message);
  const fail = (id: number | null) => (err: unknown) =>
    post({
      type: 'error',
      id,
      message: err instanceof Error ? err.message : String(err),
      ...(err instanceof Unavailable ? { unavailable: true } : {}),
      ...(err instanceof MemoryFailure ? { memory: true } : {}),
    });

  /**
   * Out of memory when a device reported running out, the error says so, or an e2e check asked
   * for it at `stage`; else null.
   */
  const memoryFailure = (err: unknown, stage: string, simulate: string | undefined) => {
    if (simulate === stage) {
      gpu.record(`The graphics card ran out of memory (simulated, at ${stage}).`);
    }
    const seen = gpu.failure();
    if (seen) return new MemoryFailure(seen);
    if (err !== null && looksLikeOutOfMemory(message(err))) return new MemoryFailure(message(err));
    return null;
  };

  scope.onmessage = (event: MessageEvent<ToWorker>) => {
    const m = event.data;
    if (m.type === 'load') {
      queue = queue.then(() => load(m)).catch(fail(null));
    } else if (m.type === 'generate') {
      queue = queue.then(() => run(m)).catch(fail(m.id));
    } else if (m.type === 'cancel') {
      if (current?.id === m.id) {
        current.cancelled = true;
        current.conversation?.cancel();
      } else {
        cancelled.add(m.id);
      }
    }
  };

  async function load(m: Extract<ToWorker, { type: 'load' }>): Promise<void> {
    const started = performance.now();
    await checkRuntime();
    // The glue looks for its .wasm next to this script unless told where it is.
    (scope as unknown as { Module: unknown }).Module = {
      locateFile: (file: string) => new URL(file, m.wasmBase).href,
    };
    post({ type: 'progress', stage: 'compile', fraction: null });
    await loadLiteRtLm(new URL(LITERT_WASM_JS, m.wasmBase).href);
    const cache = await caches.open(MODEL_CACHE);
    const file = m.source.files.find((f) => f.path === m.file);
    const model = file && (await readBlob(cache, m.source, file));
    if (!model) throw new Error(`${m.file} isn’t downloaded.`);
    const simulate = m.simulateOutOfMemory;
    try {
      engine = await Engine.create({
        model,
        backend: Backend.GPU,
        mainExecutorSettings: { maxNumTokens: m.maxNumTokens },
        benchmarkEnabled: true,
      });
    } catch (err) {
      // Out of graphics memory: the session steps down to smaller models. Anything else: it
      // uses another translator.
      throw (
        memoryFailure(err, 'load', simulate) ??
        new Unavailable(`The translation model couldn’t start here: ${message(err)}`)
      );
    }
    const loaded = memoryFailure(null, 'load', simulate);
    if (loaded) throw loaded;
    const loadMs = Math.round(performance.now() - started);
    // The first generation compiles the shaders (2–7 s): do it now.
    post({ type: 'progress', stage: 'warmup', fraction: null });
    const warm = performance.now();
    try {
      await generate(0, m.warmup.system, m.warmup.user, 16, () => {});
    } catch (err) {
      throw (
        memoryFailure(err, 'warmup', simulate) ??
        new Unavailable(`The translation model couldn’t run here: ${message(err)}`)
      );
    }
    const warmed = memoryFailure(null, 'warmup', simulate);
    if (warmed) throw warmed;
    post({ type: 'ready', loadMs, warmupMs: Math.round(performance.now() - warm) });
    // Later: the engine gives its lines to Chrome's translator.
    gpu.onFailure((text) => post({ type: 'error', id: null, message: text, memory: true }));
  }

  async function run(m: Extract<ToWorker, { type: 'generate' }>): Promise<void> {
    if (cancelled.delete(m.id)) {
      post({ type: 'done', id: m.id, text: '', cancelled: true, stats: emptyStats() });
      return;
    }
    const out = await generate(m.id, m.system, m.user, m.maxTokens, (text) =>
      post({ type: 'token', id: m.id, text }),
    );
    post({ type: 'done', id: m.id, ...out });
  }

  async function generate(
    id: number,
    system: string,
    user: string,
    maxTokens: number,
    onText: (delta: string) => void,
  ): Promise<{ text: string; cancelled: boolean; stats: GenerationStats }> {
    if (!engine) throw new Error('The translation model is not loaded.');
    const started = performance.now();
    const job = { id, conversation: null as Conversation | null, cancelled: false };
    current = job;
    let text = '';
    let firstTokenMs: number | null = null;
    try {
      // A new conversation per line (about 15 ms): reusing a prefilled one (`clone()`) fails on
      // the GPU backend in 0.19.0.
      job.conversation = await engine.createConversation({
        preface: { messages: [{ role: 'system', content: system }] },
        sessionConfig: {
          samplerParams: { type: SamplerType.GREEDY, k: 1, temperature: 0 },
          maxOutputTokens: maxTokens,
        },
      });
      if (job.cancelled) return { text, cancelled: true, stats: emptyStats() };
      const stream = job.conversation.sendMessageStreaming({ role: 'user', content: user });
      for await (const chunk of stream) {
        const delta = textOf(chunk.content);
        if (!delta) continue;
        if (firstTokenMs === null && delta.trim()) firstTokenMs = performance.now() - started;
        text += delta;
        onText(delta);
        if (job.cancelled) break;
      }
      const info = await job.conversation.getBenchmarkInfo().catch(() => null);
      return {
        text,
        cancelled: job.cancelled,
        stats: {
          firstTokenMs: firstTokenMs === null ? null : Math.round(firstTokenMs),
          totalMs: Math.round(performance.now() - started),
          promptTokens: info?.lastPrefillTokenCount ?? null,
          outputTokens: info?.lastDecodeTokenCount ?? null,
        },
      };
    } catch (err) {
      if (job.cancelled) return { text, cancelled: true, stats: emptyStats() };
      throw err;
    } finally {
      if (current === job) current = null;
      await job.conversation?.delete().catch(() => {});
    }
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string') out += part.text;
  }
  return out;
}

function emptyStats(): GenerationStats {
  return { firstTokenMs: null, totalMs: 0, promptTokens: null, outputTokens: null };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Relaxed SIMD (i8x16.relaxed_swizzle), as LiteRT-LM checks it. */
const RELAXED_SIMD = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15,
  65, 2, 253, 15, 253, 128, 2, 11,
]);

/** What the shipped build needs: WebGPU on a real graphics card, relaxed SIMD and JSPI. */
async function checkRuntime(): Promise<void> {
  const gpu = (navigator as { gpu?: { requestAdapter(o?: unknown): Promise<AdapterLike | null> } })
    .gpu;
  const adapter = await gpu
    ?.requestAdapter({ powerPreference: 'high-performance' })
    .catch(() => null);
  if (!adapter)
    throw new Unavailable('The translation model needs WebGPU, and this browser has none.');
  if (adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter) {
    throw new Unavailable('The translation model needs a graphics card.');
  }
  if (!('Suspending' in WebAssembly) || !WebAssembly.validate(RELAXED_SIMD)) {
    throw new Unavailable('The translation model needs a newer Chrome (137 or later).');
  }
}

interface AdapterLike {
  info?: { isFallbackAdapter?: boolean };
  isFallbackAdapter?: boolean;
}
