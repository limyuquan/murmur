/**
 * Downloadable models, as the options page, onboarding and popup see them. Engines declare their
 * models (`EngineInfo.models`) with the exact files to fetch; the catalog (catalog.ts) picks the
 * ones this device needs.
 *
 * The service worker owns downloads (`ModelManager`, manager.ts) so they carry on when the page
 * that started them closes; progress lives in `storage.session` under `DOWNLOADS_KEY` for pages to
 * follow, and what's on disk is reported by the `ModelStore` (store.ts: the Cache API).
 */
import type { ProfileId } from '@/engines/profiles';
import type { ModelSource } from './hub';

export type ModelRole = 'speech' | 'translation';

export interface ModelInfo {
  id: string;
  label: string;
  role: ModelRole;
  sizeMB: number;
  /** Where it runs: in the browser, or in the companion app. */
  runtime: 'browser' | 'companion';
  /** The files to download (Hugging Face repo at a pinned revision). */
  source: ModelSource;
}

export type ModelState =
  | { state: 'absent' }
  /** Part of it is on disk (a download was cancelled or cut off); downloading again resumes. */
  | { state: 'partial'; receivedMB: number }
  | { state: 'queued' }
  | { state: 'downloading'; receivedMB: number }
  | { state: 'ready' }
  | { state: 'error'; message: string };

export interface ModelEntry {
  info: ModelInfo;
  status: ModelState;
  /** Profiles that use it on this device (empty: a model on disk that no profile needs now). */
  profiles: ProfileId[];
}

export interface StorageUse {
  /** Space model files take, finished or not, MB. */
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

/** Where model files live. */
export interface ModelStore {
  /** Ids of `models` whose files are all on disk. */
  downloaded(models: readonly ModelInfo[]): Promise<Set<string>>;
  /** How much of `model` is on disk, MB (its size once downloaded). */
  storedMB(model: ModelInfo): Promise<number>;
  /**
   * Fetches what's missing of `model`, resuming from what's on disk, and reports MB on disk as it
   * goes. Rejects with an AbortError when `signal` fires; what arrived so far is kept.
   */
  download(
    model: ModelInfo,
    onProgress: (receivedMB: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /** Deletes `model`'s files, except files that a model in `keep` also uses. */
  remove(model: ModelInfo, keep: readonly ModelInfo[]): Promise<void>;
  /** Space every stored model file takes, MB. */
  usageMB(): Promise<number>;
  /** Free space for more models, MB, when known. */
  availableMB(): Promise<number | null>;
}

/** Plain size: "850 MB", "2.4 GB". */
export function formatSize(mb: number): string {
  if (mb < 1000) return `${Math.round(mb)} MB`;
  const gb = mb / 1000;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

export const MB = 1e6;
