/**
 * `chrome-webspeech`: Chrome's on-device speech recognition on the captured tab track.
 *
 * On-device only: every recognizer is created with `processLocally = true`, and the engine
 * refuses to run (EngineUnavailableError) when the browser has no `processLocally` or the
 * on-device statics (`available`/`install`), so audio never goes to a cloud recognizer.
 *
 * Code-switching: a recognizer knows one language, so the session runs one per spoken language
 * (at most `MAX_RECOGNIZERS`) on the same track and, for each speech segment the pipeline finds,
 * keeps the transcript of the recognizer that heard its own language (arbiter.ts).
 *
 * Segments: measured on Chrome 157, a recognizer often doesn't end its result at a short pause
 * when speech in another language follows (finals 7–17 s late), and a result can run across a
 * language switch. So the session doesn't wait for the recognizers' own finals: it cuts every
 * recognizer's text at the pauses the pipeline's segmenter finds (a cursor into each recognizer's
 * results, taken `SETTLE_MS` after the pause so the last words are in), and each segment gets
 * exactly one final. The recognizers themselves run for the whole session: an earlier design that
 * restarted them at every pause (to force their finals) created ~8 recognizers per segment, and
 * after ~20 Chrome's speech service stopped returning results altogether.
 */
import { primaryLanguage } from '@/pipeline/language';
import { EngineActionRequiredError, EngineUnavailableError } from '../errors';
import type {
  AsrEngine,
  AsrEngineInfo,
  AsrSession,
  AsrSessionOptions,
  EngineState,
  LanguageTag,
  LoadOptions,
} from '../types';
import {
  canPinOnDevice,
  type DetectorInstance,
  detectorApi,
  type Recognizer,
  type RecognizerClass,
  recognizerLocale,
  speechRecognition,
} from './api';
import {
  type Candidate,
  cleanTranscript,
  isSwitch,
  pickCandidate,
  type Scored,
  type Span,
  spacedScript,
  textSpan,
  unusedFrom,
} from './arbiter';
import { CHROME_WEBSPEECH_INFO } from './info';
import { MAX_RECOGNIZERS, missingSetup, speechAction, waitForDownloads } from './setup';

/** More recognizers cost CPU in Chrome's speech service and add wrong-language noise. */
export { MAX_RECOGNIZERS };

/** What the e2e build records about each segment's choice (for tuning the arbiter). */
export interface ArbitrationRecord {
  segmentId: string;
  speechMs: number;
  winner: string | null;
  scored: Scored[];
  /** Recognizer starts, ends and errors since the previous segment, epoch ms. */
  lifecycle: { at: number; locale: string; event: string }[];
}

export class WebSpeechAsrEngine implements AsrEngine {
  readonly info: AsrEngineInfo = CHROME_WEBSPEECH_INFO;
  private status: EngineState = 'unloaded';
  private locales: string[] = [];
  private detector: DetectorInstance | null = null;
  /** Called with every segment's arbitration (e2e builds). */
  onArbitration: ((record: ArbitrationRecord) => void) | null = null;

  get state(): EngineState {
    return this.status;
  }

  /** The recognizer languages the loaded engine runs. */
  get languages(): readonly string[] {
    return this.locales;
  }

  async load(options: LoadOptions = {}): Promise<void> {
    if (this.status === 'ready') return;
    const api = speechRecognition();
    if (!api || !canPinOnDevice(api)) {
      this.status = 'error';
      throw new EngineUnavailableError("Chrome can't do speech recognition on this device.");
    }
    this.status = 'loading';
    try {
      const asked = [
        ...(options.session?.spokenLanguages ?? []),
        ...(options.session?.sourceLanguage ? [options.session.sourceLanguage] : []),
      ];
      const wanted =
        asked.length > 0 ? unique(asked.map(recognizerLocale)) : await installedLocales(api);
      if (wanted.length === 0) {
        // Nothing said and nothing downloaded: offer the browser's language.
        throw new EngineActionRequiredError([speechAction([browserLanguage()])]);
      }
      const locales = wanted.slice(0, MAX_RECOGNIZERS);
      const report = await missingSetup({ speech: locales });
      if (report.unavailable.length > 0 && report.unavailable.length === locales.length) {
        throw new EngineUnavailableError(
          `Chrome has no on-device speech recognition for ${locales.join(', ')}.`,
        );
      }
      if (report.actions.length > 0) throw new EngineActionRequiredError(report.actions);
      if (report.downloading.length > 0) {
        options.onProgress?.({ stage: 'download', fraction: null, file: 'speech packs' });
        await waitForDownloads(report.downloading, options.signal);
      }
      const unavailable = new Set(report.unavailable.flatMap((a) => a.languages));
      this.locales = locales.filter((l) => !unavailable.has(l));
      this.detector = await createDetector();
      this.status = 'ready';
    } catch (err) {
      this.status = 'error';
      throw err;
    }
  }

  async unload(): Promise<void> {
    this.detector?.destroy();
    this.detector = null;
    this.status = 'unloaded';
  }

  createSession(options: AsrSessionOptions): AsrSession {
    const api = speechRecognition();
    if (this.status !== 'ready' || !api)
      throw new Error('Chrome speech recognition is not loaded.');
    if (!options.track) throw new Error('Chrome speech recognition needs the audio track.');
    return new WebSpeechSession(api, options, options.track, this.locales, this.detector, (r) =>
      this.onArbitration?.(r),
    );
  }
}

/** Where a listener's text was cut last: a result, and the text of it already used. */
interface Cursor {
  index: number;
  used: string;
}

/**
 * One long-lived recognizer for one language on the track (restarted when Chrome ends it). Its
 * results are numbered across restarts; the session cuts its text into segments with a cursor.
 */
class Listener {
  readonly results: { text: string; final: boolean }[] = [];
  /** Distinct texts seen so far (activity). */
  updates = 0;
  /** Length of the unused text at each update since the last cut, by sample. */
  history: { sample: number; length: number }[] = [];
  private cursor: Cursor = { index: 0, used: '' };
  private recognizer: Recognizer | null = null;
  private stopped = false;
  private lastText = '';

  constructor(
    private readonly api: RecognizerClass,
    private readonly track: MediaStreamTrack,
    readonly locale: string,
    private readonly lifecycle: ArbitrationRecord['lifecycle'],
    private readonly now: () => number,
    private readonly onChange: () => void,
    private readonly onFatal: (err: Error) => void,
  ) {
    this.start();
  }

  /** Text after the cursor (not yet given to a segment). */
  pending(): string {
    const parts: string[] = [];
    for (let i = this.cursor.index; i < this.results.length; i++) {
      const text = this.results[i]?.text ?? '';
      parts.push(
        i === this.cursor.index
          ? text.slice(unusedFrom(text, this.cursor.used, spacedScript(this.locale)))
          : text,
      );
    }
    return cleanTranscript(parts.join(' '), this.locale);
  }

  /** Gives everything heard so far to the segment that just ended. */
  cut(): void {
    const last = this.results.length - 1;
    this.cursor =
      last < 0 ? { index: 0, used: '' } : { index: last, used: this.results[last]?.text ?? '' };
    this.history = [];
  }

  stop(): void {
    this.stopped = true;
    try {
      this.recognizer?.abort();
    } catch {
      // Already ended.
    }
  }

  private start(): void {
    const r = new this.api();
    r.lang = this.locale;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.processLocally = true;
    if (r.processLocally !== true) {
      this.onFatal(new EngineUnavailableError("Chrome can't keep speech recognition on device."));
      return;
    }
    // A restarted recognizer numbers its results from 0 again: continue after the earlier ones.
    const offset = this.results.length;
    const note = (event: string) =>
      this.lifecycle.push({
        at: performance.timeOrigin + performance.now(),
        locale: this.locale,
        event,
      });
    note(this.recognizer ? 'restart' : 'start');
    r.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result)
          this.results[offset + i] = { text: result[0]?.transcript ?? '', final: result.isFinal };
      }
      const joined = this.results.map((x) => x?.text ?? '').join(' ');
      if (joined !== this.lastText) {
        this.lastText = joined;
        this.updates++;
        this.history.push({ sample: this.now(), length: this.pending().length });
        this.onChange();
      }
    };
    r.onerror = (event) => {
      note(`error ${event.error}`);
      if (FATAL_ERRORS.has(event.error)) {
        this.onFatal(
          new EngineUnavailableError(`Speech recognition (${this.locale}) failed: ${event.error}.`),
        );
      }
    };
    r.onend = () => {
      note('end');
      // Chrome ends a recognizer after a long silence: keep listening until the session stops.
      if (!this.stopped) setTimeout(() => !this.stopped && this.start(), 0);
    };
    try {
      r.start(this.track);
      this.recognizer = r;
    } catch (err) {
      this.onFatal(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

const FATAL_ERRORS = new Set([
  'language-not-supported',
  'service-not-allowed',
  'not-allowed',
  'audio-capture',
]);

/**
 * Time after a segment ends before its text is taken: the recognizers write the last words
 * about half a second after they're heard (the segmenter already waited out the pause).
 */
export const SETTLE_MS = 600;

interface OpenSegment {
  id: string;
  startSample: number;
  /** Each listener's `updates` when the segment started. */
  updatesAtStart: Map<string, number>;
}

class WebSpeechSession implements AsrSession {
  private readonly listeners: Listener[];
  private readonly lifecycle: ArbitrationRecord['lifecycle'] = [];
  private open: OpenSegment | null = null;
  /** A segment that ended, waiting for its last words. */
  private settling: {
    segment: OpenSegment;
    endSample: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private closed = false;
  private lastPartial = '';
  /** Language of the last line, for the continuity edge. */
  private previous: string | null = null;

  constructor(
    api: RecognizerClass,
    private readonly options: AsrSessionOptions,
    track: MediaStreamTrack,
    locales: readonly string[],
    private readonly detector: DetectorInstance | null,
    private readonly record: (r: ArbitrationRecord) => void,
  ) {
    this.listeners = locales.map(
      (locale) =>
        new Listener(
          api,
          track,
          locale,
          this.lifecycle,
          () => this.options.currentSample?.() ?? 0,
          () => this.partial(),
          (err) => this.options.onError(err),
        ),
    );
  }

  startSegment(segmentId: string, startSample: number): void {
    if (this.closed) return;
    // New speech: the previous segment's text is everything up to now.
    this.settleNow();
    this.open = {
      id: segmentId,
      startSample,
      updatesAtStart: new Map(this.listeners.map((l) => [l.locale, l.updates])),
    };
    this.lastPartial = '';
  }

  pushAudio(): void {
    // The recognizers hear the track itself.
  }

  endSegment(segmentId: string, endSample: number): void {
    const segment = this.open;
    if (!segment || segment.id !== segmentId) return;
    this.open = null;
    this.settleNow();
    this.settling = {
      segment,
      endSample,
      timer: setTimeout(() => this.settleNow(), SETTLE_MS),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.settleNow();
    for (const l of this.listeners) l.stop();
  }

  /** The leading recognizer's text for the open segment, shown dimmed. */
  private partial(): void {
    const seg = this.open;
    if (!seg || this.closed) return;
    const now = this.options.currentSample?.() ?? seg.startSample;
    const { winner } = pickCandidate(
      this.candidates(seg),
      this.ms(now - seg.startSample),
      this.previous,
    );
    if (!winner || winner.text === this.lastPartial) return;
    this.lastPartial = winner.text;
    this.options.onResult({
      segmentId: seg.id,
      final: false,
      text: winner.text,
      language: { tag: winner.language, confidence: Math.min(1, winner.score) },
      startSample: seg.startSample,
      endSample: Math.max(seg.startSample, now),
    });
  }

  /** Takes the settling segment's text now and decides it. */
  private settleNow(): void {
    const settling = this.settling;
    if (!settling) return;
    this.settling = null;
    clearTimeout(settling.timer);
    const { segment, endSample } = settling;
    const candidates = this.candidates(segment);
    const spans = new Map(this.listeners.map((l) => [l.locale, textSpan(l.history)]));
    for (const l of this.listeners) l.cut();
    const lifecycle = this.lifecycle.splice(0);
    void this.decide(segment, endSample, candidates, spans, lifecycle);
  }

  private candidates(seg: OpenSegment): Candidate[] {
    return this.listeners.map((l) => ({
      language: l.locale,
      text: l.pending(),
      updates: l.updates - (seg.updatesAtStart.get(l.locale) ?? 0),
    }));
  }

  private async decide(
    seg: OpenSegment,
    endSample: number,
    raw: Candidate[],
    spans: Map<string, Span | null>,
    lifecycle: ArbitrationRecord['lifecycle'],
  ): Promise<void> {
    const speechMs = this.ms(endSample - seg.startSample);
    const candidates = await Promise.all(
      raw.map(async (c) => ({ ...c, detected: await this.detect(c.text) })),
    );
    const { winner, scored } = pickCandidate(candidates, speechMs, this.previous);
    const lines = winner ? linesOf(winner, scored, spans) : [];
    const last = lines.at(-1);
    if (last) this.previous = last.language;
    this.record({
      segmentId: seg.id,
      speechMs,
      winner: lines.map((l) => l.language).join('+') || null,
      scored,
      lifecycle,
    });
    if (lines.length === 0) {
      this.options.onResult({
        segmentId: seg.id,
        final: true,
        text: '',
        language: null,
        startSample: seg.startSample,
        endSample,
      });
      return;
    }
    // A second line starts about when its recognizer began writing it, less the delay.
    const lag = (SETTLE_MS / 1000) * this.options.sampleRate;
    const secondFrom = spans.get(lines[1]?.language ?? '')?.from ?? endSample;
    const boundary = Math.min(endSample, Math.max(seg.startSample, secondFrom - lag));
    lines.forEach((line, i) => {
      this.options.onResult({
        segmentId: i === 0 ? seg.id : `${seg.id}.${i + 1}`,
        final: true,
        text: line.text,
        language: { tag: line.language, confidence: Math.min(1, line.score) },
        startSample: i === 0 ? seg.startSample : boundary,
        endSample: i === 0 && lines.length > 1 ? boundary : endSample,
      });
    });
  }

  private ms(samples: number): number {
    return (samples / this.options.sampleRate) * 1000;
  }

  private async detect(text: string): Promise<Candidate['detected']> {
    if (!this.detector || text.trim() === '') return null;
    try {
      const [top] = await this.detector.detect(text);
      return top ? { language: top.detectedLanguage, confidence: top.confidence } : null;
    } catch {
      return null;
    }
  }
}

/**
 * The segment's lines: the winner, plus a second language when the speaker switched inside the
 * segment (the pause between was too short to cut): a recognizer that wrote its text at another
 * time than the winner's, in time order.
 */
function linesOf(
  winner: Scored,
  scored: readonly Scored[],
  spans: Map<string, Span | null>,
): Scored[] {
  const span = (c: Scored) => spans.get(c.language) ?? null;
  const second = scored.find(
    (c) =>
      c !== winner &&
      primaryLanguage(c.language) !== primaryLanguage(winner.language) &&
      isSwitch({ ...winner, span: span(winner) }, { ...c, span: span(c) }),
  );
  if (!second) return [winner];
  const from = (c: Scored) => span(c)?.from ?? 0;
  return [winner, second].sort((a, b) => from(a) - from(b));
}

/** Locales whose on-device packs are already downloaded, most common first. */
async function installedLocales(api: RecognizerClass): Promise<string[]> {
  const available = api.available;
  if (!available) return [];
  const out: string[] = [];
  for (const language of CHROME_WEBSPEECH_INFO.languages as readonly LanguageTag[]) {
    const locale = recognizerLocale(language);
    try {
      if ((await available({ langs: [locale], processLocally: true })) === 'available') {
        out.push(locale);
      }
    } catch {
      // Not offered.
    }
  }
  return out;
}

async function createDetector(): Promise<DetectorInstance | null> {
  const api = detectorApi();
  if (!api) return null;
  try {
    // Without a click it can only be created once downloaded; arbitration works without it.
    return (await api.availability()) === 'available' ? await api.create() : null;
  } catch {
    return null;
  }
}

function browserLanguage(): string {
  return primaryLanguage(navigator.language || 'en') || 'en';
}

function unique<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}
