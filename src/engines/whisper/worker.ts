/**
 * The Whisper worker: one model, loaded once, decoding one segment at a time. Spawned by the
 * Whisper engine in the offscreen document; terminating it frees the model.
 *
 * Each decode is one `generate()` call (so the encoder runs once) whose first step does language
 * detection: the decoder starts from `<|startoftranscript|>` alone, and `WhisperControl` reads the
 * first step's logits for the language tokens (the segment's language, never one fixed for the
 * stream) and `<|nospeech|>` (for the silence guard), then forces the chosen language,
 * `<|transcribe|>` and `<|notimestamps|>`, and applies Whisper's token suppression itself.
 * transformers.js 4.3.2 has no Whisper language detection of its own (it defaults to English).
 *
 * No remote code: ONNX Runtime's WebAssembly files ship in the extension (`wasmPaths`); only the
 * model weights come from Hugging Face, cached in the Cache API.
 */
import {
  AutoProcessor,
  AutoTokenizer,
  env,
  LogitsProcessor,
  LogitsProcessorList,
  type ProgressInfo,
  type Tensor,
  WhisperForConditionalGeneration,
} from '@huggingface/transformers';
// ONNX Runtime's WebAssembly build, emitted into the extension by Vite: never the CDN default.
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import type { DecodeOutput, FromWorker, ToWorker, WhisperDevice } from './messages';

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
// The runtime's files are the extension's own: no need to cache them, and the cache path imports
// the runtime from a blob: URL, which the extension's script policy rightly refuses.
env.useWasmCache = false;

interface GenerationConfigLike {
  decoder_start_token_id: number;
  eos_token_id: number | number[];
  no_timestamps_token_id: number;
  lang_to_id: Record<string, number>;
  task_to_id: Record<string, number>;
  suppress_tokens: number[] | null;
  begin_suppress_tokens: number[] | null;
}

interface Loaded {
  model: WhisperForConditionalGeneration;
  processor: (audio: Float32Array) => Promise<{ input_features: Tensor }>;
  tokenizer: { decode(ids: number[], options: { skip_special_tokens: boolean }): string };
  config: GenerationConfigLike;
  /** Language token id → Whisper code (`ko`). */
  languages: Map<number, string>;
  device: WhisperDevice;
}

let loaded: Loaded | null = null;
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
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
}

async function load(message: Extract<ToWorker, { type: 'load' }>): Promise<void> {
  const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } };
  if (onnx.wasm) {
    onnx.wasm.wasmPaths = {
      mjs: new URL(ortMjs, self.location.href).href,
      wasm: new URL(ortWasm, self.location.href).href,
    };
    onnx.wasm.numThreads = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 2) - 2));
  }
  const started = performance.now();
  const files = new Map<string, { loaded: number; total: number }>();
  const progress_callback = (info: ProgressInfo) => {
    if (info.status === 'progress') {
      files.set(info.file, { loaded: info.loaded, total: info.total });
      let loadedBytes = 0;
      let total = 0;
      for (const f of files.values()) {
        loadedBytes += f.loaded;
        total += f.total;
      }
      post({
        type: 'progress',
        stage: 'download',
        fraction: total > 0 ? loadedBytes / total : null,
        file: info.file,
      });
    }
  };
  const options = { revision: message.revision, progress_callback };
  const [processor, tokenizer] = await Promise.all([
    AutoProcessor.from_pretrained(message.repo, options),
    AutoTokenizer.from_pretrained(message.repo, options),
  ]);

  let lastError: unknown = null;
  for (const { device, dtype } of message.devices) {
    if (device === 'webgpu' && !(await hasWebGpu())) continue;
    try {
      const model = (await WhisperForConditionalGeneration.from_pretrained(message.repo, {
        ...options,
        device,
        dtype,
      })) as WhisperForConditionalGeneration;
      const config = model.generation_config as unknown as GenerationConfigLike;
      const languages = new Map<number, string>();
      for (const [token, id] of Object.entries(config.lang_to_id)) {
        languages.set(id, token.replace(/^<\|/, '').replace(/\|>$/, ''));
      }
      loaded = {
        model,
        processor: processor as unknown as Loaded['processor'],
        tokenizer: tokenizer as unknown as Loaded['tokenizer'],
        config,
        languages,
        device,
      };
      const loadMs = Math.round(performance.now() - started);
      // The first decode compiles the GPU shaders (seconds to tens of seconds): do it now, on
      // quiet noise, so the first real line isn't late.
      post({ type: 'progress', stage: 'warmup', fraction: null });
      const warm = performance.now();
      const noise = new Float32Array(16_000 * 2).map(() => (Math.random() - 0.5) * 0.01);
      await decode({ type: 'decode', id: -1, samples: noise, languages: null });
      post({ type: 'ready', device, loadMs, warmupMs: Math.round(performance.now() - warm) });
      return;
    } catch (err) {
      lastError = err;
      loaded = null;
    }
  }
  throw lastError ?? new Error('No way to run Whisper here (needs WebGPU or WebAssembly).');
}

async function hasWebGpu(): Promise<boolean> {
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  try {
    return !!(await gpu?.requestAdapter());
  } catch {
    return false;
  }
}

async function decode(message: Extract<ToWorker, { type: 'decode' }>): Promise<DecodeOutput> {
  if (!loaded) throw new Error('Whisper is not loaded.');
  const started = performance.now();
  const { model, processor, tokenizer, config, languages } = loaded;
  const { input_features } = await processor(message.samples);
  const allowed = message.languages
    ? [...languages.entries()].filter(([, code]) => message.languages?.includes(code))
    : [...languages.entries()];
  const control = new WhisperControl(config, allowed.length > 0 ? allowed : [...languages]);
  const processors = new LogitsProcessorList();
  processors.push(control);
  // About 25 tokens a second of speech is plenty for any language; caps runaway loops.
  const seconds = message.samples.length / 16_000;
  const max_new_tokens = Math.min(220, Math.ceil(12 + seconds * 25));
  const sequences = (await model.generate({
    inputs: input_features,
    decoder_input_ids: [config.decoder_start_token_id],
    logits_processor: processors,
    max_new_tokens,
    // Applied by WhisperControl after it has read the raw first-step logits.
    suppress_tokens: null,
    begin_suppress_tokens: null,
    return_timestamps: false,
  } as unknown as Parameters<typeof model.generate>[0])) as Tensor;
  const ids = (sequences.tolist() as bigint[][])[0]?.map(Number) ?? [];
  const eos = Array.isArray(config.eos_token_id) ? config.eos_token_id[0] : config.eos_token_id;
  const textIds = ids.slice(PREFIX).filter((id) => id < (eos ?? 50257));
  const text = tokenizer.decode(textIds, { skip_special_tokens: true }).trim();
  return {
    id: message.id,
    text,
    language: control.language,
    languageProb: control.languageProb,
    noSpeechProb: control.noSpeechProb,
    avgLogprob: control.avgLogprob(),
    tokens: textIds.length,
    ms: Math.round(performance.now() - started),
  };
}

/** `<|startoftranscript|> <|lang|> <|transcribe|> <|notimestamps|>`. */
const PREFIX = 4;

/**
 * Drives Whisper's first steps and scores the decode. Steps (by sequence length): 1 → pick the
 * language (recording language and no-speech probabilities), 2 → `<|transcribe|>`,
 * 3 → `<|notimestamps|>`, then text with Whisper's suppressed tokens masked (and blank / end of
 * text masked at the first text position). Greedy decoding picks the arg-max, so the processor
 * knows each chosen token and sums their log-probabilities.
 */
class WhisperControl extends LogitsProcessor {
  language = 'en';
  languageProb = 0;
  noSpeechProb = 0;
  private sumLogprob = 0;
  private count = 0;

  constructor(
    private readonly config: GenerationConfigLike,
    private readonly allowed: [number, string][],
  ) {
    super();
  }

  avgLogprob(): number {
    return this.count > 0 ? this.sumLogprob / this.count : 0;
  }

  override _call(inputIds: bigint[][], logits: Tensor): Tensor {
    const length = inputIds[0]?.length ?? 0;
    const data = logits.data as Float32Array;
    const vocab = data.length;
    if (length === 1) {
      const probs = softmax(data);
      this.noSpeechProb = probs[this.config.no_timestamps_token_id - 1] ?? 0;
      let total = 0;
      let best: [number, string] | undefined;
      let bestP = -1;
      for (const entry of this.allowed) {
        const p = probs[entry[0]] ?? 0;
        total += p;
        if (p > bestP) {
          bestP = p;
          best = entry;
        }
      }
      if (best) {
        this.language = best[1];
        this.languageProb = total > 0 ? bestP / total : 0;
        force(data, best[0]);
      }
      return logits;
    }
    if (length === 2) {
      force(data, this.config.task_to_id.transcribe as number);
      return logits;
    }
    if (length === 3) {
      force(data, this.config.no_timestamps_token_id);
      return logits;
    }
    for (const id of this.config.suppress_tokens ?? []) if (id < vocab) data[id] = -Infinity;
    // No special tokens (languages, tasks, timestamps) in the text; end of text stays allowed.
    for (let id = this.config.decoder_start_token_id; id < vocab; id++) data[id] = -Infinity;
    if (length === PREFIX) {
      for (const id of this.config.begin_suppress_tokens ?? []) data[id] = -Infinity;
    }
    // Score the token greedy decoding will pick.
    let arg = 0;
    for (let i = 1; i < vocab; i++) if ((data[i] as number) > (data[arg] as number)) arg = i;
    this.sumLogprob += logSoftmaxAt(data, arg);
    this.count++;
    return logits;
  }
}

function force(data: Float32Array, id: number): void {
  data.fill(-Infinity);
  data[id] = 0;
}

function softmax(data: Float32Array): Float32Array {
  let max = -Infinity;
  for (const v of data) if (v > max) max = v;
  const out = new Float32Array(data.length);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const e = Math.exp((data[i] as number) - max);
    out[i] = e;
    sum += e;
  }
  for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) / sum;
  return out;
}

function logSoftmaxAt(data: Float32Array, index: number): number {
  let max = -Infinity;
  for (const v of data) if (v > max) max = v;
  let sum = 0;
  for (const v of data) if (v !== -Infinity) sum += Math.exp(v - max);
  return (data[index] as number) - max - Math.log(sum);
}
