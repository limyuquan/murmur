/**
 * The offscreen lookahead host with stand-in ports: playhead reports on its own clock, bounded
 * warnings, and what a new overlay is told.
 */
import { describe, expect, it } from 'vitest';
import { toBase64 } from '@/lookahead/bytes';
import { KEPT_CUES, LookaheadHost, type LookaheadPort } from '@/lookahead/host';
import type { PlayheadReport } from '@/lookahead/protocol';
import type { OverlayMessage } from '@/messaging/protocol';
import type { Cue } from '@/pipeline/types';

function setup() {
  let now = 5_000_000;
  const posted: OverlayMessage[] = [];
  const host = new LookaheadHost({
    post: (m) => posted.push(m),
    createPipeline: () => null,
    setLivePaused: () => {},
    measureLag: false,
    now: () => now,
  });
  const port: LookaheadPort & { got: OverlayMessage[] } = {
    got: [],
    postMessage(m) {
      this.got.push(m);
    },
  };
  return {
    host,
    port,
    posted,
    advance: (ms: number) => {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

const report = (over: Partial<PlayheadReport> = {}): PlayheadReport => ({
  timeline: 'ms1',
  key: 'video',
  ad: false,
  time: 10,
  rate: 1,
  paused: false,
  at: 0,
  duration: 60,
  ...over,
});

describe('LookaheadHost', () => {
  it('takes a playhead report’s time as of now, on its own clock', async () => {
    const t = setup();
    // The page's clock is far off (another document, asleep): its `at` is ignored.
    t.host.onPlayhead(t.port, 'https://example.com/', report({ at: 123 }));
    t.advance(2000);
    const target = t.host.snapshot().target;
    expect(target?.playhead).toBeCloseTo(12, 5);
    await t.host.stop();
  });

  it('keeps a bounded number of warnings, each short', async () => {
    const t = setup();
    t.host.onTee(t.port, 'https://example.com/', {
      t: 'sb',
      sb: 's1',
      ms: 'ms1',
      mime: 'audio/mp4',
      kind: 'audio',
    });
    // Bytes the demuxer warns about, each with a different (page-made) box type.
    for (let i = 0; i < 200; i++) {
      const box = new Uint8Array(8);
      new DataView(box.buffer).setUint32(0, 8);
      box.set(new TextEncoder().encode(`x${String(i).padStart(3, '0')}`), 4);
      t.host.onTee(t.port, 'https://example.com/', {
        t: 'append',
        sb: 's1',
        bytes: toBase64(box),
        tso: 0,
        aws: 0,
        awe: null,
        sequence: false,
      });
    }
    const warnings = t.host.snapshot().warnings;
    expect(warnings.length).toBeLessThanOrEqual(50);
    expect(warnings.every((w) => w.length <= 121)).toBe(true);
    await t.host.stop();
  });

  it('gives an overlay that comes back the cues made before, then where they are finished', async () => {
    const t = setup();
    const inner = t.host as unknown as {
      runner: {
        processedFor(key: string): { add(s: number, e: number): void };
        spans(key: string): readonly (readonly [number, number])[];
      };
      keep(cue: Cue): void;
    };
    inner.keep(mediaCue('L1:s1', 12, 14));
    inner.keep(mediaCue('L1:s2', 20, 22));
    inner.runner.processedFor('video').add(10, 30);
    // The page reloaded: a new overlay, the same video.
    const again: LookaheadPort & { got: OverlayMessage[] } = {
      got: [],
      postMessage(m) {
        this.got.push(m);
      },
    };
    t.host.onPlayhead(again, 'https://example.com/', report());
    expect(again.got.map((m) => m.type)).toEqual(['cue', 'cue', 'coverage']);
    expect(again.got.at(-1)).toEqual({ type: 'coverage', timeline: 'video', spans: [[10, 30]] });
    // Only once per video.
    t.host.onPlayhead(again, 'https://example.com/', report({ time: 11 }));
    expect(again.got).toHaveLength(3);
    await t.host.stop();
  });

  it('keeps a bounded number of cues, letting the far ones go to be made again', async () => {
    const t = setup();
    const inner = t.host as unknown as {
      runner: {
        processedFor(key: string): { add(s: number, e: number): void };
        spans(key: string): readonly (readonly [number, number])[];
      };
      keep(cue: Cue): void;
    };
    t.host.onPlayhead(t.port, 'https://example.com/', report({ time: 0 }));
    inner.runner.processedFor('video').add(0, KEPT_CUES + 100);
    for (let i = 0; i < KEPT_CUES + 10; i++) inner.keep(mediaCue(`L1:s${i}`, i, i + 0.5));
    const drops = t.posted.filter((m) => m.type === 'drop');
    expect(drops.length).toBeGreaterThan(0);
    // The farthest went, and their stretch is no longer finished.
    const spans = inner.runner.spans('video');
    const covered = (x: number) => spans.some(([s, e]) => x >= s && x < e);
    expect(covered(1.2)).toBe(true);
    expect(covered(KEPT_CUES - 100 + 0.2)).toBe(false);
    await t.host.stop();
  });
});

function mediaCue(id: string, start: number, end: number): Cue {
  return {
    id,
    seq: 1,
    startEpochMs: 0,
    endEpochMs: 0,
    origin: 'lookahead',
    media: { timeline: 'video', start, end },
    source: { text: 'x', language: 'fr', final: true },
    translation: { text: 'y', language: 'en', final: true },
    untranslated: null,
  };
}
