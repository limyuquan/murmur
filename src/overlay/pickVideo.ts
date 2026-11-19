/**
 * Which `<video>` gets the subtitles: the playing one with the most area on screen. Scoring is
 * pure; finding videos walks open shadow roots too (many players are web components).
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
