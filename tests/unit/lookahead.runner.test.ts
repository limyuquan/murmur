/**
 * The lookahead runner with the real pipeline and the demo engines, over tone bursts written into
 * a PCM timeline as a decoder would (in pieces, ahead of time): cues on the media timeline, what
 * counts as done, the live path's switch, seeks and removed audio.
 */
import { describe, expect, it } from 'vitest';
import { EchoAsrEngine } from '@/engines/demo/echoAsr';
import { PassthroughTranslationEngine } from '@/engines/demo/passthroughTranslator';
import { LINE_BUDGET_MS, LOOKAHEAD_BUDGET_CAP_MS } from '@/engines/translators';
import type { TranslationEngine, TranslationRequest } from '@/engines/types';
import { PCM_RATE, PcmTimeline } from '@/lookahead/pcm';
import { LookaheadRunner, type RunnerTarget } from '@/lookahead/runner';
import type { Playhead } from '@/lookahead/scheduler';
import { isDone } from '@/overlay/captions';
import { Pipeline } from '@/pipeline/pipeline';
import type { Cue } from '@/pipeline/types';
import { burst, concat } from './helpers';

/** 30 s: a burst of tone for 1 s every 5 s, starting at 1 s. */
function audio(): Float32Array {
  const parts: Float32Array[] = [];
  for (let s = 0; s < 30; s += 5) parts.push(burst(1, 0), burst(1, 0.3), burst(3, 0));
  return concat(parts);
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Lets the runner work, with time passing (so the audio's end is noticed). */
async function flushAll(t: { runner: LookaheadRunner; advance(ms: number): void }, rounds = 50) {
  for (let i = 0; i < rounds; i++) {
    t.runner.kick();
    await settle();
    t.advance(100);
  }
}

function setup(translator: TranslationEngine = new PassthroughTranslationEngine()) {
  const pcm = new PcmTimeline();
  const cues = new Map<string, Cue>();
  const coverage: [number, number][][] = [];
  const drops: [number, number][] = [];
  const live: boolean[] = [];
  let now = 1_000_000;
  const runner = new LookaheadRunner({
    createPipeline: (media, hooks) =>
      new Pipeline({
        asr: new EchoAsrEngine(),
        translator,
        targetLanguage: 'en',
        sourceLanguage: null,
        media,
        onCue: hooks.onCue,
        onSegment: hooks.onSegment,
        onError: hooks.onError,
        untilShownMs: hooks.untilShownMs,
      }),
    pcm: (t) => (t === 'ms1' ? pcm : undefined),
    onCue: (cue) => cues.set(cue.id, cue),
    onCoverage: (_key, spans) => coverage.push(spans.map(([s, e]) => [s, e])),
    onDrop: (_key, s, e) => drops.push([s, e]),
    onLivePaused: (paused) => live.push(paused),
    now: () => now,
  });
  const target = (time: number, paused = true): RunnerTarget => ({
    timeline: 'ms1',
    key: 'video',
    ad: false,
    playhead: { time, rate: 1, paused, at: now } satisfies Playhead,
  });
  return {
    pcm,
    cues,
    coverage,
    drops,
    live,
    runner,
    target,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const finished = (cues: Map<string, Cue>) =>
  [...cues.values()].filter(isDone).sort((a, b) => (a.media?.start ?? 0) - (b.media?.start ?? 0));

describe('LookaheadRunner', () => {
  it('makes cues on the media timeline as the audio is decoded, without restarting', async () => {
    const t = setup();
    t.runner.setTarget(t.target(0));
    const samples = audio();
    // Decoded in 0.3 s pieces, as WebCodecs hands them out.
    const piece = Math.round(0.3 * PCM_RATE);
    for (let at = 0; at < samples.length; at += piece) {
      t.pcm.write(at, samples.subarray(at, at + piece));
      t.runner.kick();
      await settle();
      t.advance(20);
    }
    t.advance(5000);
    await flushAll(t);
    const done = finished(t.cues);
    expect(done.map((c) => Number(c.media?.start.toFixed(1)))).toEqual([
      0.9, 5.9, 10.9, 15.9, 20.9, 25.9,
    ]);
    for (const c of done) {
      expect(c.id.startsWith('L1:')).toBe(true);
      expect(c.origin).toBe('lookahead');
      expect((c.media?.end ?? 0) - (c.media?.start ?? 0)).toBeGreaterThan(1);
    }
    expect(t.runner.drops).toEqual([]);
    expect(t.runner.spans('video')).toEqual([[0, 30]]);
    // Far enough ahead: the live path steps aside.
    expect(t.live).toEqual([true]);
  });

  it('works from the playhead on, and starts over where the playhead jumps', async () => {
    const t = setup();
    const samples = audio();
    t.pcm.write(0, samples);
    t.runner.setTarget(t.target(12));
    await flushAll(t);
    // Nothing behind the playhead.
    expect(finished(t.cues).map((c) => Number(c.media?.start.toFixed(1)))).toEqual([
      15.9, 20.9, 25.9,
    ]);
    expect(t.runner.spans('video')).toEqual([[12, 30]]);
    // A seek back: the stretch before is done now, and what's done isn't redone.
    t.runner.setTarget(t.target(3));
    await flushAll(t);
    expect(finished(t.cues).map((c) => Number(c.media?.start.toFixed(1)))).toEqual([
      5.9, 10.9, 15.9, 20.9, 25.9,
    ]);
    expect(t.runner.spans('video')).toEqual([[3, 30]]);
  });

  it('redoes audio removed ahead of the playhead', async () => {
    const t = setup();
    t.pcm.write(0, audio());
    t.runner.setTarget(t.target(0));
    await flushAll(t);
    const before = finished(t.cues).length;
    t.runner.invalidate('video', 10, 20);
    await flushAll(t);
    expect(t.runner.spans('video')).toEqual([[0, 30]]);
    expect(finished(t.cues).length).toBe(before + 2);
  });

  it('gives each line until shortly before the playhead reaches it to translate', async () => {
    const inner = new PassthroughTranslationEngine();
    const requests: TranslationRequest[] = [];
    const translator: TranslationEngine = {
      info: inner.info,
      get state() {
        return inner.state;
      },
      load: () => inner.load(),
      unload: () => inner.unload(),
      translate(request) {
        requests.push(request);
        return inner.translate(request);
      },
    };
    const t = setup(translator);
    t.pcm.write(0, audio());
    t.runner.setTarget(t.target(0, false));
    expect(t.runner.untilShownMs(10)).toBe(10_000);
    expect(t.runner.untilShownMs(-1)).toBe(0);
    await flushAll(t);
    const budgets = requests.filter((r) => r.sourceFinal).map((r) => r.budgetMs ?? 0);
    expect(budgets).toHaveLength(6);
    // The first line is due at once: a live line's budget. Later ones get more, up to the cap.
    expect(budgets[0]).toBe(LINE_BUDGET_MS);
    expect(budgets.at(-1)).toBeGreaterThan(15_000);
    for (const [i, b] of budgets.entries()) {
      expect(b).toBeLessThanOrEqual(LOOKAHEAD_BUDGET_CAP_MS);
      if (i > 0) expect(b).toBeGreaterThanOrEqual(budgets[i - 1] ?? 0);
    }
    // Paused: nothing is due.
    t.runner.setTarget(t.target(0, true));
    expect(t.runner.untilShownMs(10)).toBe(Number.POSITIVE_INFINITY);
  });

  it('never works on an ad', async () => {
    const t = setup();
    t.pcm.write(0, audio());
    t.runner.setTarget({ ...t.target(0), ad: true });
    await flushAll(t);
    expect(t.cues.size).toBe(0);
    expect(t.runner.leadS).toBe(0);
  });
});
