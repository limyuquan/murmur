/**
 * Qwen3-ASR-0.6B on ONNX Runtime Web (WebGPU): log-mel → audio encoder → prompt embeddings with
 * the audio rows spliced in → prefill → greedy decoding through the merged decoder, its KV cache
 * kept on the GPU. Runs in the engine's worker only.
 *
 * - Encoder: SubtitleKing's `audio_encoder_fp16` (fp32 in and out).
 * - Decoder: the same export's merged decoder (fused attention, per-layer KV), with every
 *   `MatMulNBits` re-quantized to 8 bits. Its `lm_head` is tied to the token embeddings, so the
 *   embedding rows are read straight from the 8-bit `lm_head` bytes (`.tied.json` gives where).
 * - Language: at the step after `language`, the logits over each language name's first token
 *   give the segment's language (restricted to `allowed` when given) and ` None` the chance that
 *   there is no speech.
 */
import * as ort from 'onnxruntime-web/webgpu';
import { QWEN3_FILES } from './info';
import { audioTokens, logMel } from './mel';
import {
  ASR_TEXT,
  AUDIO_OFFSET,
  EOS,
  LANGUAGE,
  LANGUAGE_TOKENS,
  maxAnswerTokens,
  NONE,
  parseAnswer,
  promptIds,
} from './prompt';
import { TokenDecoder } from './tokenizer';

const HIDDEN = 1024;
const LAYERS = 28;
const KV_HEADS = 8;
const HEAD_DIM = 128;

export { ort };

export type FileReader = (path: string) => Promise<Uint8Array>;

export interface TranscribeOptions {
  /** Pick the language among these tags only (the model's tags), or null for any. */
  allowed?: readonly string[] | null;
  /**
   * Answer tokens to force before decoding: `language X<asr_text>` to fix the language, or the
   * start of an earlier answer for the same (grown) audio.
   */
  forced?: readonly number[] | null;
  /** Decode at least this many tokens, ignoring the end (warm-up). */
  minTokens?: number;
}

export interface Transcript {
  text: string;
  /** Tag, or null when the model heard no speech. */
  language: string | null;
  /** Probability of `language` among the candidates (1 when it was forced). */
  languageProb: number;
  /** P(` None`) at the language step: the model's own no-speech probability (0 when forced). */
  noSpeechProb: number;
  /** Mean log-probability of the decoded text tokens, end included (0 when none). */
  avgLogprob: number;
  /** The whole answer, forced part included (for a later rollback prefix). */
  ids: number[];
  /** Tokens decoded (forced ones not counted). */
  decoded: number;
  ms: { mel: number; encoder: number; prefill: number; decode: number; total: number };
}

const now = () => performance.now();

export class Qwen3Asr {
  private kv: ort.Tensor[] = [];
  private pos = 0;

  private constructor(
    private readonly encoder: ort.InferenceSession,
    private readonly decoder: ort.InferenceSession,
    private readonly embedRows: (ids: readonly number[]) => Float32Array,
    readonly tokenizer: TokenDecoder,
  ) {}

  /** Creates the sessions from the model files (read with `read`, never fetched). */
  static async load(
    read: FileReader,
    onProgress?: (fraction: number, file: string) => void,
  ): Promise<Qwen3Asr> {
    const f = QWEN3_FILES;
    const bufs = new Map<string, Uint8Array>();
    const paths = Object.values(f);
    let done = 0;
    for (const path of paths) {
      bufs.set(path, await read(path));
      onProgress?.(++done / (paths.length + 2), path);
    }
    const get = (p: string) => bufs.get(p) as Uint8Array;
    const json = (p: string) => JSON.parse(new TextDecoder().decode(get(p)));
    const tokenizer = new TokenDecoder(json(f.vocab), json(f.addedTokens));
    const embedRows = tiedEmbedding(json(f.tied), get(f.decoderData));
    const session = (model: string, data: string, gpuOutputs: string[] = []) =>
      ort.InferenceSession.create(get(model), {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
        externalData: [{ path: data.split('/').pop() as string, data: get(data) }],
        ...(gpuOutputs.length
          ? {
              preferredOutputLocation: Object.fromEntries(
                gpuOutputs.map((o) => [o, 'gpu-buffer' as const]),
              ),
            }
          : {}),
      });
    const encoder = await session(f.encoder, f.encoderData);
    bufs.delete(f.encoder);
    bufs.delete(f.encoderData);
    onProgress?.((paths.length + 1) / (paths.length + 2), f.encoder);
    const presents = Array.from({ length: LAYERS }, (_, i) => [
      `present.${i}.key`,
      `present.${i}.value`,
    ]).flat();
    const decoder = await session(f.decoder, f.decoderData, presents);
    bufs.clear();
    onProgress?.(1, f.decoder);
    return new Qwen3Asr(encoder, decoder, embedRows, tokenizer);
  }

  async transcribe(samples: Float32Array, opts: TranscribeOptions = {}): Promise<Transcript> {
    const t0 = now();
    const seconds = samples.length / 16_000;
    const { data: mel, frames } = logMel(samples);
    const t1 = now();
    const audio = await this.encode(mel, frames);
    const rows = audio.length / HIDDEN;
    if (rows !== audioTokens(frames)) {
      throw new Error(`The audio encoder gave ${rows} rows, expected ${audioTokens(frames)}.`);
    }
    const t2 = now();
    const forced = [...(opts.forced ?? [])];
    const ids = promptIds(rows, forced);
    const embeds = this.embedRows(ids);
    embeds.set(audio, AUDIO_OFFSET * HIDDEN);
    this.reset();
    let logits = await this.run(embeds, ids.length);
    const t3 = now();

    const allowed = (opts.allowed ?? []).filter((c) => LANGUAGE_TOKENS[c]);
    const candidates = allowed.length > 0 ? allowed : Object.keys(LANGUAGE_TOKENS);
    const cap = Math.max(maxAnswerTokens(seconds), forced.length + 8);
    const answer = forced;
    let languageProb = 1;
    let noSpeechProb = 0;
    let noSpeech = false;
    let sumLogprob = 0;
    let scored = 0;
    let decoded = 0;
    try {
      while (answer.length < cap) {
        const row = await lastRow(logits);
        let next = argmax(row);
        if (answer.length === 1 && answer[0] === LANGUAGE) {
          // The language name: the best candidate (forced when `allowed` rules out the model's
          // own choice), and the model's own chance that there is no speech at all.
          const pick = pickLanguage(row, candidates);
          languageProb = pick.prob;
          noSpeechProb = pick.noSpeech;
          if (next === NONE) {
            noSpeech = true;
            break;
          }
          next = firstToken(pick.tag);
        } else if (EOS.has(next) && decoded < (opts.minTokens ?? 0)) {
          next = secondBest(row, next);
        }
        if (answer.includes(ASR_TEXT)) {
          sumLogprob += logSoftmaxAt(row, next);
          scored++;
        }
        if (EOS.has(next)) break;
        answer.push(next);
        decoded++;
        if (answer.length >= cap) break;
        disposeIfGpu(logits);
        logits = await this.run(this.embedRows([next]), 1);
      }
    } finally {
      disposeIfGpu(logits);
    }
    const t4 = now();
    const parsed = parseAnswer(answer, this.tokenizer);
    return {
      text: noSpeech ? '' : parsed.text,
      language: noSpeech ? null : parsed.language,
      languageProb: noSpeech ? 0 : languageProb,
      noSpeechProb,
      avgLogprob: scored > 0 ? sumLogprob / scored : 0,
      ids: answer,
      decoded,
      ms: { mel: t1 - t0, encoder: t2 - t1, prefill: t3 - t2, decode: t4 - t3, total: t4 - t0 },
    };
  }

  async release(): Promise<void> {
    this.reset();
    await Promise.all([this.encoder.release(), this.decoder.release()]);
  }

  private async encode(mel: Float32Array, frames: number): Promise<Float32Array> {
    const out = await this.encoder.run({
      input_features: new ort.Tensor('float32', mel, [1, 128, frames]),
    });
    const t = out.audio_features as ort.Tensor;
    const data = (await t.getData()) as Float32Array;
    t.dispose();
    return data;
  }

  /** Runs `length` new positions through the decoder; keeps their KV; returns the logits. */
  private async run(embeds: Float32Array, length: number): Promise<ort.Tensor> {
    const total = this.pos + length;
    const feeds: Record<string, ort.Tensor> = {
      inputs_embeds: new ort.Tensor('float32', embeds, [1, length, HIDDEN]),
      attention_mask: new ort.Tensor('int64', new BigInt64Array(total).fill(1n), [1, total]),
      position_ids: new ort.Tensor(
        'int64',
        BigInt64Array.from({ length }, (_, i) => BigInt(this.pos + i)),
        [1, length],
      ),
      num_logits_to_keep: new ort.Tensor('int64', BigInt64Array.of(1n), []),
    };
    const empty = () => new ort.Tensor('float32', new Float32Array(0), [1, KV_HEADS, 0, HEAD_DIM]);
    for (let i = 0; i < LAYERS; i++) {
      feeds[`past_key_values.${i}.key`] = this.kv[2 * i] ?? empty();
      feeds[`past_key_values.${i}.value`] = this.kv[2 * i + 1] ?? empty();
    }
    const out = await this.decoder.run(feeds);
    this.disposeKv();
    for (let i = 0; i < LAYERS; i++) {
      this.kv.push(out[`present.${i}.key`] as ort.Tensor, out[`present.${i}.value`] as ort.Tensor);
    }
    this.pos = total;
    return out.logits as ort.Tensor;
  }

  private disposeKv(): void {
    for (const t of this.kv) disposeIfGpu(t);
    this.kv = [];
  }

  private reset(): void {
    this.disposeKv();
    this.pos = 0;
  }
}

function disposeIfGpu(t: ort.Tensor): void {
  if (t.location === 'gpu-buffer') t.dispose();
}

/** The last position's logits, as float32 on the CPU. */
async function lastRow(t: ort.Tensor): Promise<Float32Array> {
  const raw = await t.getData();
  const data =
    raw instanceof Float32Array
      ? raw
      : Float32Array.from(
          raw instanceof Uint16Array
            ? new Float16Array(raw.buffer, raw.byteOffset, raw.length)
            : (raw as ArrayLike<number>),
        );
  const vocab = t.dims[t.dims.length - 1] as number;
  return data.length === vocab ? data : data.subarray(data.length - vocab);
}

export function argmax(row: Float32Array): number {
  let arg = 0;
  let best = -Infinity;
  for (let i = 0; i < row.length; i++) {
    const v = row[i] as number;
    if (v > best) {
      best = v;
      arg = i;
    }
  }
  return arg;
}

function secondBest(row: Float32Array, not: number): number {
  let arg = not === 0 ? 1 : 0;
  for (let i = 0; i < row.length; i++) {
    if (i !== not && !EOS.has(i) && (row[i] as number) > (row[arg] as number)) arg = i;
  }
  return arg;
}

/** log softmax(row)[index]. */
export function logSoftmaxAt(row: Float32Array, index: number): number {
  let max = -Infinity;
  for (let i = 0; i < row.length; i++) if ((row[i] as number) > max) max = row[i] as number;
  let sum = 0;
  for (let i = 0; i < row.length; i++) sum += Math.exp((row[i] as number) - max);
  return (row[index] as number) - max - Math.log(sum);
}

/**
 * The language step: the best candidate with its probability among the candidates (softmax over
 * each name's first token), and P(` None`) over the whole vocabulary.
 */
export function pickLanguage(
  row: Float32Array,
  candidates: readonly string[],
): { tag: string; prob: number; noSpeech: number } {
  let max = -Infinity;
  for (const c of candidates) max = Math.max(max, row[firstToken(c)] as number);
  let sum = 0;
  let best = candidates[0] as string;
  let bestExp = -1;
  for (const c of candidates) {
    const e = Math.exp((row[firstToken(c)] as number) - max);
    sum += e;
    if (e > bestExp) {
      bestExp = e;
      best = c;
    }
  }
  return {
    tag: best,
    prob: sum > 0 ? bestExp / sum : 0,
    noSpeech: Math.exp(logSoftmaxAt(row, NONE)),
  };
}

const firstToken = (tag: string) => (LANGUAGE_TOKENS[tag] as readonly number[])[0] as number;

/**
 * Embedding rows from the decoder's 8-bit `lm_head` (Qwen3 ties it to the token embeddings):
 * uint8 [vocab, 1024] with zero point 128 and one fp32 scale per 32 values, at the byte ranges
 * the `.tied.json` sidecar gives. Copies those ranges, so the data file can be freed.
 */
export function tiedEmbedding(
  meta: { q8: { offset: number; length: number }; scales: { offset: number; length: number } },
  data: Uint8Array,
): (ids: readonly number[]) => Float32Array {
  const q = data.slice(meta.q8.offset, meta.q8.offset + meta.q8.length);
  const sb = data.slice(meta.scales.offset, meta.scales.offset + meta.scales.length);
  const scales = new Float32Array(sb.buffer, sb.byteOffset, sb.byteLength / 4);
  const blocks = HIDDEN / 32;
  return (ids) => {
    const out = new Float32Array(ids.length * HIDDEN);
    ids.forEach((id, r) => {
      for (let b = 0; b < blocks; b++) {
        const scale = scales[id * blocks + b] as number;
        const base = id * HIDDEN + b * 32;
        const at = r * HIDDEN + b * 32;
        for (let j = 0; j < 32; j++) out[at + j] = ((q[base + j] as number) - 128) * scale;
      }
    });
    return out;
  };
}
