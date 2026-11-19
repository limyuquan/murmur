/**
 * A model store that downloads nothing: progress advances on a timer and "downloaded" models are
 * remembered in `storage.local`. Stands in for the real store until real models exist; it only
 * ever handles planned models (`simulated: true`).
 */
import { browser } from 'wxt/browser';
import type { ModelInfo, ModelStore } from './types';

const KEY = 'simulatedModels';
/** MB per second. */
const SPEED = 80;
const TICK_MS = 250;

export class SimulatedModelStore implements ModelStore {
  async downloaded(): Promise<Set<string>> {
    const stored = await browser.storage.local.get(KEY);
    const ids = stored[KEY];
    return new Set(Array.isArray(ids) ? ids.filter((i): i is string => typeof i === 'string') : []);
  }

  async download(
    model: ModelInfo,
    onProgress: (receivedMB: number) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let received = 0;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearInterval(timer);
        reject(new DOMException('Download cancelled', 'AbortError'));
      };
      const timer = setInterval(() => {
        received = Math.min(model.sizeMB, received + (SPEED * TICK_MS) / 1000);
        onProgress(received);
        if (received >= model.sizeMB) {
          clearInterval(timer);
          signal.removeEventListener('abort', abort);
          resolve();
        }
      }, TICK_MS);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
    const ids = await this.downloaded();
    ids.add(model.id);
    await browser.storage.local.set({ [KEY]: [...ids] });
  }

  async remove(id: string): Promise<void> {
    const ids = await this.downloaded();
    ids.delete(id);
    await browser.storage.local.set({ [KEY]: [...ids] });
  }

  async availableMB(): Promise<number | null> {
    try {
      const { quota, usage } = await navigator.storage.estimate();
      if (quota === undefined) return null;
      return Math.max(0, Math.round((quota - (usage ?? 0)) / 1e6));
    } catch {
      return null;
    }
  }
}
