import { describe, expect, it } from 'vitest';
import {
  captionLayout,
  intersect,
  parseObjectFit,
  pictureRect,
  rectChanged,
} from '@/overlay/geometry';
import { pickBest, scoreVideo } from '@/overlay/pickVideo';

const box = { left: 100, top: 50, width: 800, height: 600 };
const wide = { width: 1920, height: 1080 };

describe('pictureRect', () => {
  it('letterboxes a 16:9 video in a 4:3 box (contain)', () => {
    expect(pictureRect(box, wide, 'contain')).toEqual({
      left: 100,
      top: 125,
      width: 800,
      height: 450,
    });
  });

  it('pillarboxes a 4:3 video in a 16:9 box', () => {
    const r = pictureRect(
      { left: 0, top: 0, width: 1600, height: 900 },
      { width: 640, height: 480 },
      'contain',
    );
    expect(r).toEqual({ left: 200, top: 0, width: 1200, height: 900 });
  });

  it('fills the box for cover and fill', () => {
    expect(pictureRect(box, wide, 'cover')).toEqual(box);
    expect(pictureRect(box, wide, 'fill')).toEqual(box);
  });

  it('centres native size for none, clipped to the box', () => {
    expect(pictureRect(box, { width: 400, height: 300 }, 'none')).toEqual({
      left: 300,
      top: 200,
      width: 400,
      height: 300,
    });
    expect(pictureRect(box, wide, 'none')).toEqual(box);
  });

  it('scale-down never enlarges', () => {
    expect(pictureRect(box, { width: 400, height: 300 }, 'scale-down')).toEqual({
      left: 300,
      top: 200,
      width: 400,
      height: 300,
    });
    expect(pictureRect(box, wide, 'scale-down')).toEqual(pictureRect(box, wide, 'contain'));
  });

  it('uses the whole box before metadata loads', () => {
    expect(pictureRect(box, { width: 0, height: 0 }, 'contain')).toEqual(box);
  });

  it('parses object-fit with contain as the default', () => {
    expect(parseObjectFit('cover')).toBe('cover');
    expect(parseObjectFit('')).toBe('contain');
    expect(parseObjectFit('inherit')).toBe('contain');
  });
});

describe('captionLayout', () => {
  const viewport = { width: 1280, height: 800 };

  it('covers the visible picture and sizes text from its height', () => {
    const picture = { left: 100, top: 125, width: 800, height: 450 };
    expect(captionLayout(picture, viewport, { fontScale: 1 })).toEqual({
      box: picture,
      fontPx: 20,
      marginPx: 23,
    });
    expect(captionLayout(picture, viewport, { fontScale: 2 })?.fontPx).toBe(41);
  });

  it('clips to the viewport but keeps the size of the whole picture', () => {
    const picture = { left: 0, top: 500, width: 1280, height: 720 };
    const layout = captionLayout(picture, viewport, { fontScale: 1 });
    expect(layout?.box).toEqual({ left: 0, top: 500, width: 1280, height: 300 });
    expect(layout?.fontPx).toBe(32);
  });

  it('clamps font size for tiny and huge pictures', () => {
    expect(
      captionLayout({ left: 0, top: 0, width: 200, height: 120 }, viewport, { fontScale: 1 })
        ?.fontPx,
    ).toBe(14);
    expect(
      captionLayout({ left: 0, top: 0, width: 4000, height: 3000 }, viewport, { fontScale: 2 })
        ?.fontPx,
    ).toBe(64);
  });

  it('shows nothing when too little is on screen', () => {
    expect(
      captionLayout({ left: 0, top: 790, width: 1280, height: 720 }, viewport, { fontScale: 1 }),
    ).toBeNull();
    expect(
      captionLayout({ left: 0, top: 900, width: 1280, height: 720 }, viewport, { fontScale: 1 }),
    ).toBeNull();
  });
});

describe('rect helpers', () => {
  it('intersects', () => {
    expect(intersect(box, { left: 0, top: 0, width: 200, height: 100 })).toEqual({
      left: 100,
      top: 50,
      width: 100,
      height: 50,
    });
    expect(intersect(box, { left: 0, top: 0, width: 50, height: 50 })).toBeNull();
  });

  it('detects changes beyond half a pixel', () => {
    expect(rectChanged(box, { ...box, left: 100.3 })).toBe(false);
    expect(rectChanged(box, { ...box, width: 802 })).toBe(true);
    expect(rectChanged(null, box)).toBe(true);
    expect(rectChanged(null, null)).toBe(false);
  });
});

describe('picking the video', () => {
  const viewport = { width: 1280, height: 800 };
  const big = { left: 0, top: 0, width: 960, height: 540 };
  const small = { left: 0, top: 600, width: 320, height: 180 };

  it('prefers the playing video, then the bigger one', () => {
    expect(
      pickBest(
        [
          { rect: big, playing: false, readyState: 4 },
          { rect: small, playing: true, readyState: 4 },
        ],
        viewport,
      ),
    ).toBe(0);
    expect(
      pickBest(
        [
          { rect: { ...big, width: 400, height: 225 }, playing: false, readyState: 4 },
          { rect: small, playing: true, readyState: 4 },
        ],
        viewport,
      ),
    ).toBe(1);
  });

  it('ignores off-screen and thumbnail-sized videos', () => {
    expect(scoreVideo({ rect: { ...big, top: 900 }, playing: true, readyState: 4 }, viewport)).toBe(
      0,
    );
    expect(
      scoreVideo(
        { rect: { left: 0, top: 0, width: 100, height: 56 }, playing: true, readyState: 4 },
        viewport,
      ),
    ).toBe(0);
    expect(pickBest([], viewport)).toBe(-1);
  });
});
