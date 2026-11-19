/**
 * `chrome-translator`: Chrome's built-in on-device Translator, one instance per language pair,
 * with the built-in LanguageDetector checking each line's language first.
 *
 * Measured on Chrome 157 (RTX 3070 PC): 18–44 ms per short line once warm, create 49–97 ms;
 * detection under 1 ms. Each line is translated on its own (the API takes no context), from the
 * language its text is in: the detector's answer wins over the speech engine's when it is sure,
 * because the text is what gets translated.
 *
 * Packs: when the session names its spoken languages, `load()` needs their pairs into the
 * target; missing ones reject with `EngineActionRequiredError` (a click in the popup starts them,
 * see setup.ts). A pair met later that still needs a download fails that line with the same
 * error, so the session can ask for it. The detector is used when Chrome has it ready and never
 * blocks: on Chrome 157 its availability went back to `downloadable` after browser restarts in
 * automated profiles, and lines translate fine from the speech engine's language without it.
 */
import {
  EngineActionRequiredError,
  EngineUnavailableError,
  UnsupportedLanguageError,
} from '../errors';
import type {
  EngineState,
  LanguageTag,
  LoadOptions,
  TranslationChunk,
  TranslationEngine,
  TranslationEngineInfo,
  TranslationRequest,
} from '../types';
import { UNKNOWN_LANGUAGE } from '../types';
import {
  type DetectorInstance,
  detectorApi,
  type TranslatorInstance,
  translatorApi,
  translatorLanguage,
} from './api';
import { CHROME_TRANSLATOR_INFO } from './info';
import { missingSetup, translationAction, waitForDownloads } from './setup';

/** Detector confidence above which its language replaces the speech engine's. */
const DETECTOR_TRUST = 0.7;

export class ChromeTranslatorEngine implements TranslationEngine {
  readonly info: TranslationEngineInfo = CHROME_TRANSLATOR_INFO;
  private status: EngineState = 'unloaded';
  private detector: DetectorInstance | null = null;
  private readonly translators = new Map<string, Promise<TranslatorInstance>>();

  get state(): EngineState {
    return this.status;
  }

  async load(options: LoadOptions = {}): Promise<void> {
    if (this.status === 'ready') return;
    const api = translatorApi();
    const detector = detectorApi();
    if (!api) {
      this.status = 'error';
      throw new EngineUnavailableError('Chrome on-device translation is not available here.');
    }
    this.status = 'loading';
    try {
      // Packs for the languages the person said they hear; others are checked line by line.
      const target = options.session?.targetLanguage;
      const pairs = (options.session?.spokenLanguages ?? [])
        .filter((l) => target && translatorLanguage(l) !== translatorLanguage(target))
        .map((l) => [l, target as string] as const);
      const report = await missingSetup({ translation: pairs });
      if (report.actions.length > 0) throw new EngineActionRequiredError(report.actions);
      if (report.downloading.length > 0) {
        options.onProgress?.({ stage: 'download', fraction: null, file: 'translation packs' });
        await waitForDownloads(report.downloading, options.signal);
      }
      this.detector =
        detector && (await detector.availability()) === 'available'
          ? await detector.create()
          : null;
      for (const [source, t] of pairs) void this.translator(source, t).catch(() => {});
      this.status = 'ready';
    } catch (err) {
      this.status = 'error';
      throw err;
    }
  }

  async unload(): Promise<void> {
    this.detector?.destroy();
    this.detector = null;
    for (const t of this.translators.values()) void t.then((x) => x.destroy()).catch(() => {});
    this.translators.clear();
    this.status = 'unloaded';
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationChunk> {
    if (request.source.kind !== 'text') throw new Error('chrome-translator translates text only.');
    const text = request.source.text;
    const source = await this.sourceLanguage(text, request.source.language);
    request.signal.throwIfAborted();
    if (translatorLanguage(source) === translatorLanguage(request.target)) {
      yield { text, final: true, sourceLanguage: source };
      return;
    }
    if (source === UNKNOWN_LANGUAGE) throw new Error('The line’s language is unknown.');
    const translated = await this.run(source, request.target, text, request.signal);
    yield { text: translated, final: true, sourceLanguage: source };
  }

  /** The detector's language when it's sure, else the speech engine's. */
  private async sourceLanguage(text: string, given: LanguageTag): Promise<LanguageTag> {
    if (!this.detector || text.trim() === '') return given;
    try {
      const [top] = await this.detector.detect(text);
      if (top && top.detectedLanguage !== 'und' && top.confidence >= DETECTOR_TRUST) {
        return top.detectedLanguage;
      }
    } catch {
      // Detection is a refinement; translate with the given language.
    }
    return given;
  }

  private async run(
    source: LanguageTag,
    target: LanguageTag,
    text: string,
    signal: AbortSignal,
  ): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const translator = await this.translator(source, target);
      try {
        return await translator.translate(text, { signal });
      } catch (err) {
        // A translator created while another pack was downloading fails with UnknownError until
        // it is created again (seen on Chrome 157).
        if (signal.aborted || attempt > 0 || !(err instanceof Error)) throw err;
        if (err.name !== 'UnknownError' && err.name !== 'InvalidStateError') throw err;
        this.translators.delete(pairKey(source, target));
        translator.destroy();
      }
    }
  }

  private translator(source: LanguageTag, target: LanguageTag): Promise<TranslatorInstance> {
    const key = pairKey(source, target);
    let entry = this.translators.get(key);
    if (!entry) {
      entry = this.create(source, target);
      this.translators.set(key, entry);
      entry.catch(() => this.translators.delete(key));
    }
    return entry;
  }

  private async create(source: LanguageTag, target: LanguageTag): Promise<TranslatorInstance> {
    const api = translatorApi();
    if (!api) throw new EngineUnavailableError('Chrome translation is not available.');
    const sourceLanguage = translatorLanguage(source);
    const targetLanguage = translatorLanguage(target);
    const state = await api.availability({ sourceLanguage, targetLanguage });
    const action = translationAction(source, target);
    if (state === 'downloadable') throw new EngineActionRequiredError([action]);
    if (state === 'downloading') throw new Error(`${action.label}: still downloading.`);
    if (state === 'unavailable') {
      throw new UnsupportedLanguageError(
        sourceLanguage,
        `Chrome can't translate ${sourceLanguage} to ${targetLanguage}.`,
      );
    }
    return api.create({ sourceLanguage, targetLanguage });
  }
}

function pairKey(source: LanguageTag, target: LanguageTag): string {
  return `${translatorLanguage(source)}>${translatorLanguage(target)}`;
}
