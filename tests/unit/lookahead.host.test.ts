/**
 * The offscreen lookahead host with stand-in ports: playhead reports on its own clock, bounded
 * warnings, and what a new overlay is told.
 */
import { describe, expect, it } from 'vitest';
import { toBase64 } from '@/lookahead/bytes';
import { LookaheadHost, type LookaheadPort } from '@/lookahead/host';
import type { PlayheadReport } from '@/lookahead/protocol';
import type { OverlayMessage } from '@/messaging/protocol';

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
});
