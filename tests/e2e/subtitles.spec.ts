/**
 * How subtitles look and behave, with cues fed straight to the overlay (the e2e build's page
 * event) so every line is known: partial → final without jumps, two rows at most, language tags,
 * dragging, moving clear of the controls, fullscreen and small players.
 */
import type { Page } from '@playwright/test';
import type { E2eCommand } from '@/overlay';
import type { Cue } from '@/pipeline/types';
import { expect, test } from './fixtures';

async function send(page: Page, command: E2eCommand): Promise<void> {
  await page.evaluate(
    (detail) => document.dispatchEvent(new CustomEvent('earshot-e2e', { detail })),
    JSON.stringify(command),
  );
}

function cue(id: string, seq: number, patch: Partial<Cue> = {}): Cue {
  return {
    id,
    seq,
    startEpochMs: Date.now() - 2000,
    endEpochMs: Date.now() - 500,
    source: { text: `Ligne ${id}`, language: 'fr', final: true },
    translation: { text: `Line ${id}`, language: 'en', final: true },
    untranslated: null,
    ...patch,
  };
}

/** A cue whose translation is still changing: it stays on screen as long as a test needs. */
function lasting(id: string, seq: number): Cue {
  return cue(id, seq, { translation: { text: `Line ${id}`, language: 'en', final: false } });
}

/** Opens the player fixture with a running session whose cues the test controls. */
async function player(earshot: import('./fixtures').EarshotHelpers): Promise<Page> {
  const page = await earshot.open('player.html');
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return !!v && v.readyState >= 2 && v.videoWidth > 0;
  });
  await earshot.start(page);
  await expect(page.locator('earshot-overlay')).toHaveCount(1);
  await send(page, { hold: true });
  return page;
}

const PARTIAL_WORDS =
  'Nous avons attendu à la gare pendant des heures mais personne nest venu nous chercher ce soir'.split(
    ' ',
  );

test('a growing line stays put, then settles; the translation keeps its place', async ({
  earshot,
}) => {
  const page = await player(earshot);
  const host = page.locator('earshot-overlay');
  const original = host.locator('.line[data-role="original"] .text');

  const lefts: number[] = [];
  for (let n = 2; n <= 6; n++) {
    const text = PARTIAL_WORDS.slice(0, n).join(' ');
    await send(page, {
      cue: cue('a', 1, {
        source: { text, language: 'fr', final: false },
        translation: null,
        untranslated: 'pending',
      }),
    });
    await expect(original).toHaveText(text);
    lefts.push((await original.boundingBox())?.x ?? 0);
  }
  // Growing text reserves width in steps: its start moves rarely, and never per word.
  const moves = lefts.slice(1).filter((x, i) => Math.abs(x - (lefts[i] ?? 0)) > 1).length;
  expect(moves).toBeLessThanOrEqual(1);
  await expect(host.locator('.line[data-role="original"]')).toHaveAttribute('data-final', 'false');

  // Final source, then its translation: the translation takes the bottom row.
  const finalText = PARTIAL_WORDS.slice(0, 8).join(' ');
  await send(page, {
    cue: cue('a', 1, {
      source: { text: finalText, language: 'fr', final: true },
      translation: null,
      untranslated: 'pending',
    }),
  });
  await expect(host.locator('.line[data-role="original"]')).toHaveAttribute('data-final', 'true');
  await send(page, {
    cue: cue('a', 1, { source: { text: finalText, language: 'fr', final: true } }),
  });
  const main = host.locator('.line[data-role="main"] .text');
  await expect(main).toHaveText('Line a');
  const bottom = (await main.boundingBox())?.y ?? 0;

  // A new segment starts: the older block rolls up; the bottom line is the new one, same place.
  await send(page, {
    cue: cue('b', 2, {
      source: { text: 'Bonjour', language: 'fr', final: true },
      translation: { text: 'Hello', language: 'en', final: true },
    }),
  });
  const mains = host.locator('.line[data-role="main"] .text');
  await expect(mains).toHaveText(['Line a', 'Hello']);
  await expect.poll(async () => (await mains.last().boundingBox())?.y ?? 0).toBeCloseTo(bottom, 0);
});

test('lines keep to two rows; long text is paged', async ({ earshot }) => {
  const page = await player(earshot);
  const long =
    'We should go now. The last train leaves at midnight and I really do not want to miss it again, ' +
    'because the night bus takes almost two hours and stops everywhere along the way.';
  await send(page, {
    cue: cue('a', 1, { translation: { text: long, language: 'en', final: true } }),
  });
  const main = page.locator('earshot-overlay .line[data-role="main"]');
  await expect(main).toHaveText('We should go now.');
  // Next page after its reading time.
  await expect(main).toContainText('The last train', { timeout: 5000 });
  const rows = await main.evaluate((el) => {
    const lh = Number.parseFloat(getComputedStyle(el).lineHeight);
    return Math.round(el.getBoundingClientRect().height / lh);
  });
  expect(rows).toBeLessThanOrEqual(2);
});

test('only lines in a less common language are tagged', async ({ earshot }) => {
  const page = await player(earshot);
  const host = page.locator('earshot-overlay');
  await send(page, { cue: cue('a', 1) });
  await send(page, { cue: cue('b', 2) });
  await expect(host.locator('.tag')).toHaveCount(0);
  await send(page, {
    cue: cue('c', 3, { source: { text: 'Guten Abend', language: 'de', final: true } }),
  });
  const tag = host.locator('.line[data-role="original"] .tag');
  await expect(tag).toHaveText('DE');
  await expect(host.locator('.tag')).toHaveCount(1);
});

test('subtitles can be dragged, and stay there on this site', async ({ earshot }) => {
  const page = await player(earshot);
  const host = page.locator('earshot-overlay');
  await send(page, { cue: lasting('a', 1) });
  const text = host.locator('.line[data-role="main"] .text');
  await expect(text).toBeVisible();
  // Pointer off the player, so the subtitles aren't lifted for its controls.
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  const before = await text.boundingBox();
  if (!before) throw new Error('no subtitle');

  const x = before.x + before.width / 2;
  const y = before.y + before.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 120, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await text.boundingBox())?.y ?? 0).toBeLessThan(before.y - 100);
  // The press didn't reach the player.
  expect(
    await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).paused),
  ).toBe(false);

  // Saved for the site; a fresh overlay (new session) uses it.
  await expect.poll(async () => (await earshot.positions())['127.0.0.1']?.y ?? 1).toBeLessThan(0.8);
  await earshot.stop();
  await expect(host).toHaveCount(0);
  await earshot.start(page);
  await send(page, { hold: true });
  await send(page, { cue: lasting('b', 2) });
  await expect.poll(async () => (await text.boundingBox())?.y ?? 0).toBeLessThan(before.y - 100);

  // Double-click puts them back.
  await text.dblclick();
  await page.mouse.move(5, 5);
  await expect
    .poll(async () => (await text.boundingBox())?.y ?? 0, { timeout: 8000 })
    .toBeCloseTo(before.y, 0);
  await expect.poll(async () => (await earshot.positions())['127.0.0.1']).toBeUndefined();
});

test('subtitles move up while the pointer is over the player', async ({ earshot }) => {
  const page = await player(earshot);
  // Still changing, so it stays on screen as long as the test needs.
  await send(page, {
    cue: cue('a', 1, { translation: { text: 'Line a', language: 'en', final: false } }),
  });
  const text = page.locator('earshot-overlay .line[data-role="main"] .text');
  await expect(text).toBeVisible();
  await page.mouse.move(5, 5);
  const resting = (await text.boundingBox())?.y ?? 0;
  await page.mouse.move(400, 200);
  await page.mouse.move(420, 210);
  await expect.poll(async () => (await text.boundingBox())?.y ?? 0).toBeLessThan(resting - 20);
  // Back down once the pointer has been still a while.
  await expect
    .poll(async () => (await text.boundingBox())?.y ?? 0, { timeout: 6000 })
    .toBeCloseTo(resting, 0);
});

test('fullscreen: inside a fullscreen player, and above a fullscreen video', async ({
  earshot,
}) => {
  const page = await player(earshot);
  const host = page.locator('earshot-overlay');
  await send(page, { cue: lasting('a', 1) });
  await page.click('#fs-player');
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null))
    .toBe('player');
  await expect
    .poll(() => page.evaluate(() => document.querySelector('earshot-overlay')?.parentElement?.id))
    .toBe('player');
  const viewport = page.viewportSize();
  await expect
    .poll(async () => (await host.boundingBox())?.width ?? 0)
    .toBeCloseTo(viewport?.width ?? 0, 0);
  await page.evaluate(() => document.exitFullscreen());

  await page.click('#fs-video');
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null))
    .toBe('video');
  await expect
    .poll(() =>
      page.evaluate(() => document.querySelector('earshot-overlay')?.matches(':popover-open')),
    )
    .toBe(true);
  await expect(host.locator('.line[data-role="main"]')).toBeVisible();
  await page.evaluate(() => document.exitFullscreen());
});

test('small players show the translation only', async ({ earshot }) => {
  const page = await player(earshot);
  const host = page.locator('earshot-overlay');
  await send(page, { cue: cue('a', 1) });
  await expect(host.locator('.line[data-role="original"]')).toHaveCount(1);
  await page.click('#small');
  await expect(host.locator('.line[data-role="original"]')).toHaveCount(0);
  await expect(host.locator('.line[data-role="main"]')).toHaveText('Line a');
});

test('the session status shows on the picture', async ({ earshot }) => {
  const page = await player(earshot);
  const pill = page.locator('earshot-overlay .pill');
  await send(page, {
    message: {
      type: 'status',
      status: { state: 'loading', detail: 'Loading model', progress: 0.4 },
    },
  });
  await expect(pill).toHaveAttribute('data-show', 'true');
  await expect(pill).toContainText('Loading model');
  await send(page, { message: { type: 'status', status: { state: 'running', behindMs: null } } });
  await expect(pill).toHaveAttribute('data-show', 'false');
  await send(page, { message: { type: 'status', status: { state: 'running', behindMs: 7000 } } });
  await expect(pill).toContainText('7 s behind');
});
