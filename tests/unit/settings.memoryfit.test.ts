/** The per-device record of which memory-ladder step worked, in `storage.local`. */
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  afterSlowSession,
  cleanMemoryFit,
  fitFor,
  loadMemoryFit,
  loadSlowStrikes,
  MEMORY_FIT_KEY,
  STRIKE_MS,
  saveMemoryFit,
  saveSlowStrike,
  watchMemoryFit,
  withFit,
} from '@/settings/memoryfit';

beforeEach(() => {
  fakeBrowser.reset();
});

describe('memory fit record', () => {
  it('keeps valid records per card and profile', () => {
    const clean = cleanMemoryFit({
      'nvidia|ampere||2048': {
        best: {
          ladder: 'L',
          step: 2,
          at: 5,
          engine: 'gemma4-e2b',
          message: 'x'.repeat(400),
          cause: 'slow',
        },
        balanced: { ladder: 'L', step: -1, at: 1 },
        light: 'nope',
        custom: { step: 1 },
      },
      junk: 3,
    });
    expect(Object.keys(clean)).toEqual(['nvidia|ampere||2048']);
    const card = clean['nvidia|ampere||2048'];
    expect(card?.best?.step).toBe(2);
    expect(card?.best?.message).toHaveLength(300);
    expect(card?.best?.cause).toBe('slow');
    expect(
      cleanMemoryFit({ g: { best: { ladder: 'L', step: 1, cause: 'bored' } } }).g?.best,
    ).toEqual({ ladder: 'L', step: 1, at: 0 });
    // Made before records named their ladder: dropped (it may describe other engines).
    expect(cleanMemoryFit({ g: { best: { step: 1, at: 2 } } }).g?.best).toBeUndefined();
    expect(card?.balanced).toBeUndefined();
    expect(cleanMemoryFit('nope')).toEqual({});
  });

  it('stores, reads and watches a record', async () => {
    const seen: unknown[] = [];
    const stop = watchMemoryFit((fit) => seen.push(fit));
    await saveMemoryFit('gpu-a', 'best', {
      ladder: 'L',
      step: 1,
      at: 10,
      engine: 'gemma4-e4b',
      message: 'oom',
    });
    await saveMemoryFit('gpu-a', 'balanced', { ladder: 'L', step: 0, at: 11 });
    const fit = await loadMemoryFit();
    expect(fitFor(fit, 'gpu-a', 'best')).toEqual({
      ladder: 'L',
      step: 1,
      at: 10,
      engine: 'gemma4-e4b',
      message: 'oom',
    });
    expect(fitFor(fit, 'gpu-a', 'balanced')?.step).toBe(0);
    expect(fitFor(fit, 'gpu-b', 'best')).toBeNull();
    expect(seen).toHaveLength(2);
    stop();
    expect((await fakeBrowser.storage.local.get(MEMORY_FIT_KEY))[MEMORY_FIT_KEY]).toBeTruthy();
  });

  it('keeps the newest cards', () => {
    let fit = {};
    for (let i = 0; i < 10; i++)
      fit = withFit(fit, `gpu-${i}`, 'best', { ladder: 'L', step: 1, at: i });
    expect(Object.keys(cleanMemoryFit(fit))).toEqual([
      'gpu-2',
      'gpu-3',
      'gpu-4',
      'gpu-5',
      'gpu-6',
      'gpu-7',
      'gpu-8',
      'gpu-9',
    ]);
  });

  it('steps down for slowness only the second time at the same step', async () => {
    const event = { ladder: 'L', from: 1 };
    const first = afterSlowSession(null, event, 100);
    expect(first).toEqual({ record: false, strike: { ladder: 'L', step: 1, at: 100 } });
    expect(afterSlowSession(first.strike, event, 200)).toEqual({ record: true, strike: null });
    // Another step, another ladder, or a strike too old: a new strike instead.
    for (const [strike, e, now] of [
      [first.strike, { ladder: 'L', from: 2 }, 200],
      [first.strike, { ladder: 'M', from: 1 }, 200],
      [first.strike, event, 101 + STRIKE_MS],
    ] as const) {
      expect(afterSlowSession(strike, e, now).record).toBe(false);
    }
    await saveSlowStrike('gpu-a', 'best', first.strike);
    expect((await loadSlowStrikes())['gpu-a']?.best).toEqual(first.strike);
    await saveSlowStrike('gpu-a', 'best', null);
    expect((await loadSlowStrikes())['gpu-a']?.best).toBeUndefined();
  });
});
