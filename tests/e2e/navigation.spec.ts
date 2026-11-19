/**
 * The captured tab navigates: the subtitles follow to a page they can reach that has something
 * to subtitle; otherwise the session stops and says why.
 */
import { FIXTURE_ORIGIN } from '../../playwright.config';
import { expect, test } from './fixtures';

/** The same pages from another origin (the fixture server's next port). */
const OTHER_ORIGIN = FIXTURE_ORIGIN.replace(/:(\d+)$/, (_, p) => `:${Number(p) + 1}`);

test('subtitles follow to another site with a video', async ({ murmur }) => {
  const page = await murmur.open('video.html');
  await murmur.start(page);
  await expect.poll(async () => (await murmur.status()).state).toBe('running');
  await page.goto(`${OTHER_ORIGIN}/video.html`);
  await expect(page.locator('murmur-overlay')).toHaveCount(1);
  await expect(page.locator('murmur-overlay .line').first()).toBeAttached({ timeout: 15_000 });
  expect((await murmur.status()).state).toBe('running');
});

test('the session stops on another site with nothing to subtitle, and says so', async ({
  murmur,
}) => {
  const page = await murmur.open('video.html');
  await murmur.start(page);
  await expect.poll(async () => (await murmur.status()).state).toBe('running');
  await page.goto(`${OTHER_ORIGIN}/frame-blank.html`);
  await expect
    .poll(async () => murmur.status(), { timeout: 12_000 })
    .toMatchObject({ state: 'error', code: 'navigated', message: /no video/ });
  await expect(page.locator('murmur-overlay')).toHaveCount(0);
});

test('the session stops on a page Murmur cannot reach, and says so', async ({ murmur }) => {
  const page = await murmur.open('video.html');
  await murmur.start(page);
  await expect.poll(async () => (await murmur.status()).state).toBe('running');
  await page.goto('data:text/html,<video></video>');
  await expect
    .poll(async () => murmur.status())
    .toMatchObject({ state: 'error', code: 'navigated', message: /needs a click/ });
});
