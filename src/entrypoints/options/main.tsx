import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { loadSettings } from '@/settings/settings';
import { IS_E2E } from '@/shared/e2e';
import { Options } from './Options';
import '@/styles/app.css';

if (IS_E2E) {
  // The bundled speech detector, loaded as the offscreen document loads it (e2e/vad.spec.ts).
  globalThis.__murmurVadCheck = async (samples) => {
    const started = performance.now();
    const { loadSileroVad } = await import('@/pipeline/silero-load');
    const vad = await loadSileroVad();
    const loadMs = performance.now() - started;
    const probs: number[] = [];
    const times: number[] = [];
    for (let i = 0; i + vad.frameSamples <= samples.length; i += vad.frameSamples) {
      const before = vad.cost.ms;
      probs.push(await vad.process(Float32Array.from(samples.slice(i, i + vad.frameSamples))));
      times.push(vad.cost.ms - before);
    }
    const msPerFrame = vad.cost.ms / Math.max(1, vad.cost.frames);
    const medianMs = times.sort((a, b) => a - b)[times.length >> 1] ?? 0;
    await vad.dispose();
    return { probs, loadMs, msPerFrame, medianMs };
  };
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

loadSettings().then(
  (settings) =>
    createRoot(root).render(
      <StrictMode>
        <Options initial={settings} />
      </StrictMode>,
    ),
  (err: Error) => {
    root.textContent = err.message;
  },
);
