/**
 * Runs the overlay in one frame: finds the video, keeps the view over its picture through scroll,
 * resize, player changes and fullscreen, and draws the cues it's given.
 *
 * Two loops, so fitting text (line breaking, measuring) never runs per frame:
 * - `refresh()` recomputes what to show: on a cue, a settings change, a page turn or expiry, or
 *   when the player's size changes how lines fit.
 * - `follow()` keeps the view over the picture and clear of the player's controls: on scroll,
 *   resize (of the window or the video), fullscreen, pointer and playback events, and every
 *   `FOLLOW_MS` while something is on screen (players move without telling anyone). It reads
 *   layout only then, never every frame.
 * A slow tick re-picks the video (without walking the whole page, see `VideoFinder`) and
 * re-attaches the host if a page re-render removed it.
 *
 * Fullscreen: the host goes inside the fullscreen element when that is a plain container of the
 * video; otherwise (the video itself, a player in another frame, a web component whose video is
 * in its shadow root) it becomes a popover in the top layer, above the fullscreen element.
 * When a frame inside the page has a video, that frame's overlay shows the subtitles, and the
 * top frame's stays out of the way.
 */
import type { PlayheadReport } from '@/lookahead/protocol';
import type { VideoTimeline } from '@/lookahead/sites';
import type { Span } from '@/lookahead/types';
import type { OverlayStatus } from '@/messaging/protocol';
import type { Cue } from '@/pipeline/types';
import type { CaptionOffset } from '@/settings/positions';
import { clampOffset } from '@/settings/positions';
import { DEFAULT_SETTINGS, type OverlaySettings } from '@/settings/settings';
import { type CaptionBlock, CaptionStore, type ViewOptions } from './captions';
import {
  type CaptionLayout,
  captionLayout,
  parseObjectFit,
  pictureRect,
  type Rect,
  rectChanged,
} from './geometry';
import { fitFor } from './measure';
import { JUMP_S, MediaClock, MediaCues } from './mediacues';
import { describeVideo, findVideos, pickBest, VideoFinder } from './pickVideo';
import { adapterFor, liftToClear, type PlayerAdapter } from './sites';
import { OverlayView, type StatusChip, type ViewStyle } from './view';

const TICK_MS = 1000;
/** How often the view checks the player's place while something is on screen. */
export const FOLLOW_MS = 250;
/** Pointer activity over the picture counts as "controls showing" for this long. */
const POINTER_IDLE_MS = 2600;
/** Players shorter than this show the translation only (the original would be unreadable). */
export const MIN_HEIGHT_FOR_ORIGINAL = 240;
/** Share of the picture width the subtitles may use (the stack's side margins are 4%). */
export const STACK_WIDTH = 0.92;

export interface ControllerHooks {
  /** The user dragged the subtitles somewhere (or reset them, `null`). */
  onPositionChange?(offset: CaptionOffset | null): void;
  /** This frame started or stopped having a video to draw on. */
  onVideo?(present: boolean): void;
  /** Lookahead: what a video plays (null: nothing lookahead can read here). */
  timelineOf?(video: HTMLVideoElement): VideoTimeline | null;
  /** Lookahead: where the followed video is, for the session (on changes, and every second). */
  onPlayhead?(report: PlayheadReport): void;
}

/** Media events that move or stop the playhead (lookahead follows them). */
const PLAYHEAD_EVENTS = [
  'seeking',
  'seeked',
  'ratechange',
  'pause',
  'play',
  'emptied',
  'timeupdate',
];

/** Elements whose children are never drawn, or that hold their video in a shadow root. */
const NO_CHILDREN = new Set([
  'iframe',
  'frame',
  'video',
  'audio',
  'canvas',
  'img',
  'object',
  'embed',
]);

/**
 * Whether the host shows when appended to the fullscreen element `fs`: a plain container of the
 * video (or, with no video here, any plain container). Not an iframe or a video, and not a shadow
 * host, whose shadow root decides what is drawn.
 */
export function canHoldOverlay(
  fs: { localName: string; shadowRoot: unknown; contains(other: unknown): boolean },
  video: unknown,
): boolean {
  if (NO_CHILDREN.has(fs.localName) || fs.shadowRoot) return false;
  return !video || fs.contains(video);
}

export class OverlayController {
  private readonly view: OverlayView;
  private readonly store = new CaptionStore();
  private readonly adapter: PlayerAdapter | null;
  private settings: OverlaySettings = DEFAULT_SETTINGS.overlay;
  private offset: CaptionOffset | null = null;
  private video: HTMLVideoElement | null = null;
  private readonly resize = new ResizeObserver(() => this.schedule());
  private frame = 0;
  private poll = 0;
  private tick = 0;
  private readonly finder: VideoFinder;
  /** A frame inside this one has a video (and its own overlay shows the subtitles). */
  private videoInFrame = false;
  /** A same-origin frame here has a video (checked on the slow tick). */
  private sameOriginVideo = false;
  private timer = 0;
  private lastBox: Rect | null = null;
  private lastStyle = '';
  private lastFitKey = '';
  private lastRender = '';
  private layoutNow: CaptionLayout | null = null;
  private fit: ViewOptions['fit'] | null = null;
  private showOriginal = true;
  private shown = false;
  private chip: StatusChip | null = null;
  private chipTimer = 0;
  private lastPointer = 0;
  private lift = 0;
  private drag: { x: number; y: number; from: CaptionOffset; current: CaptionOffset } | null = null;
  private destroyed = false;
  /** Lookahead (null until the session says it runs): cues on the video's timeline. */
  private media: MediaCues | null = null;
  private readonly clock = new MediaClock();
  /** How long after the page plays a moment the person hears it, seconds. */
  private lagS = 0;
  private mediaFrame = 0;
  /** Media time at the last refresh, and the next one at which the picture changes. */
  private mediaT: number | null = null;
  private mediaNext: number | null = null;
  private lastReport = '';
  private lastReportAt = 0;

  constructor(
    private readonly win: Window,
    private readonly doc: Document = win.document,
    private readonly hooks: ControllerHooks = {},
  ) {
    this.view = new OverlayView(doc);
    this.finder = new VideoFinder(doc);
    this.adapter = adapterFor(win.location.hostname);
    this.view.setDragHandlers({
      start: (e) => this.dragStart(e),
      move: (e) => this.dragMove(e),
      end: () => this.dragEnd(),
      reset: () => {
        this.offset = null;
        this.hooks.onPositionChange?.(null);
        this.follow();
      },
    });
  }

  start(settings: OverlaySettings): void {
    this.settings = settings;
    this.repick();
    this.win.addEventListener('scroll', this.schedule, { capture: true, passive: true });
    this.win.addEventListener('resize', this.schedule, { passive: true });
    this.doc.addEventListener('fullscreenchange', this.onFullscreen);
    this.doc.addEventListener('play', this.onPlay, { capture: true });
    this.doc.addEventListener('pause', this.schedule, { capture: true });
    this.doc.addEventListener('loadedmetadata', this.schedule, { capture: true });
    this.doc.addEventListener('pointermove', this.onPointer, { capture: true, passive: true });
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
    this.doc.removeEventListener('pause', this.schedule, { capture: true });
    this.doc.removeEventListener('loadedmetadata', this.schedule, { capture: true });
    this.doc.removeEventListener('pointermove', this.onPointer, { capture: true });
    this.win.clearInterval(this.tick);
    this.win.clearTimeout(this.poll);
    this.finder.disconnect();
    this.win.clearTimeout(this.timer);
    this.win.clearTimeout(this.chipTimer);
    this.win.cancelAnimationFrame(this.frame);
    this.win.cancelAnimationFrame(this.mediaFrame);
    if (this.media) {
      for (const type of PLAYHEAD_EVENTS) {
        this.doc.removeEventListener(type, this.onPlayheadEvent, { capture: true });
      }
    }
    this.resize.disconnect();
    this.view.unmount();
  }

  setSettings(settings: OverlaySettings): void {
    this.settings = settings;
    this.lastBox = null;
    this.lastFitKey = '';
    this.follow();
  }

  /** The dragged position for this site, or null for the default. */
  setOffset(offset: CaptionOffset | null): void {
    if (this.drag) return;
    this.offset = offset ? clampOffset(offset) : null;
    this.follow();
  }

  applyCue(cue: Cue): void {
    const media = this.media;
    if (cue.origin === 'lookahead') {
      media?.add(cue);
      this.mediaNext = null;
      this.refresh();
      return;
    }
    // A live line lookahead (or an earlier pass) already has isn't shown again.
    const placed = media ? this.placeLive(cue) : null;
    if (media && placed && !media.addLive(cue, placed)) return;
    this.store.apply(cue, Date.now());
    this.refresh();
  }

  reset(): void {
    this.store.reset();
    this.media?.reset();
    this.refresh();
  }

  /**
   * Lookahead runs in this session: cues on the video's timeline are shown by its playhead, which
   * the session is told about. `lagS`: how long after the page plays a moment it is heard.
   */
  setLookahead(lagS: number): void {
    this.lagS = Number.isFinite(lagS) ? Math.max(0, Math.min(1, lagS)) : 0;
    if (this.media) return;
    this.media = new MediaCues();
    for (const type of PLAYHEAD_EVENTS) {
      this.doc.addEventListener(type, this.onPlayheadEvent, { capture: true, passive: true });
    }
    this.reportPlayhead(true);
    this.mediaLoop();
  }

  /** Where lookahead has finished subtitles on `key`. */
  setCoverage(key: string, spans: readonly Span[]): void {
    this.media?.setCoverage(key, spans);
    this.mediaNext = null;
    this.refresh();
  }

  /** Lookahead cues of `key` from `[start, end)` are void. */
  dropCues(key: string, start: number, end: number): void {
    this.media?.drop(key, start, end);
    this.mediaNext = null;
    this.refresh();
  }

  /** Session status from the offscreen document, shown as a small chip on the picture. */
  setStatus(status: OverlayStatus): void {
    this.win.clearTimeout(this.chipTimer);
    this.chip = chipFor(status);
    // Errors say their piece, then get out of the way.
    if (status.state === 'error') {
      this.chipTimer = this.win.setTimeout(() => {
        this.chip = null;
        this.follow();
      }, 8000);
    }
    this.follow();
  }

  /** Whether a frame inside this one has a video (the session says, for the top frame). */
  setVideoInFrame(present: boolean): void {
    if (present === this.videoInFrame) return;
    this.videoInFrame = present;
    this.lastBox = null;
    this.follow();
  }

  /** The video the overlay follows (tests, debugging). */
  get target(): HTMLVideoElement | null {
    return this.video;
  }

  // -------------------------------------------------------------------------------------------

  private readonly schedule = (): void => {
    if (this.destroyed || this.frame) return;
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = 0;
      this.follow();
    });
  };

  private readonly onPlay = (): void => this.repick();

  private readonly onPointer = (e: PointerEvent): void => {
    const box = this.layoutNow?.box;
    if (!box) return;
    if (
      e.clientX >= box.left &&
      e.clientX <= box.left + box.width &&
      e.clientY >= box.top &&
      e.clientY <= box.top + box.height
    ) {
      this.lastPointer = Date.now();
      this.schedule();
    }
  };

  private readonly onFullscreen = (): void => {
    const fs = this.doc.fullscreenElement;
    if (fs && canHoldOverlay(fs, this.video)) {
      this.view.setPopover(false);
      this.view.mount(fs);
    } else if (fs) {
      // Children of an iframe or a video aren't drawn, nor light-DOM children of a shadow
      // host: go above the fullscreen element in the top layer instead.
      this.view.mount(this.doc.documentElement);
      this.view.setPopover(true);
    } else {
      this.view.setPopover(false);
      this.view.mount(this.doc.documentElement);
    }
    this.lastBox = null;
    this.schedule();
  };

  /** Re-picks the video and re-attaches the host if the page removed it. */
  private repick(): void {
    if (this.destroyed) return;
    const videos = this.finder.videos();
    const viewport = this.viewport();
    const best = pickBest(videos.map(describeVideo), viewport);
    const next = best >= 0 ? (videos[best] ?? null) : this.video?.isConnected ? this.video : null;
    if (next !== this.video) {
      const had = this.video !== null;
      if (this.video) this.resize.unobserve(this.video);
      this.video = next;
      if (next) this.resize.observe(next);
      this.onFullscreen();
      if (had !== (next !== null)) this.hooks.onVideo?.(next !== null);
    }
    this.sameOriginVideo = !next && this.win === this.win.top && this.sameOriginFrameHasVideo();
    if (!this.view.host.isConnected) this.onFullscreen();
    this.schedule();
    this.reportPlayhead(false);
    if (this.media && this.video && !this.video.paused) this.mediaLoop();
  }

  /** Recomputes what to show and draws it. */
  private refresh(): void {
    if (this.destroyed) return;
    if (!this.fit) {
      // No layout yet: work out the fit first (follow() calls back here).
      this.follow();
      if (!this.fit) return;
    }
    const now = Date.now();
    const s = this.settings;
    const view: ViewOptions = {
      display: s.display,
      showPartials: s.showPartials,
      originalPlacement: s.originalPlacement,
      languageTags: s.languageTags,
      showOriginal: this.showOriginal,
      fit: this.fit,
      fitKey: this.lastFitKey,
    };
    const blocks = this.mediaBlocks(now, view) ?? this.store.visible(now, view);
    const shown = blocks.length > 0;
    const signature = JSON.stringify(blocks) + this.lastFitKey;
    if (signature !== this.lastRender) {
      this.lastRender = signature;
      this.view.render(blocks, {
        main: this.fit.main.maxWidth ?? 0,
        original: this.fit.original.maxWidth ?? 0,
      });
    }
    if (shown !== this.shown) {
      this.shown = shown;
      this.follow();
    }
    this.win.clearTimeout(this.timer);
    const next = this.store.nextChange(now);
    if (next !== null) this.timer = this.win.setTimeout(() => this.refresh(), next - now + 16);
  }

  /**
   * Lookahead's blocks at the playhead, or null to show the live ones. Where lookahead has
   * finished subtitles only its cues show; elsewhere live lines show, and kept cues fill in when
   * there are none (after a seek back, say).
   */
  private mediaBlocks(now: number, view: ViewOptions): CaptionBlock[] | null {
    const media = this.media;
    const video = this.video;
    const timeline = media && video ? this.currentTimeline() : null;
    if (!media || !video || !timeline || timeline.ad) {
      this.mediaT = null;
      return null;
    }
    const t = video.currentTime - this.lagS;
    this.clock.record(
      epochNow(),
      video.currentTime,
      video.playbackRate,
      video.paused,
      timeline.key,
    );
    media.advance(timeline.key, t);
    this.mediaT = t;
    this.mediaNext = media.nextEvent(timeline.key, t);
    if (media.covered(timeline.key, t)) return media.visible(t, view);
    const live = this.store.visible(now, view);
    return live.length > 0 ? live : media.visible(t, view);
  }

  /** A live cue's place on the followed video's timeline, from when it was heard. */
  private placeLive(cue: Cue): { timeline: string; start: number; end: number } | null {
    const timeline = this.video ? this.currentTimeline() : null;
    if (!timeline || timeline.ad) return null;
    const start = this.clock.toMedia(cue.startEpochMs, timeline.key);
    const end = this.clock.toMedia(cue.endEpochMs, timeline.key);
    if (start === null || end === null || end < start) return null;
    return { timeline: timeline.key, start: start - this.lagS, end: end - this.lagS };
  }

  private currentTimeline(): VideoTimeline | null {
    const video = this.video;
    if (!video || !this.hooks.timelineOf) return null;
    try {
      return this.hooks.timelineOf(video);
    } catch {
      return null;
    }
  }

  private readonly onPlayheadEvent = (e: Event): void => {
    if (e.target !== this.video) return;
    this.reportPlayhead(e.type !== 'timeupdate');
    if (e.type === 'play') this.mediaLoop();
    this.mediaTick();
  };

  /** Each animation frame while the video plays: redraw when the picture should change. */
  private mediaLoop(): void {
    if (this.destroyed || !this.media || this.mediaFrame) return;
    this.mediaFrame = this.win.requestAnimationFrame(() => {
      this.mediaFrame = 0;
      this.mediaTick();
      if (this.video && !this.video.paused) this.mediaLoop();
    });
  }

  private mediaTick(): void {
    const video = this.video;
    if (!this.media || !video) return;
    const t = video.currentTime - this.lagS;
    const last = this.mediaT;
    const due =
      last === null ||
      t < last - 0.05 ||
      t - last > JUMP_S ||
      (this.mediaNext !== null && t >= this.mediaNext);
    if (due) this.refresh();
  }

  /** Tells the session where the video is: on events at once, else about once a second. */
  private reportPlayhead(force: boolean): void {
    const send = this.hooks.onPlayhead;
    const video = this.video;
    if (!send || !this.media) return;
    const now = epochNow();
    if (!force && now - this.lastReportAt < 1000) return;
    const timeline = video ? this.currentTimeline() : null;
    const report: PlayheadReport = {
      timeline: timeline?.timeline ?? null,
      key: timeline?.key ?? null,
      ad: timeline?.ad ?? false,
      time: video?.currentTime ?? 0,
      rate: video?.playbackRate ?? 1,
      paused: video ? video.paused || video.readyState < 3 : true,
      at: now,
    };
    const signature = `${report.timeline}|${report.key}|${report.ad}|${report.paused}|${report.rate}`;
    if (!force && signature === this.lastReport && now - this.lastReportAt < 1000) return;
    this.lastReport = signature;
    this.lastReportAt = now;
    send(report);
  }

  /** Keeps the view over the picture and clear of the controls. */
  private follow(): void {
    if (this.destroyed) return;
    const needed = this.shown || this.chip !== null || !this.fit;
    const layout = needed ? this.layout() : null;
    this.layoutNow = layout;
    // May refresh (and so change what's shown) when the fit changes.
    if (layout) this.updateFit(layout);

    const visible = this.shown || this.chip !== null;
    if (!visible) {
      if (this.lastBox) this.view.layout(null, this.style(null));
      this.lastBox = null;
      this.lastStyle = '';
      this.view.status(null);
      return;
    }
    const style = this.style(layout);
    const styleKey = JSON.stringify(style);
    if (rectChanged(layout?.box ?? null, this.lastBox) || !layout || styleKey !== this.lastStyle) {
      this.view.layout(layout, style);
      this.lastBox = layout?.box ?? null;
      this.lastStyle = styleKey;
    }
    this.view.status(this.chip);
    // Check the player's place now and then while something is on screen.
    this.win.clearTimeout(this.poll);
    if (layout) this.poll = this.win.setTimeout(this.schedule, FOLLOW_MS);
  }

  /** Line fitting for this layout; re-renders when it changes. */
  private updateFit(layout: CaptionLayout): void {
    // The stack's side margins leave 92% of the picture for text.
    const width = layout.box.width * STACK_WIDTH;
    const showOriginal = layout.picture.height >= MIN_HEIGHT_FOR_ORIGINAL;
    const key = `${Math.round(width)}:${layout.fontPx}:${showOriginal}`;
    if (key === this.lastFitKey) return;
    this.lastFitKey = key;
    this.showOriginal = showOriginal;
    this.fit = fitFor(this.doc, width, layout.fontPx);
    this.refresh();
  }

  private style(layout: CaptionLayout | null): ViewStyle {
    const s = this.settings;
    const offset = this.drag?.current ?? this.offset;
    const base: ViewStyle = {
      position: offset ? 'custom' : s.position,
      background: s.background,
      backgroundOpacity: s.backgroundOpacity,
      anchorY: offset?.y ?? 0.95,
      shiftX: 0,
      lift: 0,
    };
    if (!layout) return base;
    const box = layout.box;
    if (offset) {
      // Keep the widest block inside the picture.
      const room = Math.max(0, (box.width * STACK_WIDTH - this.view.contentWidth()) / 2);
      base.shiftX = Math.max(-room, Math.min(room, (offset.x - 0.5) * box.width));
    }
    base.lift = this.drag ? this.lift : this.computeLift(layout, base);
    this.lift = base.lift;
    return base;
  }

  /** Px to move up so the player's controls and captions don't cover the subtitles. */
  private computeLift(layout: CaptionLayout, style: ViewStyle): number {
    if (!this.settings.avoidControls || style.position === 'top') return 0;
    const rect = this.view.stackRect();
    if (!rect) return 0;
    const subs = rect;
    const box = layout.box;
    const obstacles: { top: number; bottom: number }[] = [];
    const gap = Math.round(layout.fontPx * 0.3);
    const video = this.video;
    const player = this.adapter && video ? video.closest(this.adapter.player) : null;

    if (this.adapter && player) {
      const a = this.adapter;
      const hidden = a.controlsHiddenClass && player.classList.contains(a.controlsHiddenClass);
      if (a.controls && !hidden) {
        const el = player.querySelector(a.controls);
        if (el) obstacles.push(el.getBoundingClientRect());
      }
      if (a.captions) {
        for (const el of player.querySelectorAll(a.captions)) {
          const r = el.getBoundingClientRect();
          if (r.height > 0 && (el.textContent ?? '').trim()) obstacles.push(r);
        }
      }
    } else {
      // Generic: controls show while the pointer moves over the player, or it's paused.
      const active = Date.now() - this.lastPointer < POINTER_IDLE_MS;
      const paused = !!video && video.paused && !video.ended && video.readyState >= 2;
      if (active || paused) {
        const bar = Math.round(Math.min(76, Math.max(40, box.height * 0.12)));
        obstacles.push({ top: box.top + box.height - bar, bottom: box.top + box.height });
      }
      // The browser's own captions on a `<track>`.
      if (video && hasShowingCues(video)) {
        const band = box.height * 0.16;
        obstacles.push({ top: box.top + box.height - band, bottom: box.top + box.height });
      }
    }
    return liftToClear(subs, obstacles, gap);
  }

  private dragStart(e: PointerEvent): void {
    const layout = this.layoutNow;
    const rect = this.view.stackRect();
    if (!layout || !rect) return;
    const box = layout.box;
    const from = this.offset ?? { x: 0.5, y: (rect.bottom - box.top) / box.height };
    this.drag = { x: e.clientX, y: e.clientY, from, current: from };
    this.view.setDragging(true);
  }

  private dragMove(e: PointerEvent): void {
    const drag = this.drag;
    const box = this.layoutNow?.box;
    if (!drag || !box) return;
    drag.current = clampOffset({
      x: drag.from.x + (e.clientX - drag.x) / box.width,
      y: drag.from.y + (e.clientY - drag.y) / box.height,
    });
    this.follow();
  }

  private dragEnd(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.view.setDragging(false);
    const moved = drag.current.x !== drag.from.x || drag.current.y !== drag.from.y;
    if (moved) {
      this.offset = drag.current;
      this.hooks.onPositionChange?.(drag.current);
    }
    this.follow();
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
    } else if (this.win === this.win.top && !this.videoInFrame && !this.sameOriginVideo) {
      // No video here or in a frame with its own overlay (audio-only page, or a player in a
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

function epochNow(): number {
  return performance.timeOrigin + performance.now();
}

function hasShowingCues(video: HTMLVideoElement): boolean {
  for (const track of video.textTracks) {
    if (track.mode === 'showing' && (track.activeCues?.length ?? 0) > 0) return true;
  }
  return false;
}

/** The chip to show on the picture for a session status, or null when all is well. */
export function chipFor(status: OverlayStatus): StatusChip | null {
  switch (status.state) {
    case 'loading':
      return { tone: 'busy', text: status.detail, progress: status.progress };
    case 'running':
      return status.behindMs !== null
        ? { tone: 'warn', text: `Subtitles are ${Math.round(status.behindMs / 1000)} s behind` }
        : null;
    case 'error':
      return { tone: 'error', text: status.message };
  }
}
