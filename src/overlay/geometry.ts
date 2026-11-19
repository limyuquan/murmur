/**
 * Overlay positioning math, pure. The overlay sits over the part of the video that shows picture
 * (not the letterbox bars) and that is on screen, and sizes text from the picture's height, the
 * way TV subtitles scale with the screen.
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export type ObjectFit = 'contain' | 'cover' | 'fill' | 'none' | 'scale-down';

export function parseObjectFit(value: string): ObjectFit {
  return value === 'cover' || value === 'fill' || value === 'none' || value === 'scale-down'
    ? value
    : 'contain';
}

/** Overlap of two rects, or null when they don't overlap. */
export function intersect(a: Rect, b: Rect): Rect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Where the picture is drawn inside a `<video>` element's box, for its `object-fit` (centred, the
 * default `object-position`). Clipped to the box: for `cover` that's the whole box. Unknown video
 * size (metadata not loaded) → the whole box.
 */
export function pictureRect(box: Rect, video: Size, fit: ObjectFit): Rect {
  if (video.width <= 0 || video.height <= 0 || box.width <= 0 || box.height <= 0) return box;
  let scale: number;
  switch (fit) {
    case 'fill':
      return box;
    case 'cover':
      scale = Math.max(box.width / video.width, box.height / video.height);
      break;
    case 'none':
      scale = 1;
      break;
    case 'scale-down':
      scale = Math.min(1, box.width / video.width, box.height / video.height);
      break;
    case 'contain':
      scale = Math.min(box.width / video.width, box.height / video.height);
      break;
  }
  const width = video.width * scale;
  const height = video.height * scale;
  const drawn = {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
  return intersect(drawn, box) ?? box;
}

export interface CaptionLayout {
  /** The overlay's box in viewport coordinates: the visible part of the picture. */
  box: Rect;
  /** The whole picture, visible or not. */
  picture: Rect;
  /** Font size of the main (translation) line, px. The original line is ~70% of it. */
  fontPx: number;
  /** Gap between the captions and the box's bottom (or top) edge, px. */
  marginPx: number;
}

export interface LayoutOptions {
  fontScale: number;
}

/** Captions this small are unreadable; don't draw them over a thumbnail-sized video. */
export const MIN_PICTURE = { width: 120, height: 68 };

/**
 * Lays captions out over `picture`, clipped to the viewport. Null when too little of it is
 * visible to show captions.
 */
export function captionLayout(
  picture: Rect,
  viewport: Size,
  options: LayoutOptions,
): CaptionLayout | null {
  const box = intersect(picture, { left: 0, top: 0, ...viewport });
  if (!box || box.width < MIN_PICTURE.width || box.height < MIN_PICTURE.height) return null;
  // Size from the whole picture (not the clipped part), so scrolling doesn't resize text.
  const base = picture.height * 0.045 * options.fontScale;
  const fontPx = Math.round(Math.min(64, Math.max(14, base)));
  const marginPx = Math.round(Math.max(8, Math.min(48, picture.height * 0.05)));
  return { box, picture, fontPx, marginPx };
}

/** True when two rects differ by more than `epsilon` px on any edge. */
export function rectChanged(a: Rect | null, b: Rect | null, epsilon = 0.5): boolean {
  if (!a || !b) return a !== b;
  return (
    Math.abs(a.left - b.left) > epsilon ||
    Math.abs(a.top - b.top) > epsilon ||
    Math.abs(a.width - b.width) > epsilon ||
    Math.abs(a.height - b.height) > epsilon
  );
}
