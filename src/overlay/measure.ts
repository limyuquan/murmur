/** Measures text as the overlay draws it, with a canvas in the same font. */
import type { RoleFit } from './captions';
import { MAX_LINE_UNITS, type Measure } from './linebreak';
import { FONT_STACK, MAIN_WEIGHT, ORIGINAL_MIN_PX, ORIGINAL_SCALE } from './styles';

/** Widths kept per measurer. */
const MEASURE_CACHE = 20_000;

export function createMeasurer(doc: Document, px: number, weight: number): Measure | undefined {
  const ctx = doc.createElement('canvas').getContext('2d');
  if (!ctx) return undefined;
  const font = `${weight} ${px}px ${FONT_STACK}`;
  const cache = new Map<string, number>();
  return (text) => {
    let w = cache.get(text);
    if (w === undefined) {
      ctx.font = font;
      w = ctx.measureText(text).width;
      // Paging a long line measures many thousands of candidate rows.
      if (cache.size > MEASURE_CACHE) cache.clear();
      cache.set(text, w);
    }
    return w;
  };
}

/** Line fitting for both roles, for subtitles `widthPx` wide with a main line of `mainPx`. */
export function fitFor(
  doc: Document,
  widthPx: number,
  mainPx: number,
): { main: RoleFit; original: RoleFit } {
  const originalPx = Math.max(ORIGINAL_MIN_PX, mainPx * ORIGINAL_SCALE);
  const role = (px: number, weight: number): RoleFit => {
    // Room for the box padding on each side (0.4 em, styles.ts), and a little to spare.
    const fit: RoleFit = { maxUnits: MAX_LINE_UNITS, maxWidth: widthPx - px * 0.9 };
    const measure = createMeasurer(doc, px, weight);
    if (measure) fit.measure = measure;
    return fit;
  };
  return { main: role(mainPx, MAIN_WEIGHT), original: role(originalPx, 400) };
}
