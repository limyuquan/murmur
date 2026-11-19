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
import type { ModelSource } from '@/models/hub';
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
  /**
   * Graphics memory it needs, MB, next to the speech model it runs with. Checked against a guess
   * (`estimateGpuMemoryMB` in hardware.ts): WebGPU doesn't tell how much a card has.
   */
  minGpuMemoryMB?: number;
  /** One-off model download, MB. Shown before the user agrees to download. */
  downloadMB?: number;
}

/**
 * A model an engine downloads before it can run. Listed so the options page can show sizes and
 * manage downloads; engines that share a model list the same `id`, and it is stored once. The
 * engine never downloads it itself: `load()` fails with `ModelMissingError` (errors.ts) until the
 * person has downloaded it.
 */
export interface EngineModel {
  id: string;
  /** Plain name for the model manager ("Whisper base, for the graphics card"). */
  label: string;
  sizeMB: number;
  /**
   * The backend this download is for, when an engine has one per backend (weights in different
   * formats): the catalog offers the one this device runs (WebGPU first).
   */
  backend?: 'webgpu' | 'wasm';
  /** The exact files. */
  source: ModelSource;
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
  /**
   * Why the engine can't be used in this build at all, whatever the device (its model files
   * aren't published yet, say). Profiles skip it and the custom picker shows it disabled.
   */
  unavailable?: string;
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
  /**
   * How it hears audio. `segments` (default): the pipeline's speech segments, as samples.
   * `track`: the live audio track (`AsrSessionOptions.track`); the pipeline still calls
   * `startSegment`/`endSegment` at speech and pauses (with no audio), and the engine still sends
   * one final per segment.
   */
  audioInput?: 'segments' | 'track';
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
  /** Uses `TranslationRequest.glossary`. */
  usesGlossary?: boolean;
  /**
   * May send a better translation of an earlier line while translating a later one
   * (`TranslationChunk.revises`).
   */
  revises?: boolean;
}

export type EngineInfo = AsrEngineInfo | TranslationEngineInfo;

export type EngineState = 'unloaded' | 'loading' | 'ready' | 'error';

/**
 * A step only the person can start, because Chrome requires a click for it: downloading a
 * built-in speech or translation language pack. Engines that need one reject `load()` (or a
 * request) with `EngineActionRequiredError` (errors.ts) carrying these; a page (popup, options)
 * runs them from a click handler with `runSetupAction` (chrome/setup.ts), and the next load
 * waits for the download.
 */
export interface SetupAction {
  /** Stable id: `speech:ko-KR`, `translation:ko>en`, `detector`. */
  id: string;
  kind: 'speech-pack' | 'translation-pack' | 'language-detector';
  /** What the button does, in plain words ("Download Korean speech recognition"). */
  label: string;
  /** For `speech-pack`: the recognizer languages. For `translation-pack`: [source, target]. */
  languages: LanguageTag[];
}

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
  /** What the session will ask for, so the engine can check packs or warm up for it. */
  session?: SessionLanguages;
}

export interface SessionLanguages {
  targetLanguage: LanguageTag;
  /** The person's source-language choice, or `null` for detect per segment. */
  sourceLanguage: LanguageTag | null;
  /** Languages the person expects to hear (empty: not said). */
  spokenLanguages: readonly LanguageTag[];
  /** Nothing but `spokenLanguages` is spoken. */
  onlySpoken?: boolean;
}

export interface Engine<I extends EngineInfo> {
  readonly info: I;
  readonly state: EngineState;
  /**
   * Initialises the model. Idempotent once `ready`. Never downloads a model the person hasn't
   * downloaded (`ModelError`); Chrome language packs need a click (`EngineActionRequiredError`).
   */
  load(options?: LoadOptions): Promise<void>;
  /** Frees the model. The engine can be loaded again later. */
  unload(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Speech recognition

export interface AsrResult {
  /**
   * The segment it belongs to. A segment the engine splits into several lines (a language
   * switch inside it) sends its later lines as `<segmentId>.<n>` (n = 2, 3, ...): they are
   * ordered right after their segment, even when they come after the next one started.
   */
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
  /**
   * Languages the person expects to hear, when they said (empty or absent: any). Engines that
   * can't detect languages listen for these.
   */
  spokenLanguages?: readonly LanguageTag[];
  /** Nothing else is spoken: detecting engines pick among `spokenLanguages` only. */
  onlySpoken?: boolean;
  /** The live audio, for engines with `audioInput: 'track'`. */
  track?: MediaStreamTrack | null;
  /** Index of the newest captured sample, so track engines can place their results in time. */
  currentSample?: () => number;
  onResult(result: AsrResult): void;
  onError(error: Error): void;
  /** Whether the engine keeps up with the audio. Sent when it changes. */
  onHealth?(health: AsrHealth): void;
  /**
   * Audio that isn't live (lookahead: decoded from the player's buffer, pushed as fast as it is
   * processed): finals only, no partial results, and no segment is ever given up on to catch up.
   */
  batch?: boolean;
}

/** How an ASR session is coping with the audio it is given. */
export interface AsrHealth {
  /** It can't keep up: partial updates are being skipped and finished lines wait in a queue. */
  behind: boolean;
  /** Audio heard but not yet decoded, ms. */
  backlogMs: number;
  /** Partial updates skipped to keep up, this session. */
  droppedPartials: number;
  /** Segments given up on (sent as empty finals) because the backlog grew too long. */
  droppedSegments: number;
  /**
   * Real-time factor of recent decodes: seconds of work per second of audio (median of the last
   * few finished lines), when the engine measures it. Over 1, it is slower than the speech.
   */
  rtf: number | null;
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
  /**
   * Optional: decode the open segment up to `endSample` soon, and send the text as a partial
   * result whose `endSample` is exactly that. The segmenter asks this at a short pause, to learn
   * whether the words so far end a sentence (and so the segment can end there). If the segment
   * then ends at that very sample, an engine may send that decode as its final. Engines that
   * can't decode on request leave it out; segments then end at pauses only.
   */
  requestPartial?(segmentId: string, endSample: number): void;
  close(): Promise<void>;
}

export interface AsrEngine extends Engine<AsrEngineInfo> {
  createSession(options: AsrSessionOptions): AsrSession;
}

// ---------------------------------------------------------------------------------------------
// Translation

export type TranslationSource =
  | {
      kind: 'text';
      text: string;
      language: LanguageTag;
      /**
       * The line mixes languages: it was heard as the target language but is partly in another
       * one (`language`, or `und` when unknown). These are every language found in it. Translate
       * the parts not in the target language and keep the rest.
       */
      mixed?: readonly LanguageTag[];
    }
  | { kind: 'speech'; samples: Float32Array; sampleRate: number; language: LanguageTag | null };

export interface TranslationRequest {
  segmentId: string;
  source: TranslationSource;
  target: LanguageTag;
  /** True when the source text is final; partial sources may be translated for a preview. */
  sourceFinal: boolean;
  /**
   * Earlier final lines of this session, oldest first, each with the language it was in (a
   * stream may switch languages between lines).
   */
  context: readonly { source: string; translation: string; language?: LanguageTag }[];
  /** Fixed renderings to keep (names, terms), for engines with `usesGlossary`. */
  glossary?: readonly { source: string; target: string }[];
  /**
   * For engines with `revises`, on a finished line only: the line just before this one, whose
   * sentence this line finishes, while its translation is still on screen. The engine may send a
   * better translation of it (`TranslationChunk.revises`) after this line's own final chunk; the
   * request's consumer keeps reading for it without holding up later lines.
   */
  previous?: {
    segmentId: string;
    source: string;
    translation: string;
    language?: LanguageTag;
  };
  /**
   * Finished lines: how long the translator may take before the session's backup translates the
   * line instead, ms (`LineFallbackTranslator`), and so when it is due. Translators with a queue
   * take finished lines that are due sooner first. Default `LINE_BUDGET_MS` (a live line, already
   * late); a line made ahead of time has until shortly before it is shown (`lookaheadBudgetMs`).
   */
  budgetMs?: number;
  signal: AbortSignal;
}

export interface TranslationChunk {
  /** The whole translation so far, not a delta (streaming engines grow it token by token). */
  text: string;
  final: boolean;
  /**
   * Engines with `revises` only: a better translation of an earlier line (`previous`), found
   * after translating this one (an LLM rereading the previous line with this one in view). `text`
   * replaces that line's final translation; `final` is ignored. Comes after this request's own
   * final chunk; absent on its own chunks.
   */
  revises?: { segmentId: string };
  /** The language the engine found the source to be in, when it checked (may differ from the request's). */
  sourceLanguage?: LanguageTag;
}

export interface TranslationEngine extends Engine<TranslationEngineInfo> {
  /** Yields growing translations, ending with one `final: true` chunk (unless aborted). */
  translate(request: TranslationRequest): AsyncIterable<TranslationChunk>;
}

export type AnyEngine = AsrEngine | TranslationEngine;
