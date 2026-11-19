/**
 * The whole path with the demo engines: test tone → offscreen capture graph → worklet (16 kHz) →
 * segmenter → echo ASR → passthrough translation → overlay port → subtitles over the page's video.
 */
import { EXTENSION_ID } from '@/shared/ids';
import { expect, test } from './fixtures';

/** The video's picture (letterboxed 16:9 inside a 640×480 box at 40,40). */
const PICTURE = { x: 40, y: 100, width: 640, height: 360 };

test('subtitles attach over the video picture, follow it, and go away on stop', async ({
  murmur,
}) => {
  const page = await murmur.open('video.html');
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return !!v && v.readyState >= 2 && v.videoWidth > 0;
  });

  await murmur.start(page);
  await expect.poll(async () => (await murmur.status()).state).toBe('running');

  const host = page.locator('murmur-overlay');
  await expect(host).toHaveCount(1);
  // The echo engine's text, through the passthrough translator: original and translation lines.
  const main = host.locator('.line[data-role="main"]').first();
  await expect(main).toContainText(/\[en\] Sound \d/, { timeout: 15_000 });
  await expect(host.locator('.line[data-role="original"]').first()).toContainText(/^Sound \d/);

  // Over the picture, not the letterbox bars.
  const box = await host.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x).toBeCloseTo(PICTURE.x, 0);
  expect(box?.y).toBeCloseTo(PICTURE.y, 0);
  expect(box?.width).toBeCloseTo(PICTURE.width, 0);
  expect(box?.height).toBeCloseTo(PICTURE.height, 0);

  // Follows a resize of the player (fill the box: no bars).
  await page.evaluate(() => {
    const v = document.querySelector('video') as HTMLVideoElement;
    v.style.width = '800px';
    v.style.height = '450px';
  });
  await expect.poll(async () => (await host.boundingBox())?.height ?? 0).toBeCloseTo(450, 0);

  // Follows scrolling.
  await page.mouse.wheel(0, 30);
  await expect.poll(async () => (await host.boundingBox())?.y ?? 0).toBeCloseTo(40 - 30, 0);

  // The popup shows the running session on this tab.
  const tabId = await murmur.tabId(page);
  const popup = await page.context().newPage();
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html?tab=${tabId}`);
  await expect(popup.getByTestId('toggle')).toHaveAttribute('aria-checked', 'true');
  await expect(popup.getByTestId('status')).toHaveText(/^(Listening|Transcribing|Translating)/);

  // Switching off from the popup ends the session; the overlay removes itself.
  await popup.getByTestId('toggle').click();
  await expect(popup.getByTestId('toggle')).toHaveAttribute('aria-checked', 'false');
  await expect(popup.getByTestId('status')).toHaveText(/^Off/);
  await expect(host).toHaveCount(0);
  expect((await murmur.status()).state).toBe('idle');
});

test('the overlay is injected once per frame, however often it is started', async ({ murmur }) => {
  const page = await murmur.open('video.html');
  await murmur.start(page);
  await murmur.start(page);
  await expect.poll(async () => (await murmur.status()).state).toBe('running');
  await expect(page.locator('murmur-overlay')).toHaveCount(1);
  await murmur.stop();
  await expect(page.locator('murmur-overlay')).toHaveCount(0);
});
