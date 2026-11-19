/**
 * The pipeline: captured frames → segmenter → ASR session → translation → cues.
 *
 * - Every segment gets its own language from the ASR result (or the hint, or `und`), and is
 *   translated or not on that basis alone: a stream may switch languages at any segment.
 * - Final source lines are translated one at a time, in order, with the last few finished lines as
 *   context. Partial lines are only translated when `translatePartials` is on (a preview that the
 *   final replaces); a newer partial aborts the previous preview.
 * - Each change to a segment re-emits its whole cue; the overlay replaces by id.
 * - Engines that listen to the live track (`audioInput: 'track'`) get the track, and the
 *   segment calls only as pause markers (no audio): their segments run longer before a forced
 *   cut, since cutting a recognizer mid-sentence costs words.
 * - A translation engine may correct a line's language (it checked the text) and may revise an
 *   earlier line's translation (`TranslationChunk.revises`).
 */
import { SampleClock } from '@/capture/clock';
import { type AudioFrame, PIPELINE_SAMPLE_RATE } from '@/capture/types';
import type {
  AsrEngine,
  AsrHealth,
  AsrResult,
  AsrSession,
  LanguageTag,
  TranslationEngine,
} from '@/engines/types';
import { UNKNOWN_LANGUAGE } from '@/engines/types';
import { sameLanguage } from './language';
import { type SegmentEvent, Segmenter } from './segmenter';
import type { Cue } from './types';
import { EnergyVad } from './vad';

export interface PipelineOptions {
  asr: AsrEngine;
  translator: TranslationEngine;
  targetLanguage: LanguageTag;
  /** Language to suggest to the ASR engine, or `null` to detect per segment. */
  sourceLanguage: LanguageTag | null;
  translatePartials?: boolean;
  /** Defaults to an energy-gated segmenter. */
  segmenter?: Segmenter;
  /** Earlier final lines passed as translation context. Default 3. */
  contextLines?: number;
  /** Languages the person expects to hear (empty: not said). */
  spokenLanguages?: readonly LanguageTag[];
  /** Nothing but `spokenLanguages` is spoken. */
  onlySpoken?: boolean;
  /** The captured audio as a live track, for engines that listen to it. */
  track?: MediaStreamTrack | null;
  onCue(cue: Cue): void;
  onError(error: Error): void;
  /** How the speech engine is keeping up. */
  onHealth?(health: AsrHealth): void;
}

interface SegmentState {
  cue: Cue;
  /** Aborts the running partial-translation preview. */
  preview: AbortController | null;
}

export class Pipeline {
  private readonly clock = new SampleClock(PIPELINE_SAMPLE_RATE);
  private readonly segmenter: Segmenter;
  private readonly session: AsrSession;
  private readonly segments = new Map<string, SegmentState>();
  private readonly context: { source: string; translation: string; language: LanguageTag }[] = [];
  /** The ASR engine listens to the track; segments are only pause markers for it. */
  private readonly ownSegments: boolean;
  /** End of the audio pushed so far. */
  private position = 0;
  private readonly closing = new AbortController();
  private finals: Promise<void> = Promise.resolve();
  private seq = 0;

  constructor(private readonly options: PipelineOptions) {
    this.ownSegments = options.asr.info.audioInput === 'track';
    this.segmenter =
      options.segmenter ??
      new Segmenter(new EnergyVad(), this.ownSegments ? { maxSegmentMs: 20_000 } : {});
    this.session = options.asr.createSession({
      sampleRate: PIPELINE_SAMPLE_RATE,
      languageHint: options.sourceLanguage,
      spokenLanguages: options.spokenLanguages ?? [],
      onlySpoken: options.onlySpoken ?? false,
      track: options.track ?? null,
      currentSample: () => this.position,
      onResult: (result) => this.onAsrResult(result),
      onError: (error) => options.onError(error),
      ...(options.onHealth ? { onHealth: options.onHealth } : {}),
    });
  }

  /** Feeds one captured frame. Frames must arrive in order. */
  push(frame: AudioFrame): void {
    if (this.closing.signal.aborted) return;
    this.clock.anchor(frame.startSample, frame.startEpochMs);
    this.position = frame.startSample + frame.samples.length;
    this.dispatch(this.segmenter.push(frame.samples, frame.startSample));
  }

  /** Ends the open segment now (capture paused, video seeked). */
  flush(): void {
    this.dispatch(this.segmenter.flush());
  }

  /** Ends the open segment, waits for queued final translations, then closes the ASR session. */
  async close(): Promise<void> {
    this.flush();
    await this.finals;
    this.closing.abort();
    for (const s of this.segments.values()) s.preview?.abort();
    await this.session.close();
  }

  private dispatch(events: SegmentEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'start':
          this.segmentState(event.segmentId, event.startSample, event.startSample);
          this.session.startSegment(event.segmentId, event.startSample);
          break;
        case 'audio':
          if (!this.ownSegments) {
            this.session.pushAudio(event.segmentId, event.samples, event.startSample);
          }
          break;
        case 'end':
          this.session.endSegment(event.segmentId, event.endSample);
          break;
      }
    }
  }

  private segmentState(id: string, startSample: number, endSample: number): SegmentState {
    let state = this.segments.get(id);
    if (!state) {
      state = {
        cue: {
          id,
          seq: ++this.seq,
          startEpochMs: this.clock.toEpochMs(startSample),
          endEpochMs: this.clock.toEpochMs(endSample),
          source: { text: '', language: UNKNOWN_LANGUAGE, final: false },
          translation: null,
          untranslated: 'pending',
        },
        preview: null,
      };
      this.segments.set(id, state);
      this.prune();
    }
    return state;
  }

  private onAsrResult(result: AsrResult): void {
    if (this.closing.signal.aborted) return;
    const state = this.segmentState(result.segmentId, result.startSample, result.endSample);
    const { cue } = state;
    const language = result.language?.tag ?? this.options.sourceLanguage ?? UNKNOWN_LANGUAGE;
    cue.startEpochMs = this.clock.toEpochMs(result.startSample);
    cue.endEpochMs = this.clock.toEpochMs(result.endSample);
    cue.source = { text: result.text, language, final: result.final };

    if (sameLanguage(language, this.options.targetLanguage)) {
      state.preview?.abort();
      cue.translation = null;
      cue.untranslated = 'same-language';
      this.emit(cue);
      return;
    }

    cue.untranslated = 'pending';
    if (cue.translation) cue.translation = { ...cue.translation, final: false };
    this.emit(cue);

    if (result.final) {
      state.preview?.abort();
      if (result.text.trim() === '') return;
      const text = result.text;
      this.finals = this.finals.then(() => this.translate(state, text, language, true));
    } else if (this.options.translatePartials && result.text.trim() !== '') {
      state.preview?.abort();
      state.preview = new AbortController();
      void this.translate(state, result.text, language, false, state.preview.signal);
    }
  }

  private async translate(
    state: SegmentState,
    text: string,
    language: LanguageTag,
    final: boolean,
    signal: AbortSignal = this.closing.signal,
  ): Promise<void> {
    const { cue } = state;
    const target = this.options.targetLanguage;
    const lines = this.options.contextLines ?? 3;
    try {
      const stream = this.options.translator.translate({
        segmentId: cue.id,
        source: { kind: 'text', text, language },
        target,
        sourceFinal: final,
        context: this.context.slice(-lines),
        signal,
      });
      for await (const chunk of stream) {
        if (signal.aborted) return;
        if (chunk.revises) {
          this.revise(chunk.revises.segmentId, chunk.text);
          continue;
        }
        // A preview never overwrites a finished translation.
        if (!final && cue.translation?.final) return;
        if (chunk.sourceLanguage && cue.source.final === final) {
          // The engine checked the text: its language wins.
          cue.source = { ...cue.source, language: chunk.sourceLanguage };
          if (sameLanguage(chunk.sourceLanguage, target)) {
            cue.translation = null;
            cue.untranslated = 'same-language';
            this.emit(cue);
            return;
          }
        }
        cue.translation = { text: chunk.text, language: target, final: final && chunk.final };
        if (cue.translation.final) cue.untranslated = null;
        this.emit(cue);
      }
      if (final && cue.translation?.final) {
        this.context.push({
          source: text,
          translation: cue.translation.text,
          language: cue.source.language,
        });
        if (this.context.length > lines) this.context.shift();
      }
    } catch (err) {
      if (signal.aborted || !final) return;
      cue.untranslated = 'failed';
      this.emit(cue);
      this.options.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** A better translation of an earlier line. */
  private revise(segmentId: string, text: string): void {
    const state = this.segments.get(segmentId);
    if (!state?.cue.translation) return;
    const before = state.cue.translation.text;
    state.cue.translation = { ...state.cue.translation, text, final: true };
    const ctx = this.context.find((c) => c.translation === before);
    if (ctx) ctx.translation = text;
    this.emit(state.cue);
  }

  private emit(cue: Cue): void {
    this.options.onCue(structuredClone(cue));
  }

  /** Keep only recent segments; old ones can't change any more. */
  private prune(): void {
    const max = 64;
    if (this.segments.size <= max) return;
    for (const id of this.segments.keys()) {
      if (this.segments.size <= max) break;
      this.segments.delete(id);
    }
  }
}
