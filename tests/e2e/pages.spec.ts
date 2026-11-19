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
  murmur,
  serviceWorker,
}) => {
  const page = await murmur.open('video.html');
  const tabId = await murmur.tabId(page);
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

test('popup: a model that isn’t downloaded stops the start, with the fix', async ({ murmur }) => {
  const page = await murmur.open('video.html');
  const tabId = await murmur.tabId(page);
  const popup = await page.context().newPage();
  await popup.goto(url(`popup.html?tab=${tabId}`));
  // Balanced, without WebGPU here: Whisper base, built for the processor.
  await expect(popup.getByTestId('status')).toContainText(/downloaded yet \(80 MB\)/);
  await popup.getByTestId('toggle').click();
  await expect(popup.getByTestId('status')).toContainText('The model isn’t downloaded');
  await expect(popup.getByTestId('status')).toContainText('Whisper base, for the processor');
  await expect(popup.getByRole('button', { name: 'Download' })).toBeVisible();
  // Nothing was captured or loaded.
  expect(await murmur.status()).toMatchObject({ state: 'error', code: 'model' });
});

test('popup: one button per language pack the session asked for', async ({
  murmur,
  serviceWorker,
}) => {
  const page = await murmur.open('video.html');
  const tabId = await murmur.tabId(page);
  await serviceWorker.evaluate(async (id) => {
    await (
      globalThis as unknown as { chrome: typeof import('wxt/browser').browser }
    ).chrome.storage.session.set({
      session: {
        state: 'error',
        tabId: id,
        sessionId: 's',
        code: 'setup',
        message: 'Chrome needs to download first.',
        setup: [
          {
            id: 'translation:fr>en',
            kind: 'translation-pack',
            label: 'Download French to English translation',
            languages: ['fr', 'en'],
          },
        ],
      },
    });
  }, tabId);
  const popup = await page.context().newPage();
  await popup.goto(url(`popup.html?tab=${tabId}`));
  await expect(popup.getByTestId('status')).toContainText(
    'Chrome needs to download a language pack',
  );
  await expect(popup.getByTestId('setup-actions')).toContainText('French to English translation');
});

test('options: download a model, stop and resume it, delete it', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(url('options.html'));
  await expect(page.getByTestId('hardware')).toContainText('Graphics');

  // Light: Chrome's own engines; its packs are listed, nothing to download from Murmur.
  await page.getByTestId('profile-light').click();
  await expect(page.getByTestId('profile-light')).toContainText('Chrome’s language packs only');
  await expect(page.getByTestId('chrome-packs')).toContainText('speech recognition');
  await expect(page.getByTestId('selected-models')).toHaveCount(0);

  await page.getByTestId('profile-balanced').click();
  await expect(page.getByRole('radio', { name: /^Balanced/ })).toBeChecked();
  const selected = page.getByTestId('selected-models');
  await expect(selected).toContainText('needs 80 MB');
  await page.getByTestId('download-selected').click();
  await expect(selected).toContainText(/Downloading Balanced models/);
  const row = page.getByTestId('model-whisper-base-wasm');
  // Stop once the first weights file is in (whole parts are kept).
  await expect(row).toContainText(/[3-7]\d MB of 80 MB/, { timeout: 10_000 });
  await row.getByRole('button', { name: /Cancel/ }).click();
  await expect(row).toContainText(/Stopped at \d+ MB of 80 MB/);
  await row.getByRole('button', { name: /Resume/ }).click();
  await expect(selected).toContainText('Balanced models are downloaded (80 MB)', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('disk-usage')).toContainText('80 MB used');

  await row.getByRole('button', { name: /Delete/ }).click();
  await expect(row).toContainText('Not downloaded');
  await expect(selected).toContainText('needs 80 MB');
  await expect(page.getByTestId('disk-usage')).toContainText('0 MB used');
});

test('options: spoken languages', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.goto(url('options.html#languages'));
  const spoken = page.getByTestId('spoken');
  // The browser's language to start with.
  await expect(spoken.getByRole('checkbox', { name: 'English' })).toBeChecked();
  await spoken.getByRole('checkbox', { name: 'French' }).check();
  await page.getByTestId('detect-any').click();
  await expect
    .poll(() =>
      serviceWorker.evaluate(async () => {
        const s = await (
          globalThis as unknown as { chrome: typeof import('wxt/browser').browser }
        ).chrome.storage.local.get('settings');
        const v = s.settings as { spokenLanguages: string[]; onlySpoken: boolean };
        return [v.spokenLanguages, v.onlySpoken];
      }),
    )
    .toEqual([['en', 'fr'], true]);
  // The last one can't be unticked.
  await spoken.getByRole('checkbox', { name: 'French' }).uncheck();
  await spoken.getByRole('checkbox', { name: 'English' }).click();
  await expect(spoken.getByRole('checkbox', { name: 'English' })).toBeChecked();
});

test('options: the preview follows the subtitle settings', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(url('options.html#subtitles'));
  const host = page.getByTestId('preview').locator('murmur-overlay');
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
  await expect(list).toContainText('Open Murmur');
  await expect(list).toContainText('Subtitles on or off for this tab');
  await expect(list).toContainText('Show or hide the original line');
});

async function next(page: Page, name: RegExp) {
  await page.getByRole('button', { name }).click();
}

test('welcome: languages, model, download, done', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await page.goto(url('welcome.html'));
  await expect(page.getByTestId('step-intro')).toBeVisible();
  await next(page, /Get started/);

  await expect(page.getByTestId('step-language')).toBeVisible();
  // Focus moved to the step's heading.
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await page.getByLabel('Translate into').selectOption('fr');
  await page.getByTestId('spoken').getByRole('checkbox', { name: 'German' }).check();
  await next(page, /Continue/);

  await expect(page.getByTestId('step-model')).toBeVisible();
  await page.getByTestId('profile-balanced').click();
  await next(page, /Continue/);

  await expect(page.getByTestId('step-download')).toBeVisible();
  // Chrome's translation packs for the spoken languages, beside the speech model.
  await expect(page.getByLabel('Chrome language packs')).toContainText('German to French');
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
    return s.settings as { targetLanguage: string; profile: string; spokenLanguages: string[] };
  });
  expect(settings).toMatchObject({
    targetLanguage: 'fr',
    profile: 'balanced',
    spokenLanguages: ['en', 'de'],
  });
});
