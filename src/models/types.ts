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
  /** `checking`: every byte arrived; how much of it was checked against its hash (0–1). */
  | { state: 'downloading'; receivedMB: number; checking?: number }
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
  /**
   * Free space the browser says it will give the extension, MB, when known: with
   * `unlimitedStorage`, about the free space on the disk. More than downloads can use (see
   * `DISK_RESERVE_MB`); pages show `spaceForModelsMB` of it.
   */
  availableMB: number | null;
}

/**
 * Disk space downloads leave free, MB. The browser's figure (`StorageUse.availableMB`) is more
 * than it will write: on a Mac whose disk had 8.6 GB free (the browser said 9.3 GB), saving a
 * model failed once about 4.5 GB were left, as "Cache.put() encountered a network error". And
 * the system needs room on the disk to swap while large models load (1.7 GB more swap on a
 * 16 GB Mac loading Qwen3-ASR 1.7B).
 */
export const DISK_RESERVE_MB = 5000;

/** Of what the browser says is free (MB), the part downloads may use; null when unknown. */
export function spaceForModelsMB(availableMB: number | null): number | null {
  return availableMB === null ? null : Math.max(0, availableMB - DISK_RESERVE_MB);
}

/**
 * "about 4.3 GB of disk space for more models": what pages show of the free space, the reserve
 * taken off (the browser's own figure would promise space a download can't use). Null when
 * unknown.
 */
export function freeSpaceText(availableMB: number | null): string | null {
  const space = spaceForModelsMB(availableMB);
  return space === null ? null : `about ${formatSize(space)} of disk space for more models`;
}

/** A download that can't fit on the disk, or a save that failed for want of space. */
export class DiskSpaceError extends Error {
  override readonly name = 'DiskSpaceError';
  constructor(
    /** What the model still needs, MB. */
    readonly neededMB: number,
    /** What the browser says is free, MB, when known. */
    readonly availableMB: number | null,
  ) {
    super(diskSpaceMessage(neededMB, availableMB));
  }
}

/**
 * "Not enough disk space: need 8 GB (3 GB for the model, 5 GB kept free), 7 GB free. …", in
 * plain words.
 */
export function diskSpaceMessage(neededMB: number, availableMB: number | null): string {
  const fix = 'Free up space on this disk or remove models you don’t use, then download again.';
  const need = `need ${formatSize(neededMB + DISK_RESERVE_MB)} (${formatSize(neededMB)} for the model, ${formatSize(DISK_RESERVE_MB)} kept free for the system)`;
  return availableMB === null
    ? `Not enough disk space: ${need}. ${fix}`
    : `Not enough disk space: ${need}, ${formatSize(availableMB)} free. ${fix}`;
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
   * Fetches what's missing of `model`, resuming from what's on disk, checks each file not yet
   * checked, and reports MB on disk as it goes (and, while checking, how much of the file being
   * checked is done, 0–1). Rejects with an AbortError when `signal` fires; what arrived so far is
   * kept.
   */
  download(
    model: ModelInfo,
    onProgress: (receivedMB: number, checking?: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /** Deletes `model`'s files, except files that a model in `keep` also uses. */
  remove(model: ModelInfo, keep: readonly ModelInfo[]): Promise<void>;
  /** Space every stored model file takes, MB. */
  usageMB(): Promise<number>;
  /** Deletes stored files that no model in `known` has (an older revision's), if it can. */
  prune?(known: readonly ModelInfo[]): Promise<void>;
  /** Free space the browser says it will give, MB, when known (`StorageUse.availableMB`). */
  availableMB(): Promise<number | null>;
}

/** Plain size: "850 MB", "2.4 GB". */
export function formatSize(mb: number): string {
  if (mb < 1000) return `${Math.round(mb)}\u00a0MB`;
  const gb = mb / 1000;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)}\u00a0GB`;
}

export const MB = 1e6;
