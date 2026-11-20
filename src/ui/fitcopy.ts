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
 * Why a profile starts below its largest models on this device, and the button that tries the
 * larger ones (`action`, its label); null when it runs its largest (or the person chose the
 * smaller speech model).
 */
export function memoryFitCopy(
  engines: ResolvedEngines,
  registry: EngineRegistry,
): { text: string; retry: boolean; action: string } | null {
  const ladder = engines.ladder;
  if (!ladder || ladder.reason === null || ladder.reason === 'smaller') return null;
  const names = engineNames(engines, registry);
  const retry = { retry: true, action: 'Try the larger models' };
  switch (ladder.reason) {
    case 'estimate':
    case 'record': {
      const why =
        ladder.reason === 'record'
          ? 'Larger ones ran out of graphics memory here.'
          : 'Browsers don’t report graphics memory, so this is Murmur’s guess.';
      return {
        text: `Using smaller models to fit this device’s graphics memory: ${names}. ${why}`,
        ...retry,
      };
    }
    case 'slow':
      return {
        text: `Using smaller models: ${names}. Larger ones fell behind the speech here.`,
        ...retry,
      };
    case 'speed': {
      const top = ladder.steps[0]?.translation ?? '';
      const label = registry.translationInfo(top)?.label ?? top;
      return {
        text: `Using ${names}. ${label} translates a little better, but on graphics that share the computer’s memory, like Apple silicon, it is too slow for live subtitles: about 5 s behind the speech on a MacBook Air M2, with a quarter of the lines too late. Faster chips may keep up; if it falls behind, Murmur goes back to smaller models.`,
        retry: true,
        action: `Use ${label} anyway`,
      };
    }
  }
}

/**
 * The computer's memory as the browser reports it (rounded to a power of two): "About 16 GB", or
 * "8 GB or more" where an older Chrome may have capped it at 8.
 */
export function memoryText(deviceMemoryGB: number | null): string {
  if (deviceMemoryGB === null) return 'Unknown';
  return deviceMemoryGB === 8 ? '8\u00a0GB or more' : `About ${deviceMemoryGB}\u00a0GB`;
}
