/**
 * Runs the overlay in one frame: finds the video, keeps the view over its picture through scroll,
 * resize, player changes and fullscreen, and draws the cues it's given.
 *
 * Positioning is event-driven (ResizeObserver, scroll, resize, fullscreenchange, play) plus an
 * animation-frame check while captions are on screen (players move without telling anyone), and a
 * slow tick that re-picks the video and re-attaches the host if a page re-render removed it.
 */
import type { Cue } from '@/pipeline/types';
import { DEFAULT_SETTINGS, type OverlaySettings } from '@/settings/settings';
import { CaptionStore } from './captions';
import {
  type CaptionLayout,
  captionLayout,
  parseObjectFit,
  pictureRect,
  type Rect,
  rectChanged,
} from './geometry';
import { describeVideo, findVideos, pickBest } from './pickVideo';
import { OverlayView } from './view';

const TICK_MS = 1000;

export class OverlayController {
  private readonly view: OverlayView;
  private readonly store = new CaptionStore();
  private settings: OverlaySettings = DEFAULT_SETTINGS.overlay;
  private video: HTMLVideoElement | null = null;
  private readonly resize = new ResizeObserver(() => this.schedule());
  private frame = 0;
  private tick = 0;
  private expiry = 0;
  private lastBox: Rect | null = null;
  private destroyed = false;

  constructor(
    private readonly win: Window,
    private readonly doc: Document = win.document,
  ) {
    this.view = new OverlayView(doc);
  }

  start(settings: OverlaySettings): void {
    this.settings = settings;
    this.repick();
    this.win.addEventListener('scroll', this.schedule, { capture: true, passive: true });
    this.win.addEventListener('resize', this.schedule, { passive: true });
    this.doc.addEventListener('fullscreenchange', this.onFullscreen);
    this.doc.addEventListener('play', this.onPlay, { capture: true });
    this.doc.addEventListener('loadedmetadata', this.schedule, { capture: true });
    this.tick = this.win.setInterval(() => this.repick(), TICK_MS);
    this.onFullscreen();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.win.removeEventListener('scroll', this.schedule, { capture: true });
    this.win.removeEventListener('resize', this.schedule);
    this.doc.removeEventListener('fullscreenchange', this.onFullscreen);
    this.doc.removeEventListener('play', this.onPlay, { capture: true });
    this.doc.removeEventListener('loadedmetadata', this.schedule, { capture: true });
    this.win.clearInterval(this.tick);
    this.win.clearTimeout(this.expiry);
    this.win.cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.view.unmount();
  }

  setSettings(settings: OverlaySettings): void {
    this.settings = settings;
    this.lastBox = null;
    this.update();
  }

  applyCue(cue: Cue): void {
    this.store.apply(cue, Date.now());
    this.update();
  }

  reset(): void {
    this.store.reset();
    this.update();
  }

  /** The video the overlay follows (tests, debugging). */
  get target(): HTMLVideoElement | null {
    return this.video;
  }

  private readonly schedule = (): void => {
    if (this.destroyed || this.frame) return;
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  };

  private readonly onPlay = (): void => this.repick();

  private readonly onFullscreen = (): void => {
    const fs = this.doc.fullscreenElement;
    const video = this.video;
    if (fs && video && fs === video) {
      this.view.mount(this.doc.documentElement);
      this.view.setPopover(true);
    } else {
      this.view.setPopover(false);
      this.view.mount(fs ?? this.doc.documentElement);
    }
    this.lastBox = null;
    this.schedule();
  };

  /** Re-picks the video and re-attaches the host if the page removed it. */
  private repick(): void {
    if (this.destroyed) return;
    const videos = findVideos(this.doc);
    const viewport = this.viewport();
    const best = pickBest(videos.map(describeVideo), viewport);
    const next = best >= 0 ? (videos[best] ?? null) : this.video?.isConnected ? this.video : null;
    if (next !== this.video) {
      if (this.video) this.resize.unobserve(this.video);
      this.video = next;
      if (next) this.resize.observe(next);
      this.onFullscreen();
    }
    if (!this.view.host.isConnected) this.onFullscreen();
    this.schedule();
  }

  private update(): void {
    if (this.destroyed) return;
    const now = Date.now();
    const blocks = this.store.visible(now, this.settings.display, this.settings.showPartials);
    const layout = blocks.length > 0 ? this.layout() : null;
    if (rectChanged(layout?.box ?? null, this.lastBox) || !layout) {
      this.view.layout(layout, this.settings);
      this.lastBox = layout?.box ?? null;
    }
    this.view.render(layout ? blocks : []);

    // Follow the player every frame while something is on screen.
    if (layout) this.schedule();
    this.win.clearTimeout(this.expiry);
    const next = this.store.nextExpiry();
    if (next !== null) this.expiry = this.win.setTimeout(() => this.update(), next - now + 16);
  }

  private layout(): CaptionLayout | null {
    const viewport = this.viewport();
    const video = this.video;
    let picture: Rect;
    if (video?.isConnected) {
      const r = video.getBoundingClientRect();
      picture = pictureRect(
        { left: r.left, top: r.top, width: r.width, height: r.height },
        { width: video.videoWidth, height: video.videoHeight },
        parseObjectFit(this.win.getComputedStyle(video).objectFit),
      );
    } else if (this.win === this.win.top && !this.sameOriginFrameHasVideo()) {
      // No video here or in a frame we can see into (audio-only page, or a player in a
      // cross-origin frame we can't inject into): use the bottom of the window.
      picture = { left: 0, top: 0, width: viewport.width, height: viewport.height };
    } else {
      return null;
    }
    return captionLayout(picture, viewport, { fontScale: this.settings.fontScale });
  }

  private viewport() {
    const el = this.doc.documentElement;
    return {
      width: el.clientWidth || this.win.innerWidth,
      height: el.clientHeight || this.win.innerHeight,
    };
  }

  /** A same-origin child frame has a video: its own overlay instance shows the captions. */
  private sameOriginFrameHasVideo(): boolean {
    for (const frame of this.doc.querySelectorAll('iframe')) {
      try {
        const inner = frame.contentDocument;
        if (inner && findVideos(inner).length > 0) return true;
      } catch {
        // Cross-origin: not ours to see.
      }
    }
    return false;
  }
}
