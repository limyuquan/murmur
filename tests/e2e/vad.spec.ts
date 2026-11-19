/**
 * The speech detector in a real browser: the bundled Silero model and ONNX Runtime's WebAssembly
 * load from the extension's own files (nothing from the network), hear the speech in the unit
 * tests' clip, and stay cheap. The options page of e2e builds loads it the way the offscreen
 * document does (`__murmurVadCheck`).
 */
import { readFileSync } from 'node:fs';
import { EXTENSION_ID } from '@/shared/ids';
import { expect, test } from './fixtures';

/** A 16-bit mono WAV's samples (the clip's header is the plain 44 bytes). */
function wav(path: string): number[] {
  const buf = readFileSync(path);
  const out: number[] = [];
  for (let i = 44; i + 1 < buf.length; i += 2) out.push(buf.readInt16LE(i) / 32768);
  return out;
}

test('Silero VAD loads from the extension and tells speech from silence', async ({ context }) => {
  const page = await context.newPage();
  const fetched: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith(`chrome-extension://${EXTENSION_ID}/`)) fetched.push(r.url());
  });
  await page.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
  const speech = wav('tests/unit/fixtures/vad/speech.wav');
  const audio = [...speech, ...new Array<number>(16_000).fill(0)];
  const result = await page.evaluate((samples) => globalThis.__murmurVadCheck?.(samples), audio);
  expect(result).toBeDefined();
  if (!result) return;
  const frames = Math.floor(speech.length / 512);
  const speechShare = result.probs.slice(16, frames).filter((p) => p >= 0.5).length / (frames - 16);
  expect(speechShare).toBeGreaterThan(0.95);
  expect(Math.max(...result.probs.slice(frames + 2))).toBeLessThan(0.1);
  // 32 ms of audio per frame. The mean includes the first frames, while the browser still
  // compiles the WebAssembly, and any time the test machine is busy: the median is the cost.
  expect(result.medianMs).toBeLessThan(2);
  expect(fetched).toEqual([]);
  test.info().annotations.push({
    type: 'silero',
    description: `load ${result.loadMs.toFixed(0)} ms, ${result.medianMs.toFixed(2)} ms/frame median, ${result.msPerFrame.toFixed(2)} mean`,
  });
  console.log(`silero: ${test.info().annotations.at(-1)?.description}`);
});
