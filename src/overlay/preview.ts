/**
 * A subtitle preview for the options page, drawn by the real overlay view and caption store, so
 * what you see there is what you get on a video. Shows two finished lines, the second in another
 * language (tagged); `play()` loops a short scene where lines are heard, settle and get
 * translated.
 */
import type { Cue } from '@/pipeline/types';
import type { OverlaySettings } from '@/settings/settings';
import { CaptionStore } from './captions';
import { MIN_HEIGHT_FOR_ORIGINAL, STACK_WIDTH } from './controller';
import { captionLayout } from './geometry';
import { fitFor } from './measure';
import { OverlayView } from './view';

interface Line {
  source: string;
  language: string;
  translation: string;
}

const SCENE: readonly Line[] = [
  {
    source: 'On se retrouve devant la gare à huit heures ?',
    language: 'fr',
    translation: 'Shall we meet outside the station at eight?',
  },
  {
    source: 'Ja, aber ich komme vielleicht ein bisschen später.',
    language: 'de',
    translation: 'Yes, but I might be a little late.',
  },
  {
    source: "D'accord, je t'attendrai à l'entrée principale.",
    language: 'fr',
    translation: "All right, I'll wait for you at the main entrance.",
  },
];

/** Lines heard earlier, so the store knows which language is mostly spoken. */
const EARLIER: readonly Line[] = [
  { source: 'Tu as vu le message ?', language: 'fr', translation: 'Did you see the message?' },
  { source: 'Oui, ce matin.', language: 'fr', translation: 'Yes, this morning.' },
];

const WORD_MS = 280;

export class SubtitlePreview {
  private readonly view: OverlayView;
  private readonly store = new CaptionStore();
  private readonly resize: ResizeObserver;
  private settings: OverlaySettings | null = null;
  private clock = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private playing = false;

  constructor(private readonly container: HTMLElement) {
    this.view = new OverlayView(container.ownerDocument, { contained: true });
    this.view.mount(container);
    this.resize = new ResizeObserver(() => this.draw());
    this.resize.observe(container);
    this.showStill();
  }

  setSettings(settings: OverlaySettings): void {
    this.settings = settings;
    this.draw();
  }

  /** Loops the scene until `stop()`. */
  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.loop();
  }

  stop(): void {
    this.playing = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.showStill();
  }

  destroy(): void {
    this.stop();
    this.resize.disconnect();
    this.view.unmount();
  }

  private showStill(): void {
    this.store.reset();
    let seq = 0;
    for (const line of [...EARLIER, ...SCENE.slice(0, 2)]) {
      this.store.apply(cue(`still-${seq}`, ++seq, line, 'final'), 0);
    }
    this.clock = 0;
    this.draw();
  }

  private loop(): void {
    this.store.reset();
    let seq = 0;
    for (const line of EARLIER) this.store.apply(cue(`early-${seq}`, ++seq, line, 'final'), 0);
    const start = Date.now();
    let at = 0;
    /** Runs `fn` `delay` ms after the previous step. */
    const step = (delay: number, fn: () => void) => {
      at += delay;
      this.timers.push(
        setTimeout(() => {
          if (!this.playing) return;
          this.clock = Date.now() - start;
          fn();
          this.draw();
        }, at),
      );
    };
    for (const [i, line] of SCENE.entries()) {
      const id = `scene-${i}`;
      const n = ++seq;
      const words = line.source.split(' ');
      for (let w = 1; w <= words.length; w++) {
        const partial = { ...line, source: words.slice(0, w).join(' ') };
        step(WORD_MS, () => this.store.apply(cue(id, n, partial, 'heard'), this.clock));
      }
      step(500, () => this.store.apply(cue(id, n, line, 'transcribed'), this.clock));
      step(1200, () => this.store.apply(cue(id, n, line, 'final'), this.clock));
      at += 900;
    }
    step(3500, () => this.loop());
  }

  private draw(): void {
    const s = this.settings;
    if (!s) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const box = { left: 0, top: 0, width, height };
    const layout = captionLayout(box, { width, height }, { fontScale: s.fontScale });
    if (!layout) {
      this.view.layout(null, this.style(s));
      return;
    }
    const doc = this.container.ownerDocument;
    const fit = fitFor(doc, width * STACK_WIDTH, layout.fontPx);
    const blocks = this.store.visible(this.clock, {
      display: s.display,
      showPartials: s.showPartials,
      originalPlacement: s.originalPlacement,
      languageTags: s.languageTags,
      showOriginal: height >= MIN_HEIGHT_FOR_ORIGINAL,
      fit,
      fitKey: `${width}:${layout.fontPx}`,
    });
    this.view.layout(layout, this.style(s));
    this.view.render(blocks, {
      main: fit.main.maxWidth ?? 0,
      original: fit.original.maxWidth ?? 0,
    });
  }

  private style(s: OverlaySettings) {
    return {
      position: s.position,
      background: s.background,
      backgroundOpacity: s.backgroundOpacity,
      anchorY: 0.95,
      shiftX: 0,
      lift: 0,
    };
  }
}

function cue(id: string, seq: number, line: Line, stage: 'heard' | 'transcribed' | 'final'): Cue {
  return {
    id,
    seq,
    startEpochMs: 0,
    endEpochMs: 0,
    source: { text: line.source, language: line.language, final: stage !== 'heard' },
    translation: stage === 'final' ? { text: line.translation, language: 'en', final: true } : null,
    untranslated: stage === 'final' ? null : 'pending',
  };
}
