/**
 * Subtitles ahead of time with real players: hls.js (fMP4), dash.js (fMP4), Shaka (WebM) and a
 * progressive MP4, on local media whose audio is tone bursts at known times
 * (scripts/make-lookahead-media.sh), with the demo engines. Checks that the page scripts hook the
 * player without disturbing it, that cues are made from the player's buffer and shown when the
 * video reaches their speech (not when the tab's audio is heard: the session hears only its test
 * tone), and that seeking back shows them again at once without redoing them.
 */
import type { Page, Worker } from '@playwright/test';
import type { Cue } from '@/pipeline/types';
import type { OffscreenE2eLog } from '@/shared/e2e';
import { expect, test } from './fixtures';

/** Tone bursts in the fixture clip, seconds [start, end] (scripts/make-lookahead-media.sh). */
const BURSTS: [number, number][] = [
  [1, 2],
  [4, 5.5],
  [8, 9],
  [11.5, 13],
  [15, 16],
  [18, 19],
];

const PLAYERS = [
  { name: 'hls.js', page: 'lookahead-hls.html' },
  { name: 'dash.js', page: 'lookahead-dash.html' },
  { name: 'Shaka (WebM)', page: 'lookahead-shaka.html' },
  { name: 'progressive MP4', page: 'lookahead-progressive.html' },
  // MSE in a worker, as on Twitch (e2e builds put the tee in workers when the page asks).
  { name: 'MSE in a worker', page: 'lookahead-worker.html?murmur-worker-tee' },
];

type SwGlobal = { __murmur: import('@/shared/e2e').BackgroundTestHook };

function offscreenLog(sw: Worker): Promise<OffscreenE2eLog | null> {
  return sw.evaluate(() => (globalThis as unknown as SwGlobal).__murmur.offscreenLog());
}

/** The finished lookahead cues, latest version of each. */
function finished(log: OffscreenE2eLog | null): Cue[] {
  const byId = new Map<string, Cue>();
  for (const { cue } of log?.lookaheadCues ?? []) byId.set(cue.id, cue);
  return [...byId.values()]
    .filter((c) => c.source.final && c.translation?.final && c.media)
    .sort((a, b) => (a.media?.start ?? 0) - (b.media?.start ?? 0));
}

/**
 * Records, in the page, each change of the subtitles shown with the video's time, and the
 * video's time at each animation frame the page gets (the overlay draws in those frames too, so
 * a stall of the whole page shows in both).
 */
async function recordShown(page: Page): Promise<void> {
  await page.evaluate(() => {
    const video = document.querySelector('video') as HTMLVideoElement;
    const root = document.querySelector('murmur-overlay')?.shadowRoot;
    if (!root) throw new Error('no overlay');
    const shown: { t: number; ids: string[] }[] = [];
    const frames: [number, number][] = [];
    Object.assign(window, { shown, pageFrames: frames });
    const frame = () => {
      frames.push([video.currentTime, Date.now()]);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    const snap = () => {
      const ids = [...root.querySelectorAll('.block:not(.leaving)')].map(
        (b) => (b as HTMLElement).dataset.id ?? '',
      );
      const last = shown.at(-1);
      if (!last || last.ids.join() !== ids.join()) shown.push({ t: video.currentTime, ids });
    };
    new MutationObserver(snap).observe(root, { childList: true, subtree: true, attributes: true });
    snap();
  });
}

for (const player of PLAYERS) {
  test(`${player.name}: subtitles from the buffer, on the video's clock`, async ({
    murmur,
    serviceWorker,
  }) => {
    test.setTimeout(90_000);
    await serviceWorker.evaluate(() =>
      (globalThis as unknown as SwGlobal).__murmur.lookahead('127.0.0.1', true),
    );
    const page = await murmur.open(player.page);

    // The tee is in place, and looks like the built-in it wraps.
    const hook = await page.evaluate(() => {
      const fn = Object.getOwnPropertyDescriptor(SourceBuffer.prototype, 'appendBuffer')?.value as (
        ...a: unknown[]
      ) => unknown;
      return {
        name: fn.name,
        length: fn.length,
        native: String(fn).includes('[native code]'),
        prototype: 'prototype' in fn,
        wrapped: Object.hasOwn(fn, 'toString'),
      };
    });
    expect(hook).toEqual({
      name: 'appendBuffer',
      length: 1,
      native: true,
      prototype: false,
      wrapped: true,
    });

    // The player buffers and plays before subtitles are turned on (what was buffered is held).
    await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 0.5);
    await page.evaluate(() => {
      const video = document.querySelector('video') as HTMLVideoElement;
      video.pause();
      video.currentTime = 0;
    });
    await murmur.start(page);
    await expect(page.locator('murmur-overlay')).toHaveCount(1);
    await expect
      .poll(async () => (await offscreenLog(serviceWorker))?.lookahead?.target?.key ?? null)
      .not.toBeNull();
    await recordShown(page);

    // Paused at 0, lookahead gets ahead; then the video plays through.
    await expect
      .poll(async () => finished(await offscreenLog(serviceWorker)).length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).play());
    let sawLivePaused = false;
    await expect
      .poll(
        async () => {
          const log = await offscreenLog(serviceWorker);
          if (log?.lookahead?.livePaused) sawLivePaused = true;
          return page.evaluate(
            () => (document.querySelector('video') as HTMLVideoElement).currentTime,
          );
        },
        { timeout: 45_000, intervals: [500] },
      )
      .toBeGreaterThan(19.3);

    const log = await offscreenLog(serviceWorker);
    const cues = finished(log);
    const { shown, frames } = await page.evaluate(() => {
      const w = window as unknown as {
        shown: { t: number; ids: string[] }[];
        pageFrames: [number, number][];
      };
      return { shown: w.shown, frames: w.pageFrames };
    });
    // Two reads of `currentTime` in the same frame can differ by a fraction of a millisecond
    // (Chrome moves it on between reads), far less than a frame (~16 ms).
    const SLACK = 0.005;
    // One cue per burst, timed from the media itself.
    const timing = BURSTS.map(([start]) => {
      const cue = cues.find((c) => Math.abs((c.media?.start ?? -9) - start) < 0.4);
      const at = cue?.media?.start ?? null;
      const first = cue ? shown.find((s) => s.ids.includes(cue.id)) : undefined;
      // The page's frames once the video reached the cue: the overlay, which checks the video's
      // time every frame, draws it in the first, and under load may miss one.
      // (Reached: at or past it. A video that crawls can spend frames just short of it.)
      const reached = at === null ? -1 : frames.findIndex(([t]) => t >= at);
      const due = reached >= 0 ? frames[reached + 2]?.[0] : undefined;
      // How long before the video reached it the session sent the cue, ms.
      const sent = log?.lookaheadCues.find((c) => c.cue.id === cue?.id)?.at;
      const reachedAt = frames[reached]?.[1];
      return {
        burst: start,
        cue: at === null ? null : Number(at.toFixed(3)),
        shownAt: first ? Number(first.t.toFixed(3)) : null,
        due: due === undefined ? null : Number(due.toFixed(3)),
        aheadMs: sent && reachedAt ? Math.round(reachedAt - sent) : null,
      };
    });
    console.log(`${player.name}: ${JSON.stringify(timing)}`);
    for (const t of timing) {
      expect(t.cue, `a cue for the burst at ${t.burst} s`).not.toBeNull();
      // The segmenter starts a segment 100 ms before the speech.
      expect(Math.abs((t.cue ?? 0) - (t.burst - 0.1))).toBeLessThan(0.1);
      // Shown when the video gets there (the test tone's session has no capture lag): never
      // before, and within a frame or two. Timed against the page's own frames, not a fixed
      // bound: headless browsers running side by side sometimes stall the whole page for a
      // quarter second or more, which delays the frame, not the overlay's scheduling.
      expect(t.shownAt, `burst at ${t.burst} s shown`).not.toBeNull();
      expect(t.shownAt ?? 0, `burst at ${t.burst} s not early`).toBeGreaterThanOrEqual(
        (t.cue ?? 0) - SLACK,
      );
      expect(t.due, `the page drew a frame after ${t.burst} s`).not.toBeNull();
      expect(t.shownAt ?? 0, `burst at ${t.burst} s within two frames`).toBeLessThanOrEqual(
        (t.due ?? 0) + SLACK,
      );
    }
    // While lookahead was ahead, live recognition stepped aside.
    expect(sawLivePaused).toBe(true);
    // Live cues never showed where lookahead had subtitles: from its first cue to its last.
    // (Before the first, coverage can trail the first cue by a moment; after the last, the clip
    // ends and live recognition, back on, hears the session's test tone, which never stops.)
    const from = cues[0]?.media?.start ?? 0;
    const to = cues.at(-1)?.media?.end ?? 0;
    const liveShown = shown.filter(
      (s) => s.t >= from && s.t <= to && s.ids.some((id) => !id.startsWith('L')),
    );
    expect(liveShown).toEqual([]);

    // Seeking back shows the cue there at once, without making it again.
    const made = log?.lookaheadCues.length ?? 0;
    const second = cues.find((c) => Math.abs((c.media?.start ?? 0) - 3.9) < 0.3);
    await page.evaluate(() => {
      const video = document.querySelector('video') as HTMLVideoElement;
      video.pause();
      video.currentTime = 4.6;
    });
    const block = page.locator(`murmur-overlay .block:not(.leaving)[data-id="${second?.id}"]`);
    await expect(block).toHaveCount(1, { timeout: 1000 });
    const after = await offscreenLog(serviceWorker);
    expect(finished(after).map((c) => c.id)).toEqual(cues.map((c) => c.id));
    expect(after?.lookaheadCues.length).toBe(made);

    // The player never noticed.
    const playback = await page.evaluate(
      () => (window as unknown as { playback: { errors: string[]; waiting: number } }).playback,
    );
    expect(playback.errors).toEqual([]);
    expect(playback.waiting).toBeLessThanOrEqual(1);
    expect(log?.lookahead?.warnings ?? []).toEqual([]);
  });
}

test('the page’s workers are wrapped only where asked', async ({ murmur, serviceWorker }) => {
  await serviceWorker.evaluate(() =>
    (globalThis as unknown as SwGlobal).__murmur.lookahead('127.0.0.1', true),
  );
  // A wrapped Worker is a Proxy, whose source text has no name. What it makes still has it as
  // its constructor.
  const wrapped = () => {
    const w = new Worker(URL.createObjectURL(new Blob([''], { type: 'text/javascript' })));
    w.terminate();
    if (w.constructor !== Worker) return 'constructor';
    return Function.prototype.toString.call(Worker) !== 'function Worker() { [native code] }';
  };
  // hls.js makes a worker of its own: left as it is.
  const plain = await murmur.open('lookahead-hls.html');
  expect(await plain.evaluate(wrapped)).toBe(false);
  const asked = await murmur.open('lookahead-worker.html?murmur-worker-tee');
  await asked.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 0.5);
  expect(await asked.evaluate(wrapped)).toBe(true);
  const state = await asked.evaluate(() => ({
    instance: (window as unknown as { playerWorker: Worker }).playerWorker instanceof Worker,
    name: Worker.name,
    native: String(Worker).includes('[native code]'),
    errors: (window as unknown as { playback: { errors: string[] } }).playback.errors,
  }));
  expect(state).toEqual({ instance: true, name: 'Worker', native: true, errors: [] });
});

test('without lookahead on for the site, the player is left alone', async ({ murmur }) => {
  const page = await murmur.open('lookahead-hls.html');
  const own = await page.evaluate(() =>
    Object.hasOwn(
      Object.getOwnPropertyDescriptor(SourceBuffer.prototype, 'appendBuffer')?.value,
      'toString',
    ),
  );
  expect(own).toBe(false);
});
