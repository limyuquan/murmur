/**
 * Engine contracts. An engine is one model (or service) behind a small async interface, so the
 * pipeline never knows whether text comes from a demo stub, a WebGPU model in a worker, Chrome's
 * built-in APIs, or a local companion app. Model choice is open; these interfaces are what stays.
 *
 * - `AsrEngine`: speech segments in, streaming partial + final text out, each result tagged with
 *   the language it was in. Never assume one language per stream: every segment carries its own.
 * - `TranslationEngine`: text (or, for speech-translation models, audio) in, streaming translation
 *   out, with earlier lines as context.
 *
 * Heavy engines should do their work in a dedicated Worker (one per model, so unloading one frees
 * its memory) and implement these interfaces as a thin proxy in the offscreen document.
 */
import type { HardwareInfo } from './hardware';

/** BCP-47 language tag ("en", "ja", "pt-BR"), or `UNKNOWN_LANGUAGE`. */
export type LanguageTag = string;
export const UNKNOWN_LANGUAGE: LanguageTag = 'und';

export interface DetectedLanguage {
  tag: LanguageTag;
  /** 0–1. Engines that only echo a hint report 0. */
  confidence: number;
}

export type EngineKind = 'asr' | 'translation';

/**
 * Where the model runs.
 * - `browser`: in the extension (WebGPU / WASM workers), downloaded once and cached.
 * - `companion`: in the optional local companion app.
 * - `chrome`: a model built into Chrome (on-device speech, Translator API).
 * - `demo`: no model; placeholder output for development and tests.
 */
export type EngineRuntime = 'browser' | 'companion' | 'chrome' | 'demo';

/** A way to run compute. `none` = plain JS, runs anywhere. */
export type ComputeBackend = 'webgpu' | 'wasm' | 'companion' | 'none';

export interface HardwareRequirements {
  /** Backends the engine can use; it runs if any one is available. */
  backends: readonly ComputeBackend[];
  /** `navigator.deviceMemory` floor, GB (Chrome caps the reported value at 8). */
  minDeviceMemoryGB?: number;
  /** Largest WebGPU buffer it needs, MB (`adapter.limits.maxBufferSize`). */
  minGpuBufferMB?: number;
  /** Needs WebGPU `shader-f16`. */
  shaderF16?: boolean;
  /** One-off model download, MB. Shown before the user agrees to download. */
  downloadMB?: number;
}

/**
 * A model an engine downloads before it can run. Listed so the options page can show sizes and
 * manage downloads; engines that share a model list the same `id`, and it is stored once.
 */
export interface EngineModel {
  id: string;
  /** Plain name for the model manager ("Speech recognition, small"). */
  label: string;
  sizeMB: number;
}

/** Static description of an engine: readable without loading it (settings, popup). */
export interface EngineInfoBase {
  /** Stable id, stored in settings: `<family>-<variant>`, e.g. `demo-echo`. */
  id: string;
  label: string;
  /** One plain sentence for the options page. */
  description: string;
  runtime: EngineRuntime;
  requirements: HardwareRequirements;
  /** Models to download before the engine can run. None for engines that need no download. */
  models?: readonly EngineModel[];
  license?: string;
  homepage?: string;
}

export interface AsrEngineInfo extends EngineInfoBase {
  kind: 'asr';
  /** Languages it transcribes, or `any`. */
  languages: readonly LanguageTag[] | 'any';
  /** Emits partial results while a segment is still open. */
  streaming: boolean;
  /** Tags each result with a detected language (else it echoes the hint, or `und`). */
  detectsLanguage: boolean;
  /** Handles a language switch inside one segment. */
  codeSwitching: boolean;
}

export type TranslationInput = 'text' | 'speech';

export interface TranslationEngineInfo extends EngineInfoBase {
  kind: 'translation';
  /** Text MT takes `text`; speech-translation models take `speech` (segment audio). */
  inputs: readonly TranslationInput[];
  sources: readonly LanguageTag[] | 'any';
  targets: readonly LanguageTag[] | 'any';
  /** Streams the translation as it's generated (vs. one final result). */
  streaming: boolean;
  /** Uses `TranslationRequest.context` (earlier lines) to translate better. */
  usesContext: boolean;
}

export type EngineInfo = AsrEngineInfo | TranslationEngineInfo;

export type EngineState = 'unloaded' | 'loading' | 'ready' | 'error';

export interface LoadProgress {
  stage: 'download' | 'compile' | 'warmup';
  /** 0–1 when known. */
  fraction: number | null;
  /** The file being fetched, for the status line. */
  file?: string;
}

export interface LoadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: LoadProgress) => void;
  hardware?: HardwareInfo;
}

export interface Engine<I extends EngineInfo> {
  readonly info: I;
  readonly state: EngineState;
  /** Downloads (if needed) and initialises the model. Idempotent once `ready`. */
  load(options?: LoadOptions): Promise<void>;
  /** Frees the model. The engine can be loaded again later. */
  unload(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Speech recognition

export interface AsrResult {
  segmentId: string;
  /** False: may still change (shown dimmed). True: the segment's last word. */
  final: boolean;
  /** The whole segment's text so far, not a delta. */
  text: string;
  /** Language of this result. `null` when unknown. */
  language: DetectedLanguage | null;
  /** Span of the segment this text covers, in pipeline samples. */
  startSample: number;
  endSample: number;
}

export interface AsrSessionOptions {
  sampleRate: number;
  /** A language to prefer, or `null` to detect per segment. Only a hint: results say what was heard. */
  languageHint: LanguageTag | null;
  onResult(result: AsrResult): void;
  onError(error: Error): void;
}

/**
 * One capture's worth of recognition. The pipeline's segmenter calls these in order:
 * `startSegment`, any number of `pushAudio`, `endSegment`; segments never overlap. An engine with
 * its own endpointing can ignore segment boundaries for decoding, but must still finish every
 * segment with exactly one final result (empty text is fine).
 */
export interface AsrSession {
  startSegment(segmentId: string, startSample: number): void;
  /** Audio for the open segment; contiguous with the previous chunk. */
  pushAudio(segmentId: string, samples: Float32Array, startSample: number): void;
  endSegment(segmentId: string, endSample: number): void;
  close(): Promise<void>;
}

export interface AsrEngine extends Engine<AsrEngineInfo> {
  createSession(options: AsrSessionOptions): AsrSession;
}

// ---------------------------------------------------------------------------------------------
// Translation

export type TranslationSource =
  | { kind: 'text'; text: string; language: LanguageTag }
  | { kind: 'speech'; samples: Float32Array; sampleRate: number; language: LanguageTag | null };

export interface TranslationRequest {
  segmentId: string;
  source: TranslationSource;
  target: LanguageTag;
  /** True when the source text is final; partial sources may be translated for a preview. */
  sourceFinal: boolean;
  /** Earlier final lines of this session, oldest first. */
  context: readonly { source: string; translation: string }[];
  signal: AbortSignal;
}

export interface TranslationChunk {
  /** The whole translation so far, not a delta. */
  text: string;
  final: boolean;
}

export interface TranslationEngine extends Engine<TranslationEngineInfo> {
  /** Yields growing translations, ending with one `final: true` chunk (unless aborted). */
  translate(request: TranslationRequest): AsyncIterable<TranslationChunk>;
}

export type AnyEngine = AsrEngine | TranslationEngine;
