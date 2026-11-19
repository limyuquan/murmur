/**
 * Real tab capture: stream ID minted by the service worker, opened by the offscreen document.
 * Headless Chromium renders no tab audio, so this checks the handshake and the session state;
 * the audio → subtitles path is covered with the test tone in overlay.spec.ts.
 */
import { expect, test } from './fixtures';

test('tab capture starts, shows on the tab, and stops when the tab closes', async ({ murmur }) => {
  const page = await murmur.open('video.html');
  const tabId = await murmur.start(page, 'tab');
  await expect.poll(async () => (await murmur.status()).state).toBe('running');
  expect(await murmur.status()).toMatchObject({ tabId });
  await expect(page.locator('murmur-overlay')).toHaveCount(1);

  await page.close();
  await expect.poll(async () => (await murmur.status()).state).toBe('idle');
});

test('a second tab takes over the session', async ({ murmur }) => {
  const first = await murmur.open('video.html');
  await murmur.start(first, 'tab');
  const second = await murmur.open('video.html?second');
  const secondId = await murmur.start(second, 'tab');
  await expect.poll(async () => (await murmur.status()).state).toBe('running');
  expect(await murmur.status()).toMatchObject({ tabId: secondId });
  await expect(first.locator('murmur-overlay')).toHaveCount(0);
  await expect(second.locator('murmur-overlay')).toHaveCount(1);
});
