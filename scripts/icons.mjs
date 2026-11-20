/**
 * Renders the icon to public/icon/{16,32,48,128}.png with headless Chromium. 16 and 32 px come
 * from assets/icon-16.svg (redrawn on a 16-px grid, whole-pixel strokes), 48 and 128 px from
 * assets/icon.svg. Run after editing either SVG: `pnpm icons`. The PNGs are committed.
 * 128 px is the install icon: 96 px of art in 16 px of transparent padding, as Chrome's icon
 * guidelines ask. The toolbar sizes use the full square.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const SIZES = [16, 32, 48, 128];
const PADDING = { 128: 16 };
const read = (name) => readFileSync(new URL(`../assets/${name}`, import.meta.url), 'utf8');
const SMALL = read('icon-16.svg');
const LARGE = read('icon.svg');
const svgFor = (size) => (size <= 32 ? SMALL : LARGE);

// No GPU: canvas 2D in headless Chromium can hang on machines with a half-working GPU stack
// (seen under WSL); software rendering is all this needs.
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-gpu', '--disable-software-rasterizer'],
});
try {
  const page = await browser.newPage();
  const pngs = await page.evaluate(
    async ({ sizes }) => {
      const out = [];
      for (const [size, pad, svg] of sizes) {
        const img = new Image();
        img.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        canvas.getContext('2d').drawImage(img, pad, pad, size - 2 * pad, size - 2 * pad);
        out.push(canvas.toDataURL('image/png').split(',')[1]);
      }
      return out;
    },
    { sizes: SIZES.map((size) => [size, PADDING[size] ?? 0, svgFor(size)]) },
  );
  SIZES.forEach((size, i) => {
    const out = new URL(`../public/icon/${size}.png`, import.meta.url);
    writeFileSync(out, Buffer.from(pngs[i], 'base64'));
    console.log(`public/icon/${size}.png`);
  });
} finally {
  await browser.close();
}
