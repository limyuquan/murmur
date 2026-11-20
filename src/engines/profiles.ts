/**
 * Model profiles: what most people pick instead of individual engines. Each profile lists engine
 * ids in order of preference; the first one that is registered and fits the device wins, and the
 * demo engines are the last resort. So adding a real engine is: register it (builtin.ts), then put
 * its id at the front of the profiles it suits. `custom` uses the engines chosen in settings.
 *
 * Balanced and Best also have a memory ladder (`LADDERS`): pairs of engines from the largest down.
 * WebGPU doesn't say how much graphics memory a card has, so a session starts at the first pair
 * that fits a guess (`estimateGpuMemoryMB`), or at the pair that last worked on this device
 * (settings/memoryfit.ts), and steps down the ladder when an engine runs out of memory while
 * loading or warming up (loading.ts `loadLadder`).
 */
import { CHROME_TRANSLATOR_ID, CHROME_WEBSPEECH_ID } from './chrome/info';
import { DEMO_ASR_ID, DEMO_TRANSLATION_ID } from './demo/ids';
import {
  checkEngine,
  estimateGpuMemoryMB,
  formatGB,
  gpuKind,
  type HardwareInfo,
  sharesMemory,
} from './hardware';
import { GEMMA_E2B_ID, GEMMA_E4B_ID, GEMMA_E4B_INFO } from './llm/info';
import { QWEN3_ASR_17B_ID, QWEN3_ASR_17B_INFO, QWEN3_ASR_ID } from './qwen3asr/info';
import type { EngineRegistry } from './registry';
import type { EngineInfo } from './types';

export type ProfileId = 'light' | 'balanced' | 'best';
export type ProfileChoice = ProfileId | 'custom';

export interface ModelProfile {
  id: ProfileId;
  label: string;
  description: string;
  /** ASR engine ids, most preferred first. */
  asr: readonly string[];
  /** Translation engine ids, most preferred first. */
  translation: readonly string[];
}

export { DEMO_ASR_ID, DEMO_TRANSLATION_ID };
export const WHISPER_BASE_ID = 'whisper-base';
export const WHISPER_TURBO_ID = 'whisper-large-v3-turbo';
export { GEMMA_E2B_ID, GEMMA_E4B_ID, QWEN3_ASR_17B_ID, QWEN3_ASR_ID };

/**
 * What runs when an engine turns out not to work here once it loads (EngineUnavailableError):
 * the service worker can't see Chrome's speech APIs, so the profile can't rule them out.
 */
export const RUNTIME_FALLBACKS: Readonly<Record<string, string>> = {
  [CHROME_WEBSPEECH_ID]: WHISPER_BASE_ID,
  // Its worker found no 16-bit float shaders after all, or its files aren't published. The 1.7B
  // goes to the 0.6B, which then goes to turbo for the same reasons.
  [QWEN3_ASR_17B_ID]: QWEN3_ASR_ID,
  [QWEN3_ASR_ID]: WHISPER_TURBO_ID,
  // Out of graphics memory, no WebGPU after all, or a Chrome too old for the runtime. Not E4B
  // to E2B: E2B may not be downloaded.
  [GEMMA_E2B_ID]: CHROME_TRANSLATOR_ID,
  [GEMMA_E4B_ID]: CHROME_TRANSLATOR_ID,
};

/**
 * What runs when an engine runs out of graphics memory while loading or warming up
 * (`OutOfMemoryError`) and no memory ladder has a smaller pair: a custom choice, or below a
 * ladder's last step. Speech recognition goes to Chrome's own (then Whisper base, its
 * `RUNTIME_FALLBACKS` entry), which use little or no graphics memory.
 */
export const MEMORY_FALLBACKS: Readonly<Record<string, string>> = {
  [QWEN3_ASR_17B_ID]: QWEN3_ASR_ID,
  [QWEN3_ASR_ID]: CHROME_WEBSPEECH_ID,
  [WHISPER_TURBO_ID]: CHROME_WEBSPEECH_ID,
  [WHISPER_BASE_ID]: CHROME_WEBSPEECH_ID,
  [GEMMA_E4B_ID]: GEMMA_E2B_ID,
  [GEMMA_E2B_ID]: CHROME_TRANSLATOR_ID,
};

/**
 * What translates when a translator's model isn't downloaded (or didn't load): the session starts
 * anyway, and the popup offers the download. E4B goes to E2B first, which may be downloaded.
 */
export const MODEL_FALLBACKS: Readonly<Record<string, string>> = {
  [GEMMA_E4B_ID]: GEMMA_E2B_ID,
  [GEMMA_E2B_ID]: CHROME_TRANSLATOR_ID,
};

/**
 * Translators that may be too slow or fail on a single line, and the one that translates such a
 * line instead (engines/translators.ts).
 */
export const LINE_FALLBACKS: Readonly<Record<string, string>> = {
  [GEMMA_E2B_ID]: CHROME_TRANSLATOR_ID,
  [GEMMA_E4B_ID]: CHROME_TRANSLATOR_ID,
};

/**
 * Last resorts when nothing a profile lists fits, in order. The demo engines are only registered
 * in e2e builds, so elsewhere these are real engines.
 */
const ASR_LAST_RESORT = [WHISPER_BASE_ID, DEMO_ASR_ID];
const TRANSLATION_LAST_RESORT = [CHROME_TRANSLATOR_ID, DEMO_TRANSLATION_ID];

export const PROFILES: Record<ProfileId, ModelProfile> = {
  // Chrome's own on-device speech and translation: nothing for Murmur to download.
  light: {
    id: 'light',
    label: 'Light',
    description: 'Small models. Runs on most laptops, including without a graphics card.',
    asr: [CHROME_WEBSPEECH_ID, WHISPER_BASE_ID],
    translation: [CHROME_TRANSLATOR_ID],
  },
  // Qwen3-ASR follows language switches best. The 1.7B makes clearly better subtitles than the
  // 0.6B at the same speed (blind judge 3.10 vs 2.79 on English subtitles), so it comes first
  // wherever graphics memory allows; the 0.6B where it doesn't (or by choice: `smallerSpeech`).
  // Turbo where neither can run (no 16-bit float shaders, or files not published in this build).
  // Gemma 4 E2B translates with the lines before; Chrome's translator where it doesn't fit.
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    description:
      'Speech recognition and a translation model on the graphics card. Better accuracy, larger download.',
    asr: [QWEN3_ASR_17B_ID, QWEN3_ASR_ID, WHISPER_TURBO_ID, WHISPER_BASE_ID],
    translation: [GEMMA_E2B_ID, CHROME_TRANSLATOR_ID],
  },
  // The larger speech and translation models, giving way to smaller ones where they don't fit
  // (`LADDERS`).
  best: {
    id: 'best',
    label: 'Best',
    description: 'The largest models: needs a graphics card with its own memory.',
    asr: [QWEN3_ASR_17B_ID, QWEN3_ASR_ID, WHISPER_TURBO_ID, WHISPER_BASE_ID],
    translation: [GEMMA_E4B_ID, GEMMA_E2B_ID, CHROME_TRANSLATOR_ID],
  },
};

export const PROFILE_ORDER: readonly ProfileId[] = ['light', 'balanced', 'best'];

/** A speech recognition engine and a translator that run together. */
export interface EnginePair {
  asr: string;
  translation: string;
}

/**
 * Memory ladders: the pairs a profile runs, largest first, each needing less graphics memory than
 * the one before. Speech recognition loads first, so a speech model that runs out of memory alone
 * skips every pair with it; a translator that runs out next to it goes one step down.
 */
export const LADDERS: Readonly<Partial<Record<ProfileId, readonly EnginePair[]>>> = {
  best: [
    { asr: QWEN3_ASR_17B_ID, translation: GEMMA_E4B_ID },
    { asr: QWEN3_ASR_17B_ID, translation: GEMMA_E2B_ID },
    { asr: QWEN3_ASR_ID, translation: GEMMA_E2B_ID },
    { asr: QWEN3_ASR_ID, translation: CHROME_TRANSLATOR_ID },
  ],
  balanced: [
    { asr: QWEN3_ASR_17B_ID, translation: GEMMA_E2B_ID },
    { asr: QWEN3_ASR_ID, translation: GEMMA_E2B_ID },
    { asr: QWEN3_ASR_ID, translation: CHROME_TRANSLATOR_ID },
  ],
};

/**
 * Translators a ladder doesn't start with where the graphics share the computer's memory
 * (`sharesMemory`: Apple silicon, integrated graphics), though they may fit: on a MacBook Air M2
 * (16 GB) Gemma 4 E4B fit beside Qwen3-ASR 1.7B (6.2 GB) but put translations 4.8 s behind the
 * speech (median; E2B 1.9 s) and missed the 3 s budget on 15 of 63 lines. The person can still
 * choose it (a record at the top step: "Try the larger models"); faster graphics of that kind
 * (M-series Pro and Max) may run it well, and a session that keeps falling behind steps down by
 * itself (`slowness.ts`).
 */
export const SLOW_ON_SHARED_MEMORY: ReadonlySet<string> = new Set([GEMMA_E4B_ID]);

/**
 * Below a ladder's last step (it ran out of memory there too): what Light runs, Chrome's own
 * speech recognition (else Whisper base) and translation.
 */
const BELOW_LADDER: EnginePair = { asr: CHROME_WEBSPEECH_ID, translation: CHROME_TRANSLATOR_ID };

/** A ladder step as it runs on this device. */
export interface LadderStep extends EnginePair {
  /** Its position in `LADDERS[profile]` (what the per-device record keeps). */
  index: number;
}

export interface ResolvedLadder {
  profile: ProfileId;
  /**
   * The engines of every step as they run here (`ladderId`): a device's record (settings/
   * memoryfit.ts) applies only to the ladder it was made on.
   */
  id: string;
  /**
   * Every step of the profile's ladder as it runs here: an engine that can't run here for another
   * reason than memory (not in this build, no 16-bit float shaders) is replaced by the next one in
   * the profile's list, as without a ladder.
   */
  steps: LadderStep[];
  /** The step a session starts at; `steps.length` when below the last one. */
  start: number;
  /** The step the graphics-memory guess alone picks. */
  estimated: number;
  /** The guess, MB (`estimateGpuMemoryMB`). */
  estimateMB: number;
  /**
   * Why it doesn't start at the top: the graphics-memory guess (`estimate`); larger models ran
   * out of memory on this device before (`record`) or kept falling behind here (`slow`); the
   * graphics share the computer's memory, where the largest translator is too slow
   * (`speed`, `SLOW_ON_SHARED_MEMORY`); or the person chose the smaller speech model
   * (`smaller`). Null at the top.
   */
  reason: LadderReason | null;
}

export type LadderReason = 'estimate' | 'record' | 'slow' | 'speed' | 'smaller';

/** Why a device's record moved a ladder down (settings/memoryfit.ts). */
export type FitCause = 'memory' | 'slow';

/**
 * How long a step down for slowness holds: after this long without falling behind again, the
 * session tries one step up, then another after as long again. Running out of memory holds.
 */
export const SLOW_FIT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A ladder's identity: the engines each step runs here, in order. A record made on another
 * ladder (the engines changed in an update, a model became available) doesn't apply.
 */
export function ladderId(steps: readonly EnginePair[]): string {
  return steps.map((step) => `${step.asr}+${step.translation}`).join('>');
}

export interface ResolvedEngines {
  asr: string;
  translation: string;
  /** Plain notes on any fallback ("X needs WebGPU; using Y."). */
  notes: string[];
  /** Balanced and Best: the memory ladder and where on it this device starts. */
  ladder?: ResolvedLadder;
}

export interface ResolveOptions {
  /**
   * This device's record for the profile (settings/memoryfit.ts): the step that last worked, and
   * why the session stepped down to it (none: the person chose it).
   */
  fit?: { step: number; cause?: FitCause; at?: number; ladder?: string } | null;
  /** Now, epoch ms (tests); for how long a step down for slowness holds. */
  now?: number;
  /** Balanced with the smaller speech model (Qwen3-ASR 0.6B): a smaller download. */
  smallerSpeech?: boolean;
}

/** Picks the engines to run for `choice` on this device. */
export function resolveEngines(
  choice: ProfileChoice,
  custom: { asr: string; translation: string },
  registry: EngineRegistry,
  hardware: HardwareInfo,
  options: ResolveOptions = {},
): ResolvedEngines {
  const notes: string[] = [];
  const asrInfo = (id: string) => registry.asrInfo(id);
  const mtInfo = (id: string) => registry.translationInfo(id);
  const asrLast = lastResort(ASR_LAST_RESORT, asrInfo);
  const mtLast = lastResort(TRANSLATION_LAST_RESORT, mtInfo);
  const ladder = choice === 'custom' ? undefined : LADDERS[choice];
  if (choice !== 'custom' && ladder) {
    const profile = PROFILES[choice];
    const tried = new Map<string, string | null>();
    const usable = (id: string, list: readonly string[], info: Info, last: string) =>
      pick(from(id, list), info, last, hardware, notes, false, tried);
    const steps = ladder.map((pair, index) => ({
      index,
      asr: usable(pair.asr, profile.asr, asrInfo, asrLast),
      translation: usable(pair.translation, profile.translation, mtInfo, mtLast),
    }));
    const estimateMB = estimateGpuMemoryMB(hardware);
    const fits = steps.findIndex((step) => pairMemoryMB(step, registry) <= estimateMB);
    const estimated = fits >= 0 ? fits : steps.length - 1;
    const smallest =
      options.smallerSpeech && choice === 'balanced'
        ? ladder.findIndex((pair) => pair.asr !== QWEN3_ASR_17B_ID)
        : 0;
    const id = ladderId(steps);
    // Graphics that share the computer's memory start below the translators too slow there.
    const fast = sharesMemory(hardware.webgpu)
      ? Math.max(
          0,
          steps.findIndex((step) => !SLOW_ON_SHARED_MEMORY.has(step.translation)),
        )
      : 0;
    const guessed = Math.max(estimated, fast);
    let recorded = recordedStep(options.fit ?? null, id, steps.length, options.now ?? Date.now());
    // A step down for slowness that has moved back up to the guess is over.
    if (options.fit?.cause === 'slow' && recorded !== null && recorded <= guessed) recorded = null;
    const start = Math.max(recorded ?? guessed, smallest);
    const top = steps[0];
    const chosen = steps[start];
    // Nothing smaller runs when the step it starts at runs the top's engines here.
    const same = !!chosen && chosen.asr === top?.asr && chosen.translation === top.translation;
    const reason: ResolvedLadder['reason'] =
      start === 0 || same
        ? null
        : start === smallest && options.smallerSpeech
          ? 'smaller'
          : start === recorded
            ? options.fit?.cause === 'slow'
              ? 'slow'
              : 'record'
            : start === fast && fast > estimated
              ? 'speed'
              : 'estimate';
    if (reason === 'estimate') {
      notes.push(
        `Smaller models, to fit this device’s graphics memory (about ${formatGB(estimateMB)}, a guess: browsers don’t report it).`,
      );
    } else if (reason === 'record') {
      notes.push('Smaller models: larger ones ran out of graphics memory on this device.');
    } else if (reason === 'slow') {
      notes.push('Smaller models: larger ones fell behind the speech on this device.');
    } else if (reason === 'speed') {
      notes.push(
        'Smaller models: the largest translation model is too slow for live subtitles on graphics that share the computer’s memory.',
      );
    }
    const resolved = { profile: choice, id, steps, start, estimated, estimateMB, reason };
    const step = steps[start];
    if (step) return { asr: step.asr, translation: step.translation, notes, ladder: resolved };
    return {
      asr: pick(from(BELOW_LADDER.asr, PROFILES.light.asr), asrInfo, asrLast, hardware, notes),
      translation: pick([BELOW_LADDER.translation], mtInfo, mtLast, hardware, notes),
      notes,
      ladder: resolved,
    };
  }
  const asrCandidates = choice === 'custom' ? [custom.asr] : PROFILES[choice].asr;
  const mtCandidates = choice === 'custom' ? [custom.translation] : PROFILES[choice].translation;
  const asr = pick(asrCandidates, asrInfo, asrLast, hardware, notes);
  const translation = pick(mtCandidates, mtInfo, mtLast, hardware, notes);
  return { asr, translation, notes };
}

type Info = (id: string) => EngineInfo | undefined;

/**
 * The step a device's record starts a ladder of `length` steps at, or null when it has none
 * that applies: one made on another ladder (`id`) doesn't. A step down for slowness never goes
 * below the last step (only running out of memory leaves the ladder), and moves one step back
 * up for each `SLOW_FIT_MS` since it was made.
 */
function recordedStep(
  fit: ResolveOptions['fit'] | null,
  id: string,
  length: number,
  now: number,
): number | null {
  if (!fit) return null;
  if (fit.ladder !== undefined && fit.ladder !== id) return null;
  const step = Math.min(Math.max(0, fit.step), length);
  if (fit.cause !== 'slow') return step;
  const age = Math.max(0, now - (fit.at ?? now));
  return Math.max(0, Math.min(step, length - 1) - Math.floor(age / SLOW_FIT_MS));
}

/** `list` from `id` on (just `id` when it isn't in the list). */
function from(id: string, list: readonly string[]): readonly string[] {
  const at = list.indexOf(id);
  return at >= 0 ? list.slice(at) : [id];
}

/** Graphics memory a pair needs together, MB: both engines' own peaks. */
export function pairMemoryMB(pair: EnginePair, registry: EngineRegistry): number {
  return (
    (registry.asrInfo(pair.asr)?.requirements.minGpuMemoryMB ?? 0) +
    (registry.translationInfo(pair.translation)?.requirements.minGpuMemoryMB ?? 0)
  );
}

/**
 * The steps a session goes down, from where it starts: consecutive steps that run the same
 * engines here are one. Empty below the last step.
 */
export function ladderFromStart(ladder: ResolvedLadder): LadderStep[] {
  const out: LadderStep[] = [];
  for (const step of ladder.steps.slice(ladder.start)) {
    const last = out.at(-1);
    if (last && last.asr === step.asr && last.translation === step.translation) continue;
    out.push(step);
  }
  return out;
}

function lastResort(ids: readonly string[], info: (id: string) => EngineInfo | undefined): string {
  return ids.find((id) => info(id)) ?? (ids[0] as string);
}

function pick(
  candidates: readonly string[],
  info: (id: string) => EngineInfo | undefined,
  fallback: string,
  hardware: HardwareInfo,
  notes: string[],
  memory = true,
  /** Checks already made (ladders check the same engines for several steps), with their note. */
  seen?: Map<string, string | null>,
): string {
  for (const id of candidates) {
    let note = seen?.get(id);
    if (note === undefined) {
      const engine = info(id);
      const check = engine ? checkEngine(engine, hardware, { memory }) : null;
      note = !engine
        ? `${id} isn't available in this build.`
        : check && !check.ok
          ? `${engine.label}: ${check.reasons.join(' ')}`
          : null;
      seen?.set(id, note);
      if (note) notes.push(note);
    }
    if (note === null) return id;
  }
  return fallback;
}

/** Graphics memory Best's largest pair needs (Qwen3-ASR 1.7B with Gemma 4 E4B), MB. */
const BEST_TOP_MB =
  (QWEN3_ASR_17B_INFO.requirements.minGpuMemoryMB ?? 0) +
  (GEMMA_E4B_INFO.requirements.minGpuMemoryMB ?? 0);

/** The profile to suggest for this device. */
export function recommendProfile(hw: HardwareInfo): ProfileId {
  if (hw.companion) return 'best';
  if (!hw.webgpu.available) return 'light';
  const memory = hw.deviceMemoryGB ?? 4;
  // Best's models want a card with its own memory, enough for its largest pair.
  if (
    hw.webgpu.shaderF16 &&
    memory >= 8 &&
    hw.webgpu.maxBufferMB >= 1024 &&
    gpuKind(hw.webgpu) === 'discrete' &&
    estimateGpuMemoryMB(hw) >= BEST_TOP_MB
  ) {
    return 'best';
  }
  return 'balanced';
}
