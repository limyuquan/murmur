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

/**
 * Where a cue came from. `live`: heard through the tab capture, timed in epoch ms. `lookahead`:
 * made from audio the page's player had buffered ahead of the playhead, timed on the video's own
 * timeline (`media`), so it can be shown exactly when that moment plays.
 */
export type CueOrigin = 'live' | 'lookahead';

/** A cue's place on a video's timeline. */
export interface CueMediaTime {
  /** Which video timeline (one MediaSource or source URL, or a site's id for the content). */
  timeline: string;
  /** Media time, seconds (`video.currentTime` scale). */
  start: number;
  end: number;
}

export interface Cue {
  /** The segment id; stable across updates. */
  id: string;
  /**
   * Order of the segment in the session. A later line of a split segment comes right after its
   * segment, with a fractional number (`3.5` after `3`).
   */
  seq: number;
  /**
   * When the speech is heard, epoch ms (see capture/clock.ts). 0 for lookahead cues: they are
   * made before anyone hears them (`media` places them).
   */
  startEpochMs: number;
  endEpochMs: number;
  /** Absent: `live`. */
  origin?: CueOrigin;
  /** On the video's timeline: lookahead cues always; live cues once the overlay maps them. */
  media?: CueMediaTime;
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
