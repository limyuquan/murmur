/**
 * The pipeline: captured frames → segmenter → ASR session → translation → cues.
 *
 * - Every segment gets its own language from the ASR result (or the hint, or `und`), and is
 *   translated or not on that basis and its text: a stream may switch languages at any segment,
 *   and a line heard as the target language is still translated when a meaningful part of it is
 *   in another language (mixed.ts: by script at once, by `detectLanguages` for finished lines in
 *   the target's own script).
 * - Final source lines are translated one at a time, in order, with the last few finished lines as
 *   context. Partial lines are only translated when `translatePartials` is on (a preview that the
 *   final replaces); a newer partial aborts the previous preview.
 * - Each change to a segment re-emits its whole cue; the overlay replaces by id.
 * - Speech: a model detector (`vad`, Silero) scores the stream ahead of the segmenter
 *   (vadstage.ts); without one, or for engines that listen to the track, the energy gate does.
 * - Segments: the segmenter's sentence strategy by default. At a short pause it asks the ASR
 *   session for the text so far (`requestPartial`); the partial that answers goes back to the
 *   segmenter (`transcript`), which ends the segment there if the text ends a sentence. The
 *   segmenter knows nothing of engines, and engines nothing of sentences.
 * - Engines that listen to the live track (`audioInput: 'track'`) get the track, and the
 *   segment calls only as pause markers (no audio): they get the pause strategy, with segments
 *   that run longer before a forced cut, since cutting a recognizer mid-sentence costs words.
 * - A translation engine may correct a line's language (it checked the text) and may revise an
 *   earlier line's translation (`TranslationChunk.revises`). Engines with `revises` are offered
 *   the line before (`previous`) when the new line ends a sentence that line left open, while
 *   it is still on screen, once per line; the rest of the stream is read in the background, so
 *   the next line doesn't wait for the revision.
 */
import { SampleClock } from '@/capture/clock';
import { type AudioFrame, PIPELINE_SAMPLE_RATE } from '@/capture/types';
import { LINE_BUDGET_MS, lookaheadBudgetMs } from '@/engines/translators';
import type {
  AsrEngine,
  AsrHealth,
  AsrResult,
  AsrSession,
  LanguageTag,
  TranslationChunk,
  TranslationEngine,
  TranslationRequest,
} from '@/engines/types';
import { UNKNOWN_LANGUAGE } from '@/engines/types';
import { LINGER_MS } from '@/overlay/captions';
import { readingMs } from '@/overlay/linebreak';
import { sameLanguage } from './language';
import { type DetectLanguages, detectForeign, foreignPart } from './mixed';
import { type SegmentEvent, Segmenter, type SegmenterOptions } from './segmenter';
import { isSentenceEnd } from './sentence';
import type { Cue } from './types';
import { type AsyncVoiceActivityDetector, EnergyVad } from './vad';
import { VadStage } from './vadstage';

export interface PipelineOptions {
  asr: AsrEngine;
  translator: TranslationEngine;
  targetLanguage: LanguageTag;
  /** Language to suggest to the ASR engine, or `null` to detect per segment. */
  sourceLanguage: LanguageTag | null;
  translatePartials?: boolean;
  /**
   * The speech detector for engines that take segments (Silero). Without one the energy gate
   * decides; engines that listen to the track always get the energy gate.
   */
  vad?: AsyncVoiceActivityDetector | null;
  /** Told once if `vad` fails while running (the energy gate takes over). */
  onVadFailure?(error: Error): void;
  /**
   * Defaults to the sentence segmenter (`MODEL_VAD_SEGMENTER` over it with a `vad`), or
   * `TRACK_SEGMENTER` for track engines. With a `vad`, its frames must be the vad's size.
   */
  segmenter?: Segmenter;
  /** Earlier final lines passed as translation context. Default 6 (what prompt v3 was tuned with). */
  contextLines?: number;
  /** Languages the person expects to hear (empty: not said). */
  spokenLanguages?: readonly LanguageTag[];
  /** Nothing but `spokenLanguages` is spoken. */
  onlySpoken?: boolean;
  /**
   * Ranks a text's likely languages (Chrome's `LanguageDetector`, when ready). Finds another
   * language in a finished line heard as the target language and written in its script.
   */
  detectLanguages?: DetectLanguages | null;
  /** The captured audio as a live track, for engines that listen to it. */
  track?: MediaStreamTrack | null;
  onCue(cue: Cue): void;
  onError(error: Error): void;
  /** How the speech engine is keeping up. */
  onHealth?(health: AsrHealth): void;
  /** Sees each segment start and end (e2e builds log them, with why each ended). */
  onSegment?(event: Extract<SegmentEvent, { type: 'start' | 'end' }>): void;
  /** The time, ms (tests replace it). Default `Date.now`. */
  now?: () => number;
  /**
   * Longest a final line's translation may take before it is given up (marked failed), so one
   * that hangs doesn't hold up every later line. Default `TRANSLATION_TIMEOUT_MS`.
   */
  translationTimeoutMs?: number;
  /**
   * Lookahead: the frames are a video's own audio, decoded ahead of the playhead, with sample
   * indices on its timeline (sample = media seconds × 16 000). Cues are timed in media time
   * (`Cue.media`), their ids start with `idPrefix`, and the ASR session runs in batch mode.
   */
  media?: { timeline: string; idPrefix: string };
  /**
   * Lookahead: how long until the moment at `start` (media seconds) is shown, ms (Infinity while
   * paused). A finished line may take until shortly before then to translate
   * (`lookaheadBudgetMs`) instead of a live line's budget.
   */
  untilShownMs?(start: number): number;
}

export const TRANSLATION_TIMEOUT_MS = 10_000;
/** Past a line's translation budget, what its backup gets before the line is given up, ms. */
const BACKUP_SLACK_MS = TRANSLATION_TIMEOUT_MS - LINE_BUDGET_MS;

/** Segments for engines that listen to the track: pauses only, cut late. */
export const TRACK_SEGMENTER: SegmenterOptions = { strategy: 'pause', maxSegmentMs: 20_000 };

/**
 * With a model detector, a segment opens on one frame at the threshold, as in the benchmark: the
 * model's probabilities are already smooth, and a blip under 250 ms of speech is still dropped.
 */
export const MODEL_VAD_SEGMENTER: SegmenterOptions = { minSpeechMs: 32 };

/**
 * Audio made ahead of time (lookahead) has its future at hand: a segment at its maximum is cut
 * at the best gap up to this far past it (segmenter.ts `cutAheadMs`), not only before it.
 */
export const LOOKAHEAD_CUT_AHEAD_MS = 1500;

/** A later line of a split segment: `<parent>.<n>`. */
const SPLIT_LINE = /^(.+)\.(\d+)$/;

interface SegmentState {
  cue: Cue;
  /** Aborts the running partial-translation preview. */
  preview: AbortController | null;
  /** The languages its text mixes, when it is heard as the target language but partly isn't. */
  mixed: readonly LanguageTag[] | null;
  /** When its translation was finished (`now()`), or null. */
  translatedAt: number | null;
}

/** The last finished line, which the next one may finish the sentence of. */
interface LastLine {
  state: SegmentState;
  source: string;
  language: LanguageTag;
  /** Already sent for a revision (once per line). */
  revised: boolean;
}

export class Pipeline {
  private readonly clock = new SampleClock(PIPELINE_SAMPLE_RATE);
  private readonly segmenter: Segmenter;
  /** Scores the stream with the model detector, when there is one. */
  private readonly vadStage: VadStage | null;
  private readonly session: AsrSession;
  private readonly segments = new Map<string, SegmentState>();
  private readonly context: { source: string; translation: string; language: LanguageTag }[] = [];
  /** The ASR engine listens to the track; segments are only pause markers for it. */
  private readonly ownSegments: boolean;
  /** End of the audio pushed so far. */
  private position = 0;
  private readonly closing = new AbortController();
  private finals: Promise<void> = Promise.resolve();
  private lastLine: LastLine | null = null;
  private readonly now: () => number;
  private seq = 0;
  /** End of the audio the segmenter has seen (after the speech detector, if any). */
  private scanned = 0;

  constructor(private readonly options: PipelineOptions) {
    this.now = options.now ?? Date.now;
    this.ownSegments = options.asr.info.audioInput === 'track';
    const model = this.ownSegments ? null : (options.vad ?? null);
    if (model) {
      // The segmenter's own detector only sets the frame size: the stage scores every frame.
      this.segmenter =
        options.segmenter ??
        new Segmenter(new EnergyVad({ frameSamples: model.frameSamples }), {
          ...MODEL_VAD_SEGMENTER,
          ...(options.media ? { cutAheadMs: LOOKAHEAD_CUT_AHEAD_MS } : {}),
        });
      this.vadStage = new VadStage(
        model,
        (samples, startSample, prob) => {
          if (this.closing.signal.aborted) return;
          this.scanned = startSample + samples.length;
          this.dispatch(this.segmenter.pushScored(samples, startSample, prob));
        },
        (error) => options.onVadFailure?.(error),
      );
    } else {
      this.segmenter =
        options.segmenter ??
        new Segmenter(
          new EnergyVad(),
          this.ownSegments
            ? TRACK_SEGMENTER
            : options.media
              ? { cutAheadMs: LOOKAHEAD_CUT_AHEAD_MS }
              : {},
        );
      this.vadStage = null;
    }
    this.session = options.asr.createSession({
      sampleRate: PIPELINE_SAMPLE_RATE,
      languageHint: options.sourceLanguage,
      spokenLanguages: options.spokenLanguages ?? [],
      onlySpoken: options.onlySpoken ?? false,
      track: options.track ?? null,
      currentSample: () => this.position,
      ...(options.media ? { batch: true } : {}),
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
    if (this.vadStage) this.vadStage.push(frame.samples, frame.startSample);
    else {
      this.dispatch(this.segmenter.push(frame.samples, frame.startSample));
      this.scanned = this.position;
    }
  }

  /** End of the audio the segmenter has seen (frames still being scored aren't counted). */
  get scannedSample(): number {
    return this.scanned;
  }

  /**
   * Ends the open segment now (capture paused, video seeked). With a model detector, once the
   * frames already pushed are scored.
   */
  flush(): void {
    if (!this.vadStage) {
      this.dispatch(this.segmenter.flush());
      return;
    }
    this.vadStage.after(() => this.dispatch(this.segmenter.flush()));
    this.vadStage.reset();
  }

  /**
   * Stops at once: nothing more is emitted, open segments and queued translations are dropped.
   * Resolves once the speech detector has let go of the frames it was scoring (so another
   * pipeline may use it) and the ASR session is closed.
   */
  async abort(): Promise<void> {
    this.closing.abort();
    for (const s of this.segments.values()) s.preview?.abort();
    this.vadStage?.reset();
    await Promise.all([
      this.vadStage?.drain(),
      // Queued decodes are dropped, not run: nobody will see them.
      this.session.abort ? this.session.abort() : this.session.close(),
    ]);
  }

  /** Ends the open segment, waits for queued final translations, then closes the ASR session. */
  async close(): Promise<void> {
    this.flush();
    await this.vadStage?.drain();
    await this.finals;
    // Revisions still under way are dropped: the lines they would change are gone.
    this.closing.abort();
    for (const s of this.segments.values()) s.preview?.abort();
    await this.session.close();
  }

  private dispatch(events: SegmentEvent[]): void {
    for (const event of events) {
      if (event.type === 'start' || event.type === 'end') this.options.onSegment?.(event);
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
        case 'probe':
          this.session.requestPartial?.(event.segmentId, event.endSample);
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
          seq: this.seqFor(id),
          startEpochMs: 0,
          endEpochMs: 0,
          origin: this.options.media ? 'lookahead' : 'live',
          source: { text: '', language: UNKNOWN_LANGUAGE, final: false },
          translation: null,
          untranslated: 'pending',
        },
        preview: null,
        mixed: null,
        translatedAt: null,
      };
      this.place(state.cue, startSample, endSample);
      this.segments.set(id, state);
      this.prune();
    }
    return state;
  }

  /** A lookahead line's translation budget (until shortly before it shows); live: the default. */
  private budgetFor(cue: Cue): number | undefined {
    const until = this.options.untilShownMs;
    if (!until || !cue.media) return undefined;
    return lookaheadBudgetMs(until(cue.media.start));
  }

  /** Times a cue: in epoch ms as heard, or (lookahead) on the video's timeline. */
  private place(cue: Cue, startSample: number, endSample: number): void {
    const media = this.options.media;
    if (media) {
      const rate = PIPELINE_SAMPLE_RATE;
      cue.media = { timeline: media.timeline, start: startSample / rate, end: endSample / rate };
      return;
    }
    cue.startEpochMs = this.clock.toEpochMs(startSample);
    cue.endEpochMs = this.clock.toEpochMs(endSample);
  }

  /**
   * The next number, or for a later line of a split segment, a number right after its segment:
   * it may arrive after the next segment started.
   */
  private seqFor(id: string): number {
    const split = SPLIT_LINE.exec(id);
    const parent = split ? this.segments.get(split[1] as string) : undefined;
    if (!parent) return ++this.seq;
    const n = Number(split?.[2]);
    return parent.cue.seq + 1 - 1 / Math.max(2, n);
  }

  private onAsrResult(result: AsrResult): void {
    if (this.closing.signal.aborted) return;
    this.show(result);
    if (!result.final) {
      // Tell the segmenter what was said so far: a sentence end lets the segment end now.
      const language = result.language?.tag ?? null;
      this.dispatch(
        this.segmenter.transcript(result.segmentId, result.endSample, result.text, language),
      );
    }
  }

  private show(result: AsrResult): void {
    const state = this.segmentState(result.segmentId, result.startSample, result.endSample);
    const { cue } = state;
    const language = result.language?.tag ?? this.options.sourceLanguage ?? UNKNOWN_LANGUAGE;
    this.place(cue, result.startSample, result.endSample);
    cue.source = { text: result.text, language, final: result.final };
    const target = this.options.targetLanguage;

    // Heard as the target language: translated only when part of it is in another one.
    let from = language;
    state.mixed = null;
    if (sameLanguage(language, target)) {
      const foreign = foreignPart(result.text, target, this.options.spokenLanguages ?? []);
      if (!foreign) {
        state.preview?.abort();
        cue.translation = null;
        cue.untranslated = 'same-language';
        this.emit(cue);
        if (result.final && result.text.trim() !== '') {
          // A line not translated: the next one has no line before it to revise.
          this.finals = this.finals.then(() => {
            this.lastLine = null;
          });
          this.checkMixed(state, result.text, language);
        }
        return;
      }
      from = foreign.language;
      state.mixed = [foreign.language, language];
    }

    cue.untranslated = 'pending';
    if (cue.translation) cue.translation = { ...cue.translation, final: false };
    this.emit(cue);

    if (result.final) {
      state.preview?.abort();
      if (result.text.trim() === '') return;
      const text = result.text;
      this.finals = this.finals.then(() => this.translateFinal(state, text, from));
    } else if (this.options.translatePartials && result.text.trim() !== '') {
      state.preview?.abort();
      state.preview = new AbortController();
      void this.translate(state, result.text, from, false, state.preview.signal);
    }
  }

  /**
   * A finished line heard as the target language, in its script: when the detector finds another
   * language in it too, translate it after all (in its turn among the finished lines).
   */
  private checkMixed(state: SegmentState, text: string, language: LanguageTag): void {
    const detect = this.options.detectLanguages;
    if (!detect || text.trim() === '') return;
    const target = this.options.targetLanguage;
    this.finals = this.finals.then(async () => {
      const other = await detectForeign(text, target, detect).catch(() => null);
      const { cue } = state;
      if (!other || this.closing.signal.aborted || cue.source.text !== text) return;
      state.mixed = [other, language];
      cue.untranslated = 'pending';
      this.emit(cue);
      await this.translateFinal(state, text, other);
    });
  }

  /** Translates a final line, giving up after the timeout so later lines go on. */
  private async translateFinal(
    state: SegmentState,
    text: string,
    language: LanguageTag,
  ): Promise<void> {
    if (this.closing.signal.aborted) return;
    const timeout = new AbortController();
    const signal = AbortSignal.any([this.closing.signal, timeout.signal]);
    const budgetMs = this.budgetFor(state.cue);
    let timeoutMs = this.options.translationTimeoutMs ?? TRANSLATION_TIMEOUT_MS;
    // The backup still gets its time after a longer budget.
    if (budgetMs !== undefined) timeoutMs = Math.max(timeoutMs, budgetMs + BACKUP_SLACK_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timeout.abort(new Error('The translation took too long.'));
        resolve();
      }, timeoutMs);
    });
    const previous = this.previousFor(text, language);
    // A translator that ignores the signal still lets the queue go on.
    await Promise.race([
      this.translate(state, text, language, true, signal, previous, budgetMs),
      expired,
    ]);
    clearTimeout(timer);
    if (timeout.signal.aborted && !this.closing.signal.aborted) {
      this.lastLine = null;
      const { cue } = state;
      cue.untranslated = 'failed';
      this.emit(cue);
      this.options.onError(timeout.signal.reason as Error);
    }
  }

  private async translate(
    state: SegmentState,
    text: string,
    language: LanguageTag,
    final: boolean,
    signal: AbortSignal = this.closing.signal,
    previous?: TranslationRequest['previous'],
    budgetMs?: number,
  ): Promise<void> {
    const { cue } = state;
    const target = this.options.targetLanguage;
    const lines = this.options.contextLines ?? 6;
    let stream: AsyncIterator<TranslationChunk> | null = null;
    /** The stream goes on in the background, for a revision of the line before. */
    let handedOff = false;
    try {
      const mixed = state.mixed;
      stream = this.options.translator
        .translate({
          segmentId: cue.id,
          source: { kind: 'text', text, language, ...(mixed ? { mixed } : {}) },
          target,
          sourceFinal: final,
          context: this.context.slice(-lines),
          ...(previous ? { previous } : {}),
          ...(budgetMs !== undefined ? { budgetMs } : {}),
          signal,
        })
        [Symbol.asyncIterator]();
      for (;;) {
        const step = await stream.next();
        if (step.done || signal.aborted) return;
        const chunk = step.value;
        if (chunk.revises) {
          this.revise(chunk.revises.segmentId, chunk.text);
          continue;
        }
        // A preview never overwrites a finished translation.
        if (!final && cue.translation?.final) return;
        // A mixed line keeps the language it was heard in: it was sent on purpose.
        if (chunk.sourceLanguage && cue.source.final === final && !mixed) {
          // The engine checked the text: its language wins.
          cue.source = { ...cue.source, language: chunk.sourceLanguage };
          if (sameLanguage(chunk.sourceLanguage, target)) {
            cue.translation = null;
            cue.untranslated = 'same-language';
            this.emit(cue);
            if (final) this.lastLine = null;
            return;
          }
        }
        // A mixed line given back as it was (Chrome's translator heard the target): the source
        // is no translation.
        if (mixed && chunk.final && sameText(chunk.text, text)) {
          cue.translation = null;
          cue.untranslated = 'same-language';
          this.emit(cue);
          if (final) this.lastLine = null;
          return;
        }
        cue.translation = { text: chunk.text, language: target, final: final && chunk.final };
        if (cue.translation.final) cue.untranslated = null;
        this.emit(cue);
        if (cue.translation.final) {
          this.context.push({
            source: text,
            translation: cue.translation.text,
            language: cue.source.language,
          });
          if (this.context.length > lines) this.context.shift();
          state.translatedAt = this.now();
          this.lastLine = { state, source: text, language, revised: false };
          // The line is done; a revision of the line before may follow without holding up
          // the next line.
          if (previous) {
            handedOff = true;
            this.followRevisions(stream, signal);
          }
          return;
        }
      }
    } catch (err) {
      if (signal.aborted || !final) return;
      this.lastLine = null;
      cue.untranslated = 'failed';
      this.emit(cue);
      this.options.onError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (!handedOff) await stream?.return?.();
    }
  }

  /** Reads the rest of a finished line's stream for a revision of the line before. */
  private followRevisions(stream: AsyncIterator<TranslationChunk>, signal: AbortSignal): void {
    void (async () => {
      try {
        for (;;) {
          const step = await stream.next();
          if (step.done || signal.aborted) break;
          if (step.value.revises) this.revise(step.value.revises.segmentId, step.value.text);
        }
      } catch {
        // A revision is a bonus; the line itself is done.
      } finally {
        await stream.return?.().catch(() => {});
      }
    })();
  }

  /**
   * The line before, for the translator to revise along with `text`: when it is still on screen,
   * its sentence was left open, `text` ends it, and it wasn't revised yet (once per line).
   */
  private previousFor(text: string, language: LanguageTag): TranslationRequest['previous'] {
    const last = this.lastLine;
    if (!this.options.translator.info.revises || !last || last.revised) return undefined;
    const { cue } = last.state;
    if (!cue.translation?.final || cue.untranslated !== null) return undefined;
    if (isSentenceEnd(last.source, { rule: 'either', language: last.language })) return undefined;
    if (!isSentenceEnd(text, { rule: 'either', language })) return undefined;
    if (!this.onScreen(last.state)) return undefined;
    last.revised = true;
    return {
      segmentId: cue.id,
      source: last.source,
      translation: cue.translation.text,
      language: last.language,
    };
  }

  /**
   * Whether a finished line's translation is likely still on screen: the overlay holds it for its
   * reading time, and a little longer.
   */
  private onScreen(state: SegmentState): boolean {
    const shown = state.translatedAt;
    const text = state.cue.translation?.text;
    if (shown === null || !text) return false;
    return this.now() - shown < readingMs(text) + LINGER_MS;
  }

  /** A better translation of an earlier line, while it is on screen. */
  private revise(segmentId: string, text: string): void {
    const state = this.segments.get(segmentId);
    if (!state?.cue.translation || !this.onScreen(state)) return;
    if (state.cue.translation.text === text) return;
    const before = state.cue.translation.text;
    state.cue.translation = { ...state.cue.translation, text, final: true };
    const ctx = this.context.find((c) => c.translation === before);
    if (ctx) ctx.translation = text;
    this.emit(state.cue);
  }

  private emit(cue: Cue): void {
    const out = structuredClone(cue);
    const prefix = this.options.media?.idPrefix;
    if (prefix) out.id = `${prefix}${out.id}`;
    this.options.onCue(out);
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

/** The same words, whatever the spacing, case and punctuation. */
function sameText(a: string, b: string): boolean {
  const norm = (t: string) =>
    t
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '');
  return norm(a) === norm(b);
}
