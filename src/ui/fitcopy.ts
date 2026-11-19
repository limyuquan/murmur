/**
 * What the options and welcome pages say about model sizes and graphics memory, pure: which
 * engines a profile runs here, the smaller speech model choice, and why smaller models run.
 */
import { QWEN3_ASR_17B_ID, QWEN3_ASR_ID, type ResolvedEngines } from '@/engines/profiles';
import type { EngineRegistry } from '@/engines/registry';
import { formatSize } from '@/models/types';

/** "Qwen3-ASR 1.7B and Gemma 4 E2B". */
export function engineNames(engines: ResolvedEngines, registry: EngineRegistry): string {
  const asr = registry.asrInfo(engines.asr)?.label ?? engines.asr;
  const mt = registry.translationInfo(engines.translation)?.label ?? engines.translation;
  return `${asr} and ${mt}`;
}

/**
 * The smaller speech model choice (Balanced), with both sizes, or null where this build can't
 * run the larger one anyway (its files aren't published).
 */
export function smallerSpeechCopy(
  registry: EngineRegistry,
): { label: string; hint: string } | null {
  const large = registry.asrInfo(QWEN3_ASR_17B_ID);
  const small = registry.asrInfo(QWEN3_ASR_ID);
  if (!large || !small || large.unavailable || small.unavailable) return null;
  const size = (mb: number | undefined) => formatSize(mb ?? 0);
  return {
    label: `Use the smaller speech model (${size(small.requirements.downloadMB)})`,
    hint: `${small.label} instead of ${large.label} (${size(large.requirements.downloadMB)}): a smaller download, a few more mistakes.`,
  };
}

/**
 * Why a profile starts below its largest models on this device, and whether to offer trying the
 * larger ones; null when it runs its largest (or the person chose the smaller speech model).
 */
export function memoryFitCopy(
  engines: ResolvedEngines,
  registry: EngineRegistry,
): { text: string; retry: boolean } | null {
  const ladder = engines.ladder;
  if (!ladder || (ladder.reason !== 'estimate' && ladder.reason !== 'record')) return null;
  const names = engineNames(engines, registry);
  const why =
    ladder.reason === 'record'
      ? 'Larger ones ran out of graphics memory here.'
      : 'Browsers don’t report graphics memory, so this is Murmur’s guess.';
  return {
    text: `Using smaller models to fit this device’s graphics memory: ${names}. ${why}`,
    retry: true,
  };
}
