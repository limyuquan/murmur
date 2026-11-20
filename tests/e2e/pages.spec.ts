/** Popup quick settings, the options page (models, preview, shortcuts) and the welcome flow. */
import { readFileSync } from 'node:fs';
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

  // Show the original: off by default (the translation only); Space toggles it.
  const dual = popup.getByTestId('dual');
  await expect(dual).toHaveAttribute('aria-checked', 'false');
  await expect.poll(async () => (await overlaySettings(serviceWorker)).display).toBe('translation');
  await dual.focus();
  await popup.keyboard.press('Space');
  await expect(dual).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await overlaySettings(serviceWorker)).display).toBe('both');
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

test('popup: lookahead on this site turns on, and says the page needs a reload', async ({
  murmur,
  serviceWorker,
}) => {
  // 127.0.0.1: an address has no www. form to ask access for.
  const page = await murmur.open('video.html');
  const tabId = await murmur.tabId(page);
  const popup = await page.context().newPage();
  await popup.goto(url(`popup.html?tab=${tabId}`));
  const ahead = popup.getByTestId('ahead-switch');
  await expect(ahead).toHaveAttribute('aria-checked', 'false');
  await ahead.click();
  await expect(ahead).toHaveAttribute('aria-checked', 'true');
  await expect(popup.getByTestId('ahead-note')).toHaveText(/Starts when the page reloads\./);
  await expect(popup.getByTestId('ahead-problem')).toHaveCount(0);
  const registered = () =>
    serviceWorker.evaluate(async () => {
      const chrome = (globalThis as unknown as { chrome: typeof import('wxt/browser').browser })
        .chrome;
      const s = await chrome.storage.local.get('settings');
      const scripts = await chrome.scripting.getRegisteredContentScripts();
      return {
        sites: (s.settings as import('@/settings/settings').Settings).lookahead.sites,
        matches: scripts.map((x) => x.matches),
      };
    });
  await expect
    .poll(registered)
    .toEqual({ sites: ['127.0.0.1'], matches: [['*://127.0.0.1/*'], ['*://127.0.0.1/*']] });

  await ahead.click();
  await expect(ahead).toHaveAttribute('aria-checked', 'false');
  await expect(popup.getByTestId('ahead-note')).toHaveText(/Stops when the page reloads\./);
  await expect.poll(registered).toEqual({ sites: [], matches: [] });
});

test('popup: shows the keyboard shortcut Chrome has, and where to change it', async ({
  murmur,
  context,
}) => {
  const page = await murmur.open('video.html');
  const tabId = await murmur.tabId(page);
  const popup = await context.newPage();
  await popup.goto(url(`popup.html?tab=${tabId}`));
  const row = popup.getByTestId('shortcut');
  // The binding as Chrome reports it (the manifest suggests Alt+Shift+S).
  await expect(row.locator('kbd')).toHaveText(['Alt', 'Shift', 'S']);
  const opened = context.waitForEvent('page');
  await row.getByRole('button', { name: 'Change the keyboard shortcut' }).click();
  expect((await opened).url()).toBe('chrome://extensions/shortcuts');
});

/** Opens the popup with the service worker's `view` answer changed by `patch` (a better model). */
async function popupWith(
  context: import('@playwright/test').BrowserContext,
  tabId: number,
  patch: Record<string, unknown>,
) {
  const popup = await context.newPage();
  await popup.addInitScript((patch) => {
    const runtime = (globalThis as unknown as { chrome: typeof import('wxt/browser').browser })
      .chrome.runtime;
    const send = runtime.sendMessage.bind(runtime) as (m: unknown) => Promise<unknown>;
    (runtime as { sendMessage: unknown }).sendMessage = async (message: { op?: string }) => {
      const res = (await send(message)) as { ok: boolean; result: Record<string, unknown> };
      if (message?.op === 'view' && res?.ok) Object.assign(res.result, patch);
      return res;
    };
  }, patch);
  await popup.goto(url(`popup.html?tab=${tabId}`));
  return popup;
}

test('popup: “Not now” puts the offer of a better translation model away for good', async ({
  murmur,
  context,
  serviceWorker,
}) => {
  const page = await murmur.open('video.html');
  const tabId = await murmur.tabId(page);
  const better = { ids: ['gemma4-e2b-webgpu'], label: 'Gemma 4 E2B', sizeMB: 2010 };
  const patch = { models: { ready: true, missingMB: 0, better } };
  const popup = await popupWith(context, tabId, patch);
  const offer = popup.getByTestId('better');
  await expect(offer).toContainText('Better translations: download Gemma 4 E2B');
  await offer.getByTestId('better-dismiss').click();
  await expect(offer).toHaveCount(0);
  await expect
    .poll(() =>
      serviceWorker.evaluate(async () => {
        const s = await (
          globalThis as unknown as { chrome: typeof import('wxt/browser').browser }
        ).chrome.storage.local.get('settings');
        return (s.settings as { dismissed?: string[] }).dismissed;
      }),
    )
    .toEqual(['better:gemma4-e2b-webgpu']);
  await popup.close();
  // Not offered again; another model would be.
  const again = await popupWith(context, tabId, patch);
  await expect(again.getByTestId('status')).toHaveText(/^Off/);
  await expect(again.getByTestId('better')).toHaveCount(0);
  const other = await popupWith(context, tabId, {
    models: { ready: true, missingMB: 0, better: { ...better, ids: ['gemma4-e4b-webgpu'] } },
  });
  await expect(other.getByTestId('better')).toContainText('Better translations');
});

test('popup: a model that isn’t downloaded stops the start, with the fix', async ({ murmur }) => {
  const page = await murmur.open('video.html');
  const tabId = await murmur.tabId(page);
  const popup = await page.context().newPage();
  await popup.goto(url(`popup.html?tab=${tabId}`));
  // Balanced, without WebGPU here: Whisper base, built for the processor.
  await expect(popup.getByTestId('status')).toContainText(/downloaded yet \(80\u00a0MB\)/);
  await popup.getByTestId('toggle').click();
  await expect(popup.getByTestId('status')).toContainText('The model isn’t downloaded');
  await expect(popup.getByTestId('status')).toContainText('Whisper base, for the processor');
  await expect(popup.getByRole('button', { name: 'Download' })).toBeVisible();
  // Nothing was captured or loaded.
  expect(await murmur.status()).toMatchObject({ state: 'error', code: 'model' });
});

/** Makes the popup's switch start these engines (the custom profile). */
async function useEngines(sw: Worker, asr: string): Promise<void> {
  await sw.evaluate(async (id) => {
    const { storage } = (globalThis as unknown as { chrome: typeof import('wxt/browser').browser })
      .chrome;
    // After the first-install defaults are in, or they would write over this.
    let current: Record<string, unknown> | undefined;
    for (let i = 0; i < 50 && !current; i++) {
      current = (await storage.local.get('settings')).settings as typeof current;
      if (!current) await new Promise((r) => setTimeout(r, 50));
    }
    await storage.local.set({
      settings: {
        ...current,
        profile: 'custom',
        custom: { asr: id, translation: 'demo-passthrough' },
      },
    });
  }, asr);
}

test('popup: a start that needs a language pack offers its download', async ({
  murmur,
  serviceWorker,
}) => {
  // The engine fails to load in the offscreen document, asking for a pack: the reason has to
  // reach the popup whole (code, buttons), not as "Something went wrong".
  await useEngines(serviceWorker, 'demo-needs-pack');
  const page = await murmur.open('video.html');
  const tabId = await murmur.tabId(page);
  const popup = await page.context().newPage();
  await popup.goto(url(`popup.html?tab=${tabId}`));
  await popup.getByTestId('toggle').click();
  await expect(popup.getByTestId('status')).toContainText(
    'Chrome needs to download a language pack',
  );
  await expect(popup.getByTestId('setup-actions')).toContainText('French speech recognition');
  expect(await murmur.status()).toMatchObject({
    state: 'error',
    code: 'setup',
    setup: [{ id: 'speech:fr-FR' }],
  });
  await expect(popup.getByTestId('toggle')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('murmur-overlay')).toHaveCount(0);
});

test('popup: switching off stops a session that is still loading', async ({
  murmur,
  serviceWorker,
}) => {
  await useEngines(serviceWorker, 'demo-stalled');
  const page = await murmur.open('video.html');
  const tabId = await murmur.tabId(page);
  const popup = await page.context().newPage();
  await popup.goto(url(`popup.html?tab=${tabId}`));
  await popup.getByTestId('toggle').click();
  await expect.poll(async () => (await murmur.status()).state).toBe('loading');
  await expect(popup.getByTestId('toggle')).toBeEnabled();
  await expect(popup.getByTestId('toggle')).toHaveAttribute('aria-checked', 'true');
  await popup.getByTestId('toggle').click();
  await expect(popup.getByTestId('status')).toHaveText(/^Off/);
  expect((await murmur.status()).state).toBe('idle');
  await expect(page.locator('murmur-overlay')).toHaveCount(0);
});

test('another tab takes over from a session that is still loading', async ({
  murmur,
  serviceWorker,
}) => {
  const first = await murmur.open('video.html');
  const firstId = await murmur.tabId(first);
  await serviceWorker.evaluate(
    (id) =>
      (
        globalThis as unknown as { __murmur: import('@/shared/e2e').BackgroundTestHook }
      ).__murmur.start(id, 'tone', { asr: 'demo-stalled', translation: 'demo-passthrough' }),
    firstId,
  );
  await expect.poll(async () => (await murmur.status()).state).toBe('loading');
  const second = await murmur.open('video.html?second');
  const secondId = await murmur.start(second);
  await expect.poll(async () => (await murmur.status()).state).toBe('running');
  expect(await murmur.status()).toMatchObject({ tabId: secondId });
  await expect(first.locator('murmur-overlay')).toHaveCount(0);
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
  // The download lives inside the chosen card.
  const selected = page.getByTestId('profile-balanced').getByTestId('selected-models');
  await expect(selected).toContainText('needs 80 MB');
  // Each file is under Manage downloads, closed until asked for.
  const manage = page.getByTestId('manage-downloads');
  await expect(manage).not.toHaveAttribute('open');
  await expect(page.getByTestId('model-whisper-base-wasm')).toBeHidden();
  await manage.locator('summary').click();
  await expect(manage).toHaveAttribute('open');
  await page.getByTestId('download-selected').click();
  await expect(selected).toContainText(/Downloading Balanced models/);
  // Best shares the model, but only the chosen card says it is downloading.
  await expect(page.getByTestId('profile-balanced').locator('.badge')).toContainText('Downloading');
  await expect(page.getByTestId('profile-best')).not.toContainText('Downloading');
  const row = page.getByTestId('model-whisper-base-wasm');
  // Stop once the first weights file is in (whole parts are kept).
  await expect(row).toContainText(/[3-7]\d\u00a0MB of 80\u00a0MB/, { timeout: 10_000 });
  await row.getByRole('button', { name: /Cancel/ }).click();
  await expect(row).toContainText(/Stopped at \d+\u00a0MB of 80\u00a0MB/);
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

test('options: the smaller speech model, and trying larger models again', async ({
  context,
  serviceWorker,
}) => {
  const page = await context.newPage();
  await page.goto(url('options.html'));
  await page.getByTestId('profile-balanced').click();
  const size = page.getByTestId('model-size');
  // The e2e build gets Qwen3-ASR from the fixture server, so the choice is offered.
  await expect(size).toContainText('Use the smaller speech model (1.1 GB)');
  await expect(size).toContainText('Qwen3-ASR 0.6B instead of Qwen3-ASR 1.7B (2.3 GB)');
  await page.getByTestId('smaller-speech').check();
  await expect
    .poll(() =>
      serviceWorker.evaluate(async () => {
        const chrome = (globalThis as unknown as { chrome: typeof import('wxt/browser').browser })
          .chrome;
        const s = await chrome.storage.local.get('settings');
        return (s.settings as { smallerSpeech?: boolean }).smallerSpeech;
      }),
    )
    .toBe(true);
  await page.getByTestId('smaller-speech').uncheck();
  // A step down below the last step recorded on this device (no WebGPU here: the card is
  // `none`), so Chrome's own engines run.
  await serviceWorker.evaluate(async () => {
    const chrome = (globalThis as unknown as { chrome: typeof import('wxt/browser').browser })
      .chrome;
    const ladder = await globalThis.__murmur?.ladderId();
    await chrome.storage.local.set({
      memoryFit: { none: { balanced: { ladder, step: 3, at: 1, engine: 'qwen3-asr-0.6b' } } },
    });
  });
  const fit = page.getByTestId('memory-fit');
  await expect(fit).toContainText('Using smaller models to fit this device’s graphics memory');
  await expect(fit).toContainText('Larger ones ran out of graphics memory here.');
  await page.getByTestId('try-larger').click();
  await expect(fit).toHaveCount(0);
  const step = await serviceWorker.evaluate(async () => {
    const chrome = (globalThis as unknown as { chrome: typeof import('wxt/browser').browser })
      .chrome;
    const s = await chrome.storage.local.get('memoryFit');
    return (s.memoryFit as { none: { balanced: { step: number } } }).none.balanced.step;
  });
  expect(step).toBe(0);
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

test('settings changed in several places at once are all kept', async ({
  murmur,
  serviceWorker,
}) => {
  const page = await murmur.open('video.html');
  const tabId = await murmur.tabId(page);
  const options = await page.context().newPage();
  await options.goto(url('options.html#languages'));
  const spoken = options.getByTestId('spoken');
  await spoken.getByRole('checkbox', { name: 'Korean' }).check();
  await spoken.getByRole('checkbox', { name: 'Japanese' }).check();
  const stored = () =>
    serviceWorker.evaluate(async () => {
      const s = await (
        globalThis as unknown as { chrome: typeof import('wxt/browser').browser }
      ).chrome.storage.local.get('settings');
      const v = s.settings as import('@/settings/settings').Settings;
      return {
        spoken: v.spokenLanguages,
        onlySpoken: v.onlySpoken,
        fontScale: v.overlay.fontScale,
        sites: v.lookahead.sites,
      };
    });
  await expect.poll(async () => (await stored()).spoken).toEqual(['en', 'ko', 'ja']);

  const popup = await page.context().newPage();
  await popup.goto(url(`popup.html?tab=${tabId}`));
  await expect(popup.getByTestId('status')).toHaveText(/^Off/);
  // Each round, the popup, the service worker (lookahead) and the options page write at once.
  for (let i = 0; i < 4; i++) {
    await Promise.all([
      popup.evaluate(
        (site) =>
          (
            globalThis as unknown as { chrome: typeof import('wxt/browser').browser }
          ).chrome.runtime.sendMessage({
            target: 'background',
            op: 'setLookahead',
            args: { site, on: true },
          }),
        `s${i}.example.com`,
      ),
      popup
        .getByTestId('size')
        .getByTitle(i % 2 ? 'Medium' : 'Large')
        .click(),
      options.getByTestId('detect-any').click(),
    ]);
  }
  await expect.poll(stored).toEqual({
    spoken: ['en', 'ko', 'ja'],
    onlySpoken: false,
    fontScale: 1,
    sites: ['s0.example.com', 's1.example.com', 's2.example.com', 's3.example.com'],
  });
  // The options page still shows what is stored.
  await expect(spoken.getByRole('checkbox', { name: 'Korean' })).toBeChecked();
  await expect(spoken.getByRole('checkbox', { name: 'Japanese' })).toBeChecked();
  await expect(options.getByTestId('ahead')).toContainText('s3.example.com');
});

test('options: glossary entries are added, edited and removed', async ({
  context,
  serviceWorker,
}) => {
  const glossary = () =>
    serviceWorker.evaluate(async () => {
      const s = await (
        globalThis as unknown as { chrome: typeof import('wxt/browser').browser }
      ).chrome.storage.local.get('settings');
      return (s.settings as { glossary?: unknown } | undefined)?.glossary ?? [];
    });
  const page = await context.newPage();
  await page.goto(url('options.html#glossary'));
  const editor = page.getByTestId('glossary');
  await editor.getByLabel('Said as').fill('Kamil');
  await editor.getByLabel('Written as').fill('Camille');
  await editor.getByLabel('Written as').press('Enter');
  await expect.poll(glossary).toEqual([{ source: 'Kamil', target: 'Camille' }]);
  // The same source again can't be added.
  await editor.getByLabel('Said as').last().fill('Kamil');
  await editor.getByLabel('Written as').last().fill('Other');
  await expect(page.getByTestId('glossary-add')).toBeDisabled();
  await expect(editor).toContainText('That one is already in.');
  // What was typed became a chip in the add row; its × takes it out.
  await editor.locator('form').getByRole('button', { name: 'Remove “Kamil”' }).click();
  await expect(editor).not.toContainText('That one is already in.');
  // Edits are saved when the field is left.
  const entries = editor.getByRole('list', { name: 'Glossary entries' });
  await entries.getByLabel('Written as').fill('Camille D.');
  await entries.getByLabel('Said as').focus();
  await expect.poll(glossary).toEqual([{ source: 'Kamil', target: 'Camille D.' }]);
  await editor.getByRole('button', { name: 'Remove Kamil' }).click();
  await expect.poll(glossary).toEqual([]);

  // Other ways it's said, with |, and a note.
  await editor.getByLabel('Said as').fill('Lumen | Loumen');
  await editor.getByLabel('Written as').fill('Lumen');
  await editor.getByLabel('Note').fill('a band');
  await page.getByTestId('glossary-add').click();
  const lumen = { source: 'Lumen', aliases: ['Loumen'], target: 'Lumen', note: 'a band' };
  await expect.poll(glossary).toEqual([lumen]);
  // Each way it's said is a chip: added with Enter, taken out with its ×, saved at once.
  const entry = entries.getByTestId('glossary-entry').first();
  await expect(entry.locator('.token')).toHaveText(['Lumen', 'Loumen']);
  await entry.getByLabel('Said as').fill('Lümen');
  await entry.getByLabel('Said as').press('Enter');
  await expect(entry.locator('.token')).toHaveText(['Lumen', 'Loumen', 'Lümen']);
  await expect.poll(glossary).toEqual([{ ...lumen, aliases: ['Loumen', 'Lümen'] }]);
  await entry.getByRole('button', { name: 'Remove “Lümen”' }).click();
  await expect.poll(glossary).toEqual([lumen]);
  // Backspace in the empty field takes the last one out.
  await entry.getByLabel('Said as').press('Backspace');
  await expect.poll(glossary).toEqual([{ source: 'Lumen', target: 'Lumen', note: 'a band' }]);
  await entry.getByLabel('Said as').fill('Loumen|');
  await expect.poll(glossary).toEqual([lumen]);

  // Exported as a table, imported from one (a bad row is reported, not taken).
  const download = page.waitForEvent('download');
  await editor.getByRole('button', { name: 'Export TSV' }).click();
  const file = await (await download).path();
  expect(readFileSync(file, 'utf8')).toBe(
    'said as\twritten as\tnote\nLumen|Loumen\tLumen\ta band\n',
  );
  await editor.getByLabel('Glossary file').setInputFiles({
    name: 'names.tsv',
    mimeType: 'text/tab-separated-values',
    buffer: Buffer.from('Kamil|Kamille\tCamille\nno rendering\nLoumen|Lümen\tLumen\n'),
  });
  await expect(editor.getByRole('status')).toHaveText(
    'Added 1 entry. Added spellings or notes to 1 entry. Skipped line 2: no "written as".',
  );
  await expect.poll(glossary).toEqual([
    { ...lumen, aliases: ['Loumen', 'Lümen'] },
    { source: 'Kamil', aliases: ['Kamille'], target: 'Camille' },
  ]);
  await expect(entries.getByTestId('glossary-entry').first().locator('.token')).toHaveText([
    'Lumen',
    'Loumen',
    'Lümen',
  ]);
});

test('options: the preview follows the subtitle settings', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(url('options.html#subtitles'));
  const host = page.getByTestId('preview').locator('murmur-overlay');
  await expect(host.locator('.line[data-role="main"]').last()).toContainText(
    'Yes, but I might be a little late.',
  );
  // The translation only by default: no original line, nowhere to place one. No tags by default;
  // turned on, the tag goes on the translation.
  await expect(page.getByRole('radio', { name: 'Translation', exact: true })).toBeChecked();
  const tags = page.getByRole('switch', { name: 'Tag lines in another language' });
  await expect(tags).not.toBeChecked();
  await expect(host.locator('.tag')).toHaveCount(0);
  await tags.click();
  await expect(host.locator('.line[data-role="main"] .tag')).toHaveText('DE');
  await expect(host.locator('.line[data-role="original"]')).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Below' })).toBeDisabled();

  // Segmented controls: native radios under their labels.
  const choose = (name: string) => page.locator('.segmented label', { hasText: name }).click();
  await choose('Outline');
  await expect(host).toHaveAttribute('data-bg', 'outline');
  await choose('Original and translation');
  await expect(host.locator('.line[data-role="original"]').last()).toBeVisible();
  await choose('Below');
  await expect(host.locator('.block').last().locator('.line').first()).toHaveAttribute(
    'data-role',
    'main',
  );
  await page.locator('.segmented label').getByText('Translation', { exact: true }).click();
  await expect(host.locator('.line[data-role="original"]')).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Below' })).toBeDisabled();
});

test('options: a site is added for subtitles ahead of time, after Chrome gives access', async ({
  context,
  serviceWorker,
}) => {
  const page = await context.newPage();
  await page.goto(url('options.html#ahead'));
  const ahead = page.getByTestId('ahead');
  await expect(ahead).toContainText('No sites yet.');
  const field = page.getByLabel('Site to add');
  const add = ahead.getByRole('button', { name: 'Add', exact: true });
  const note = page.getByTestId('ahead-add-note');

  // Not a site: said so, nothing asked for.
  await field.fill('not a site');
  await add.click();
  await expect(note).toContainText('That isn’t a site address.');

  // The e2e build already has access everywhere, so Chrome gives it at once.
  await field.fill('https://www.talks.example.net/watch/42');
  await add.click();
  await expect(note).toContainText('On for talks.example.net.');
  await expect(page.getByTestId('ahead-site-talks.example.net')).toBeVisible();
  await expect(field).toHaveValue('');
  const state = () =>
    serviceWorker.evaluate(async () => {
      const chrome = (globalThis as unknown as { chrome: typeof import('wxt/browser').browser })
        .chrome;
      const s = await chrome.storage.local.get('settings');
      const scripts = await chrome.scripting.getRegisteredContentScripts();
      return {
        sites: (s.settings as import('@/settings/settings').Settings).lookahead.sites,
        matches: scripts.map((x) => x.matches),
      };
    });
  await expect.poll(state).toEqual({
    sites: ['talks.example.net'],
    matches: [
      ['*://talks.example.net/*', '*://www.talks.example.net/*'],
      ['*://talks.example.net/*', '*://www.talks.example.net/*'],
    ],
  });
  // Already in.
  await field.fill('talks.example.net');
  await add.click();
  await expect(note).toContainText('talks.example.net is already in the list.');

  // While Chrome asks, it says so and waits; refused, it says so and adds nothing.
  await page.evaluate(() => {
    const chrome = (globalThis as unknown as { chrome: typeof import('wxt/browser').browser })
      .chrome;
    let answer: (granted: boolean) => void = () => {};
    (chrome.permissions as { request: unknown }).request = () =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      });
    (globalThis as unknown as { refuse(): void }).refuse = () => answer(false);
  });
  await field.fill('news.example.com');
  await add.click();
  await expect(note).toContainText('Waiting for access to news.example.com…');
  await expect(add).toBeDisabled();
  await page.evaluate(() => (globalThis as unknown as { refuse(): void }).refuse());
  await expect(note).toContainText(
    'Murmur needs access to news.example.com for this. Chrome didn’t give it.',
  );
  await expect(page.getByTestId('ahead-site-news.example.com')).toHaveCount(0);
  await expect.poll(async () => (await state()).sites).toEqual(['talks.example.net']);

  // Removed from the list.
  await ahead.getByRole('button', { name: 'Remove talks.example.net' }).click();
  await expect.poll(state).toEqual({ sites: [], matches: [] });
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

test('welcome: languages, model and its download, done', async ({ context, serviceWorker }) => {
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

  // One step for the model size and its download: four steps in all.
  await expect(page.getByTestId('step-model')).toBeVisible();
  await expect(page.getByText('Step 3 of 4')).toBeVisible();
  await page.getByTestId('profile-balanced').click();
  const card = page.getByTestId('profile-balanced');
  // Chrome's translation packs for the spoken languages, beside the speech model, in the card.
  await expect(card.getByLabel('Chrome language packs')).toContainText('German to French');
  // Not downloaded yet: "Later" leaves it for another time; no Continue until it's in.
  await expect(page.getByRole('button', { name: 'Later' })).toBeVisible();
  await card.getByTestId('download-selected').click();
  await expect(page.getByRole('button', { name: 'Continue in the background' })).toBeVisible();
  await expect(card.getByTestId('selected-models')).toContainText(
    'Balanced models are downloaded',
    { timeout: 20_000 },
  );
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
