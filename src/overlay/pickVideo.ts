/**
 * Which `<video>` gets the subtitles: the playing one with the most area on screen. Scoring is
 * pure; finding videos looks in open shadow roots too (many players are web components).
 */
import { intersect, type Rect, type Size } from './geometry';

export interface VideoCandidate {
  /** Element box in viewport coordinates. */
  rect: Rect;
  playing: boolean;
  /** HTMLMediaElement.readyState. */
  readyState: number;
}

/** Visible area under this doesn't count (ads, thumbnails, previews). */
const MIN_VISIBLE_AREA = 120 * 68;

export function scoreVideo(c: VideoCandidate, viewport: Size): number {
  const visible = intersect(c.rect, { left: 0, top: 0, ...viewport });
  const area = visible ? visible.width * visible.height : 0;
  if (area < MIN_VISIBLE_AREA) return 0;
  return area * (c.playing ? 4 : 1) * (c.readyState >= 2 ? 1 : 0.5);
}

/** Index of the best candidate, or -1 when none qualifies. */
export function pickBest(candidates: readonly VideoCandidate[], viewport: Size): number {
  let best = -1;
  let bestScore = 0;
  candidates.forEach((c, i) => {
    const score = scoreVideo(c, viewport);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

/** Every `<video>` under `root`, including inside open shadow roots. */
export function findVideos(root: Document | ShadowRoot): HTMLVideoElement[] {
  const out: HTMLVideoElement[] = [...root.querySelectorAll('video')];
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) out.push(...findVideos(el.shadowRoot));
  }
  return out;
}

export function describeVideo(video: HTMLVideoElement): VideoCandidate {
  const r = video.getBoundingClientRect();
  return {
    rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    playing: !video.paused && !video.ended && video.readyState > 2,
    readyState: video.readyState,
  };
}

/**
 * Finds the videos of a document, including in open shadow roots, without walking every element
 * each time: the shadow roots are found once, then as nodes are added (a MutationObserver), with
 * a full walk only every `fullScanMs` for roots attached to elements already in the page.
 */
export class VideoFinder {
  private readonly roots = new Set<ShadowRoot>();
  private readonly observer: MutationObserver;
  private lastFullScan = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly doc: Document,
    private readonly fullScanMs = 10_000,
  ) {
    this.observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1) this.collect(node as Element);
        }
      }
    });
    this.observer.observe(doc, { childList: true, subtree: true });
  }

  videos(now = Date.now()): HTMLVideoElement[] {
    if (now - this.lastFullScan >= this.fullScanMs) {
      this.lastFullScan = now;
      if (this.doc.documentElement) this.collect(this.doc.documentElement);
    }
    const out: HTMLVideoElement[] = [...this.doc.querySelectorAll('video')];
    for (const root of this.roots) {
      if (!root.host.isConnected) {
        this.roots.delete(root);
        continue;
      }
      out.push(...root.querySelectorAll('video'));
    }
    return out;
  }

  disconnect(): void {
    this.observer.disconnect();
    this.roots.clear();
  }

  /** Notes the open shadow roots in `el`'s subtree (and theirs). */
  private collect(el: Element): void {
    this.visit(el);
    for (const child of el.querySelectorAll('*')) this.visit(child);
  }

  private visit(el: Element): void {
    const root = el.shadowRoot;
    if (!root || this.roots.has(root)) return;
    this.roots.add(root);
    this.observer.observe(root, { childList: true, subtree: true });
    for (const child of root.querySelectorAll('*')) this.visit(child);
  }
}
