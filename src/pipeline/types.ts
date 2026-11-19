/**
 * What the pipeline hands the overlay: one cue per speech segment, re-sent whenever any part of it
 * changes (a longer partial, the final text, more of the translation). The overlay keys cues by
 * `id` and replaces in place.
 */
import type { LanguageTag } from '@/engines/types';

export interface CueText {
  text: string;
  language: LanguageTag;
  /** False while the engine may still change it (the overlay dims it). */
  final: boolean;
}

export interface Cue {
  /** The segment id; stable across updates. */
  id: string;
  /** Order of the segment in the session. */
  seq: number;
  /** When the speech is heard, epoch ms (see capture/clock.ts). */
  startEpochMs: number;
  endEpochMs: number;
  /** What was said, in the language it was said in (per segment, never per stream). */
  source: CueText;
  /**
   * The translation, or `null` when there is none yet or none is needed (`untranslated` says
   * which).
   */
  translation: CueText | null;
  /** Why there's no translation: `same-language` (already in the target), `pending`, `failed`. */
  untranslated: 'same-language' | 'pending' | 'failed' | null;
}
