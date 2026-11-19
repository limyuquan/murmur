/** The per-device record of which memory-ladder step worked, in `storage.local`. */
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  cleanMemoryFit,
  fitFor,
  loadMemoryFit,
  MEMORY_FIT_KEY,
  saveMemoryFit,
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
        best: { step: 2, at: 5, engine: 'gemma4-e2b', message: 'x'.repeat(400), cause: 'slow' },
        balanced: { step: -1, at: 1 },
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
    expect(cleanMemoryFit({ g: { best: { step: 1, cause: 'bored' } } }).g?.best).toEqual({
      step: 1,
      at: 0,
    });
    expect(card?.balanced).toBeUndefined();
    expect(cleanMemoryFit('nope')).toEqual({});
  });

  it('stores, reads and watches a record', async () => {
    const seen: unknown[] = [];
    const stop = watchMemoryFit((fit) => seen.push(fit));
    await saveMemoryFit('gpu-a', 'best', { step: 1, at: 10, engine: 'gemma4-e4b', message: 'oom' });
    await saveMemoryFit('gpu-a', 'balanced', { step: 0, at: 11 });
    const fit = await loadMemoryFit();
    expect(fitFor(fit, 'gpu-a', 'best')).toEqual({
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
    for (let i = 0; i < 10; i++) fit = withFit(fit, `gpu-${i}`, 'best', { step: 1, at: i });
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
});
