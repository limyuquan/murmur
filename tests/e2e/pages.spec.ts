/** Popup quick settings, the options page (models, preview, shortcuts) and the welcome flow. */
import type { Page, Worker } from '@playwright/test';
import { EXTENSION_ID } from '@/shared/ids';
import { expect, test } from './fixtures';

const url = (page: string) => `chrome-extension://${EXTENSION_ID}/${page}`;

async function overlaySettings(sw: Worker) {
  return sw.evaluate(async () => {
    const s = await (
      globalThis as unknown as { chrome: typeof import('wxt/browser').browser }
    ).chrome.storage.local.get('settings');
    return (s.settings as { overlay?: Record<string, unknown> } | undefined)?.overlay ?? {};
  });
}

test('popup quick settings change subtitles, from the keyboard too', async ({
  earshot,
  serviceWorker,
}) => {
  const page = await earshot.open('video.html');
  const tabId = await earshot.tabId(page);
  const popup = await page.context().newPage();
  await popup.goto(url(`popup.html?tab=${tabId}`));
  await expect(popup.getByTestId('status')).toHaveText(/^Off/);

  // Show the original: on by default; Space toggles it.
  const dual = popup.getByTestId('dual');
  await expect(dual).toHaveAttribute('aria-checked', 'true');
  await dual.focus();
  await popup.keyboard.press('Space');
  await expect(dual).toHaveAttribute('aria-checked', 'false');
  await expect.poll(async () => (await overlaySettings(serviceWorker)).display).toBe('translation');

  // Size presets are a radio group: arrow keys move the choice.
  const size = popup.getByTestId('size');
  await expect(size.getByRole('radio', { name: 'Medium' })).toBeChecked();
  await size.getByRole('radio', { name: 'Medium' }).focus();
  await popup.keyboard.press('ArrowRight');
  await expect(size.getByRole('radio', { name: 'Large' })).toBeChecked();
  await expect.poll(async () => (await overlaySettings(serviceWorker)).fontScale).toBe(1.3);
});

test('options: pick a model size, download it, delete it', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(url('options.html'));
  await expect(page.getByTestId('simulated-notice')).toBeVisible();
  await expect(page.getByTestId('hardware')).toContainText('Graphics');

  await page.getByTestId('profile-light').click();
  await expect(page.getByRole('radio', { name: /Light/ })).toBeChecked();
  const selected = page.getByTestId('selected-models');
  await expect(selected).toContainText('550 MB');
  await page.getByTestId('download-selected').click();
  await expect(selected).toContainText(/Downloading Light models/);
  await expect(page.getByRole('progressbar').first()).toBeVisible();
  await expect(selected).toContainText('Light models are downloaded', { timeout: 20_000 });
  await expect(page.getByTestId('disk-usage')).toContainText('550 MB used');

  const speech = page.getByTestId('model-planned-speech-small');
  await speech.getByRole('button', { name: /Delete/ }).click();
  await expect(speech).toContainText('Not downloaded');
  await expect(selected).toContainText('needs 250 MB');
});

test('options: the preview follows the subtitle settings', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(url('options.html#subtitles'));
  const host = page.getByTestId('preview').locator('earshot-overlay');
  await expect(host.locator('.line[data-role="main"]').last()).toHaveText(
    'Yes, but I might be a little late.',
  );
  await expect(host.locator('.tag')).toHaveText('DE');

  // Segmented controls: native radios under their labels.
  const choose = (name: string) => page.locator('.segmented label', { hasText: name }).click();
  await choose('Outline');
  await expect(host).toHaveAttribute('data-bg', 'outline');
  await choose('Below');
  await expect(host.locator('.block').last().locator('.line').first()).toHaveAttribute(
    'data-role',
    'main',
  );
  await page.locator('.segmented label').getByText('Translation', { exact: true }).click();
  await expect(host.locator('.line[data-role="original"]')).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Below' })).toBeDisabled();
});

test('options: shortcuts are listed', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(url('options.html#shortcuts'));
  const list = page.getByTestId('shortcuts');
  await expect(list).toContainText('Open Earshot');
  await expect(list).toContainText('Subtitles on or off for this tab');
  await expect(list).toContainText('Show or hide the original line');
});

async function next(page: Page, name: RegExp) {
  await page.getByRole('button', { name }).click();
}

test('welcome: language, model, download, done', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.goto(url('welcome.html'));
  await expect(page.getByTestId('step-intro')).toBeVisible();
  await next(page, /Get started/);

  await expect(page.getByTestId('step-language')).toBeVisible();
  // Focus moved to the step's heading.
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await page.getByLabel('Translate into').selectOption('fr');
  await next(page, /Continue/);

  await expect(page.getByTestId('step-model')).toBeVisible();
  await page.getByTestId('profile-light').click();
  await next(page, /Continue/);

  await expect(page.getByTestId('step-download')).toBeVisible();
  await page.getByTestId('welcome-download').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Models are ready', {
    timeout: 20_000,
  });
  await next(page, /Continue/);

  await expect(page.getByTestId('step-done')).toBeVisible();
  const settings = await serviceWorker.evaluate(async () => {
    const s = await (
      globalThis as unknown as { chrome: typeof import('wxt/browser').browser }
    ).chrome.storage.local.get('settings');
    return s.settings as { targetLanguage: string; profile: string };
  });
  expect(settings).toMatchObject({ targetLanguage: 'fr', profile: 'light' });
});
