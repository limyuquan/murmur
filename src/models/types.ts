/**
 * Downloadable models, as the options page, onboarding and popup see them. Engines declare their
 * models (`EngineInfo.models`); profiles whose engines don't exist yet show planned models
 * (planned.ts) whose downloads are simulated, so the whole flow can be built and tried.
 *
 * The service worker owns downloads (`ModelManager`, manager.ts) so they carry on when the page
 * that started them closes; progress lives in `storage.session` under `DOWNLOADS_KEY` for pages to
 * follow, and what's downloaded is reported by the `ModelStore`.
 */
import type { ProfileId } from '@/engines/profiles';

export type ModelRole = 'speech' | 'translation';

export interface ModelInfo {
  id: string;
  label: string;
  role: ModelRole;
  sizeMB: number;
  /** Where it runs: in the browser, or in the companion app. */
  runtime: 'browser' | 'companion';
  /** A placeholder for a model that isn't available yet: its download is simulated. */
  simulated: boolean;
}

export type ModelState =
  | { state: 'absent' }
  | { state: 'queued' }
  | { state: 'downloading'; receivedMB: number }
  | { state: 'ready' }
  | { state: 'error'; message: string };

export interface ModelEntry {
  info: ModelInfo;
  status: ModelState;
  /** Profiles that use it. */
  profiles: ProfileId[];
}

export interface StorageUse {
  /** Space downloaded models take, MB. */
  modelsMB: number;
  /** Free space the browser will give the extension, MB, when known. */
  availableMB: number | null;
}

export interface ModelsView {
  models: ModelEntry[];
  storage: StorageUse;
}

/** `storage.session` key: download progress by model id. */
export const DOWNLOADS_KEY = 'downloads';
export type DownloadProgress = Record<
  string,
  Extract<ModelState, { state: 'queued' | 'downloading' | 'error' }>
>;

/**
 * Where model files live. The real store (Cache API / OPFS, in the offscreen document or a
 * worker) replaces the simulated one; the manager doesn't change.
 */
export interface ModelStore {
  /** Ids of the models that are fully downloaded. */
  downloaded(): Promise<Set<string>>;
  /** Fetches `model`, reporting MB received. Rejects with an AbortError when `signal` fires. */
  download(
    model: ModelInfo,
    onProgress: (receivedMB: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
  remove(id: string): Promise<void>;
  /** Free space for more models, MB, when known. */
  availableMB(): Promise<number | null>;
}

/** Plain size: "850 MB", "2.4 GB". */
export function formatSize(mb: number): string {
  if (mb < 1000) return `${Math.round(mb)} MB`;
  const gb = mb / 1000;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}
