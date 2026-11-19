/**
 * Real tab capture: stream ID minted by the service worker, opened by the offscreen document.
 * Headless Chromium renders no tab audio, so this checks the handshake and the session state;
 * the audio → subtitles path is covered with the test tone in overlay.spec.ts.
 */
import { expect, test } from './fixtures';

test('tab capture starts, shows on the tab, and stops when the tab closes', async ({ earshot }) => {
  const page = await earshot.open('video.html');
  const tabId = await earshot.start(page, 'tab');
  await expect.poll(async () => (await earshot.status()).state).toBe('running');
  expect(await earshot.status()).toMatchObject({ tabId });
  await expect(page.locator('earshot-overlay')).toHaveCount(1);

  await page.close();
  await expect.poll(async () => (await earshot.status()).state).toBe('idle');
});

test('a second tab takes over the session', async ({ earshot }) => {
  const first = await earshot.open('video.html');
  await earshot.start(first, 'tab');
  const second = await earshot.open('video.html?second');
  const secondId = await earshot.start(second, 'tab');
  await expect.poll(async () => (await earshot.status()).state).toBe('running');
  expect(await earshot.status()).toMatchObject({ tabId: secondId });
  await expect(first.locator('earshot-overlay')).toHaveCount(0);
  await expect(second.locator('earshot-overlay')).toHaveCount(1);
});
