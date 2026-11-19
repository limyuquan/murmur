/**
 * Players inside frames from another site and inside web components (shadow roots): subtitles
 * show once, over the player, and stay visible in fullscreen (where the top layer hides anything
 * outside the fullscreen element, and children of an iframe or a shadow host aren't drawn).
 */
import type { Frame, Page } from '@playwright/test';
import type { E2eCommand } from '@/overlay';
import type { Cue } from '@/pipeline/types';
import { expect, test } from './fixtures';

async function send(target: Page | Frame, command: E2eCommand): Promise<void> {
  await target.evaluate(
    (detail) => document.dispatchEvent(new CustomEvent('murmur-e2e', { detail })),
    JSON.stringify(command),
  );
}

/** A cue whose translation is still changing: it stays as long as a test needs. */
function lasting(id: string): Cue {
  return {
    id,
    seq: 1,
    startEpochMs: Date.now() - 2000,
    endEpochMs: Date.now() - 500,
    source: { text: `Ligne ${id}`, language: 'fr', final: true },
    translation: { text: `Line ${id}`, language: 'en', final: false },
    untranslated: null,
  };
}

/** The page's frame from the other origin (the fixture server's second port). */
async function embedded(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().length).toBeGreaterThan(1);
  const frame = page.frames().find((f) => f !== page.mainFrame());
  if (!frame) throw new Error('No frame');
  await frame.waitForLoadState();
  return frame;
}

const viewportWidth = (page: Page) => page.viewportSize()?.width ?? 0;

test('a player in a frame from another site: subtitles once, over it, in fullscreen too', async ({
  murmur,
}) => {
  const page = await murmur.open('frames.html?src=player.html');
  const frame = await embedded(page);
  await frame.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2);
  await murmur.start(page);
  const inFrame = frame.locator('murmur-overlay');
  const onTop = page.locator('murmur-overlay');
  await expect(inFrame).toHaveCount(1);
  await expect(onTop).toHaveCount(1);
  for (const target of [page, frame]) {
    await send(target, { hold: true });
    await send(target, { cue: lasting('a') });
  }
  // The frame's overlay shows them over its player; the top frame's stays out of the way.
  await expect(inFrame.locator('.line[data-role="main"]')).toBeVisible();
  await expect(onTop).toBeHidden();

  await frame.click('#fs-player');
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null))
    .toBe('frame');
  await expect
    .poll(() => frame.evaluate(() => document.querySelector('murmur-overlay')?.parentElement?.id))
    .toBe('player');
  await expect(inFrame.locator('.line[data-role="main"]')).toBeVisible();
  await expect
    .poll(async () => (await inFrame.boundingBox())?.width ?? 0)
    .toBeCloseTo(viewportWidth(page), 0);
  // Never inside the fullscreen iframe element, where it would not be drawn.
  expect(await page.evaluate(() => document.querySelector('iframe murmur-overlay'))).toBeNull();
  await expect(onTop).toBeHidden();
});

test('a fullscreen frame with no player of ours: subtitles above it in the top layer', async ({
  murmur,
}) => {
  const page = await murmur.open('frames.html?src=frame-blank.html');
  const frame = await embedded(page);
  await murmur.start(page);
  const onTop = page.locator('murmur-overlay');
  await expect(onTop).toHaveCount(1);
  await send(page, { hold: true });
  await send(page, { cue: lasting('a') });
  // No video anywhere: the bottom of the window.
  await expect(onTop.locator('.line[data-role="main"]')).toBeVisible();

  await frame.click('#fs-frame');
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null))
    .toBe('frame');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const host = document.querySelector('murmur-overlay');
        return host?.matches(':popover-open') && host.parentElement === document.documentElement;
      }),
    )
    .toBe(true);
  await expect(onTop.locator('.line[data-role="main"]')).toBeVisible();
  await expect
    .poll(async () => (await onTop.boundingBox())?.width ?? 0)
    .toBeCloseTo(viewportWidth(page), 0);
});

test('a web-component player: over its video, and above it in fullscreen', async ({ murmur }) => {
  const page = await murmur.open('shadow.html');
  await murmur.start(page);
  const host = page.locator('murmur-overlay');
  await expect(host).toHaveCount(1);
  await send(page, { hold: true });
  await send(page, { cue: lasting('a') });
  await expect(host.locator('.line[data-role="main"]')).toBeVisible();

  for (const button of ['#fs-video', '#fs-host']) {
    await page.click(button);
    // The document only sees the shadow host as fullscreen.
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement?.localName ?? null))
      .toBe('shadow-player');
    await expect
      .poll(() =>
        page.evaluate(() => document.querySelector('murmur-overlay')?.matches(':popover-open')),
      )
      .toBe(true);
    await expect(host.locator('.line[data-role="main"]')).toBeVisible();
    await expect
      .poll(async () => (await host.boundingBox())?.width ?? 0)
      .toBeCloseTo(viewportWidth(page), 0);
    await page.evaluate(() => document.exitFullscreen());
    await expect
      .poll(() =>
        page.evaluate(() => document.querySelector('murmur-overlay')?.matches(':popover-open')),
      )
      .toBe(false);
  }
});

test('a player that appears later inside a web component is found', async ({ murmur }) => {
  const page = await murmur.open('shadow.html?late');
  await murmur.start(page);
  const host = page.locator('murmur-overlay');
  await expect(host).toHaveCount(1);
  await send(page, { hold: true });
  await send(page, { cue: lasting('a') });
  // Over the player (960×540 at 24,24) once it appears, not the bottom of the window.
  await expect
    .poll(async () => {
      const box = await host.boundingBox();
      return box && [box.x, box.y, box.width, box.height].map(Math.round);
    })
    .toEqual([24, 24, 960, 540]);
});
