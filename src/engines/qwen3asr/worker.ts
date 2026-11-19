/**
 * The Qwen3-ASR worker: one model, loaded once, decoding one segment at a time. Spawned by the
 * engine in the offscreen document; terminating it frees the model and its GPU memory.
 *
 * No remote code: ONNX Runtime's WebAssembly files ship in the extension (`wasmPaths`). No
 * downloads either: the files were downloaded when the person asked (models/store.ts), and the
 * worker reads them from the model cache. A missing file fails the load.
 */
// ONNX Runtime's WebAssembly build, emitted into the extension by Vite: never the CDN default.
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { MODEL_CACHE, readFile } from '@/models/hub';
import type { DecodeOutput, FromWorker, ToWorker } from './messages';
import { ort, Qwen3Asr } from './model';
import { languageIds } from './prompt';

ort.env.wasm.wasmPaths = {
  mjs: new URL(ortMjs, self.location.href).href,
  wasm: new URL(ortWasm, self.location.href).href,
};
ort.env.wasm.numThreads = 1;
ort.env.webgpu.powerPreference = 'high-performance';

let model: Qwen3Asr | null = null;
/** Decodes run one at a time, in arrival order. */
let queue: Promise<void> = Promise.resolve();

const post = (message: FromWorker) => self.postMessage(message);

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type === 'load') {
    queue = queue.then(() => load(message)).catch(fail(null));
  } else if (message.type === 'decode') {
    queue = queue
      .then(async () => post({ type: 'result', output: await decode(message) }))
      .catch(fail(message.id));
  }
};

function fail(id: number | null) {
  return (err: unknown) =>
    post({
      type: 'error',
      id,
      message: err instanceof Error ? err.message : String(err),
      ...(err instanceof Unavailable ? { unavailable: true } : {}),
    });
}

class Unavailable extends Error {}

async function load(message: Extract<ToWorker, { type: 'load' }>): Promise<void> {
  const started = performance.now();
  const adapter = await (
    navigator as { gpu?: { requestAdapter(o?: unknown): Promise<GpuAdapterLike | null> } }
  ).gpu
    ?.requestAdapter({ powerPreference: 'high-performance' })
    .catch(() => null);
  if (!adapter) throw new Unavailable('Qwen3-ASR needs WebGPU, and this browser has none.');
  if (!adapter.features.has('shader-f16')) {
    throw new Unavailable('Qwen3-ASR needs a graphics card with 16-bit float shaders.');
  }
  const cache = await caches.open(MODEL_CACHE);
  const { source } = message.model;
  model = await Qwen3Asr.load(
    message.model,
    async (path) => {
      const file = source.files.find((f) => f.path === path);
      const res = file && (await readFile(cache, source, file));
      if (!res) throw new Error(`${path} isn’t downloaded.`);
      return new Uint8Array(await res.arrayBuffer());
    },
    (fraction, file) => post({ type: 'progress', stage: 'compile', fraction, file }),
  );
  const loadMs = Math.round(performance.now() - started);
  // The first decodes compile the GPU shaders for each new shape: do it now, on ~10 s of quiet
  // noise with a forced language and some decoding steps, so the first real line isn't late.
  post({ type: 'progress', stage: 'warmup', fraction: null });
  const warm = performance.now();
  const noise = new Float32Array(16_000 * 10).map(() => (Math.random() - 0.5) * 0.01);
  await model.transcribe(noise, { forced: languageIds('en'), minTokens: 16 });
  post({ type: 'ready', loadMs, warmupMs: Math.round(performance.now() - warm) });
}

interface GpuAdapterLike {
  features: { has(name: string): boolean };
}

async function decode(message: Extract<ToWorker, { type: 'decode' }>): Promise<DecodeOutput> {
  if (!model) throw new Error('Qwen3-ASR is not loaded.');
  const started = performance.now();
  const out = await model.transcribe(message.samples, {
    allowed: message.languages,
    forced: message.prefix,
  });
  return {
    id: message.id,
    text: out.text,
    language: out.language ?? 'und',
    languageProb: out.languageProb,
    noSpeechProb: out.noSpeechProb,
    avgLogprob: out.avgLogprob,
    ids: out.ids,
    tokens: out.decoded,
    looped: out.looped,
    ms: Math.round(performance.now() - started),
  };
}
