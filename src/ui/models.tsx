/** Profile picker and model manager, shared by the options page and the welcome page. */
import type { ReactNode } from 'react';
import { packsFor } from '@/engines/chrome/setup';
import { checkEngine, type HardwareInfo } from '@/engines/hardware';
import {
  PROFILE_ORDER,
  PROFILES,
  type ProfileChoice,
  type ProfileId,
  recommendProfile,
  resolveEngines,
} from '@/engines/profiles';
import type { EngineRegistry } from '@/engines/registry';
import type { SetupAction } from '@/engines/types';
import { modelsFor, totalMB } from '@/models/catalog';
import { formatSize, type ModelEntry, type ModelInfo, type ModelsView } from '@/models/types';
import type { Settings } from '@/settings/settings';
import { Icon, Meter, ProgressBar } from './components';
import type { ModelActions } from './hooks';
import { PackRow, usePacks } from './setup';
import { chosenSpoken } from './spoken';

interface ProfileCopy {
  /** Who it's for. */
  suits: string;
  accuracy: { level: 1 | 2 | 3; text: string };
  runsOn: string;
  /** The honest catch. */
  tradeoff: string;
}

export const PROFILE_COPY: Record<ProfileId, ProfileCopy> = {
  light: {
    suits: 'Most computers. No graphics card needed.',
    accuracy: { level: 1, text: 'Fair' },
    runsOn: 'Chrome’s own speech recognition and translation, on this computer',
    tradeoff:
      'Nothing to download from Murmur: Chrome downloads a small pack for each language. More mistakes with fast speech, music and names.',
  },
  balanced: {
    suits: 'Recent computers with a graphics chip, including Apple Silicon.',
    accuracy: { level: 2, text: 'Good' },
    runsOn: 'Whisper on the graphics chip; Chrome’s translation',
    tradeoff: 'Good for most videos. Needs WebGPU.',
  },
  best: {
    suits: 'Desktop graphics cards, or with the companion app.',
    accuracy: { level: 3, text: 'Best' },
    runsOn: 'Whisper on the graphics card; Chrome’s translation',
    tradeoff: 'For now the same models as Balanced. Larger ones come with the companion app.',
  },
};

const RANK: Record<ProfileId, number> = { light: 0, balanced: 1, best: 2 };

export interface ProfileModels {
  models: ModelInfo[];
  totalMB: number;
  missingMB: number;
  ready: boolean;
  /** 0–1 while any of its models is downloading, else null. */
  downloading: number | null;
}

/** Download state of what `profile` needs. */
export function profileModels(
  profile: ProfileChoice,
  settings: Settings,
  registry: EngineRegistry,
  hardware: HardwareInfo,
  view: ModelsView | null,
): ProfileModels {
  const models = modelsFor(profile, settings.custom, registry, hardware);
  const entries = models.map((m) => view?.models.find((e) => e.info.id === m.id));
  const missing = models.filter((_, i) => entries[i]?.status.state !== 'ready');
  let received = 0;
  let busy = false;
  for (const [i, e] of entries.entries()) {
    const s = e?.status;
    if (s?.state === 'downloading') {
      busy = true;
      received += s.receivedMB;
    } else if (s?.state === 'queued') busy = true;
    else if (s?.state === 'ready') received += models[i]?.sizeMB ?? 0;
    else if (s?.state === 'partial') received += s.receivedMB;
  }
  const total = totalMB(models);
  return {
    models,
    totalMB: total,
    missingMB: totalMB(missing),
    ready: view !== null && missing.length === 0,
    downloading: busy && total > 0 ? received / total : null,
  };
}

/** A plain warning when `profile` is heavier than this device suits, else null. */
export function fitWarning(profile: ProfileId, hardware: HardwareInfo | null): string | null {
  if (!hardware) return null;
  const suggested = recommendProfile(hardware);
  if (RANK[profile] <= RANK[suggested]) return null;
  if (profile === 'balanced' || !hardware.webgpu.available) {
    return 'This device has no WebGPU, so this would run slowly and fall behind.';
  }
  return 'Needs a stronger graphics card or the companion app; subtitles may fall behind.';
}

export function ProfileCards({
  value,
  onChange,
  hardware,
  modelsOf,
  includeCustom = true,
  name = 'profile',
}: {
  value: ProfileChoice;
  onChange(next: ProfileChoice): void;
  hardware: HardwareInfo | null;
  modelsOf(profile: ProfileId): ProfileModels;
  includeCustom?: boolean;
  name?: string;
}) {
  const suggested = hardware ? recommendProfile(hardware) : null;
  return (
    <div role="radiogroup" aria-label="Model size" className="grid gap-2.5">
      {PROFILE_ORDER.map((id) => {
        const copy = PROFILE_COPY[id];
        const models = modelsOf(id);
        const warning = fitWarning(id, hardware);
        return (
          <label key={id} className="option-card" data-testid={`profile-${id}`}>
            <input
              type="radio"
              name={name}
              value={id}
              checked={value === id}
              onChange={() => onChange(id)}
              aria-describedby={`${name}-${id}-desc`}
            />
            <div className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className="mt-0.5 grid size-4 flex-none place-items-center rounded-full border border-[var(--color-line-strong)]"
              >
                {value === id && <span className="size-2 rounded-full bg-[var(--color-accent)]" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-semibold">{PROFILES[id].label}</span>
                  {suggested === id && (
                    <span className="badge badge-accent">Suits this device</span>
                  )}
                  <ModelStateBadge models={models} />
                </div>
                <div id={`${name}-${id}-desc`}>
                  <p className="mt-0.5 text-[var(--color-muted)]">{copy.suits}</p>
                  <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
                    <dt className="text-[var(--color-muted)]">Accuracy</dt>
                    <dd>
                      <Meter level={copy.accuracy.level} text={copy.accuracy.text} />
                    </dd>
                    <dt className="text-[var(--color-muted)]">Download</dt>
                    <dd>
                      {models.totalMB > 0
                        ? formatSize(models.totalMB)
                        : 'Chrome’s language packs only'}
                    </dd>
                    <dt className="text-[var(--color-muted)]">Runs</dt>
                    <dd>{copy.runsOn}</dd>
                  </dl>
                  <p className="mt-2 text-[13px] text-[var(--color-muted)]">{copy.tradeoff}</p>
                  {warning && (
                    <p className="mt-2 text-[13px] text-[var(--color-warn)]">{warning}</p>
                  )}
                </div>
              </div>
            </div>
          </label>
        );
      })}
      {includeCustom && (
        <label className="option-card" data-testid="profile-custom">
          <input
            type="radio"
            name={name}
            value="custom"
            checked={value === 'custom'}
            onChange={() => onChange('custom')}
          />
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="mt-0.5 grid size-4 flex-none place-items-center rounded-full border border-[var(--color-line-strong)]"
            >
              {value === 'custom' && (
                <span className="size-2 rounded-full bg-[var(--color-accent)]" />
              )}
            </span>
            <div>
              <span className="text-[15px] font-semibold">Custom</span>
              <p className="mt-0.5 text-[var(--color-muted)]">
                Choose the speech recognition and translation engines yourself.
              </p>
            </div>
          </div>
        </label>
      )}
    </div>
  );
}

function ModelStateBadge({ models }: { models: ProfileModels }) {
  if (models.downloading !== null) {
    return (
      <span className="badge badge-accent">
        Downloading {Math.round(models.downloading * 100)}%
      </span>
    );
  }
  if (models.ready && models.totalMB > 0) {
    return (
      <span className="badge">
        <Icon name="check" size={12} /> Downloaded
      </span>
    );
  }
  return null;
}

/** "Speech recognition, small" with its state and actions, for each model. */
export function ModelList({
  view,
  actions,
  filter,
}: {
  view: ModelsView;
  actions: ModelActions;
  /** Show only these ids (in this order). */
  filter?: readonly string[];
}) {
  const entries = filter
    ? filter
        .map((id) => view.models.find((m) => m.info.id === id))
        .filter((m): m is ModelEntry => !!m)
    : view.models;
  return (
    <ul className="divide-y divide-[var(--color-line)]" aria-label="Models">
      {entries.map((m) => (
        <ModelRow key={m.info.id} entry={m} actions={actions} />
      ))}
    </ul>
  );
}

function ModelRow({ entry, actions }: { entry: ModelEntry; actions: ModelActions }) {
  const { info, status, profiles } = entry;
  let state: ReactNode;
  let action: ReactNode;
  switch (status.state) {
    case 'ready':
      state = (
        <span className="inline-flex items-center gap-1 text-[var(--color-accent)]">
          <Icon name="check" size={14} /> Downloaded
        </span>
      );
      action = (
        <button
          type="button"
          className="btn btn-sm btn-quiet"
          onClick={() => actions.remove(info.id)}
          aria-label={`Delete ${info.label}`}
        >
          <Icon name="trash" size={14} /> Delete
        </button>
      );
      break;
    case 'downloading':
    case 'queued': {
      // Waiting its turn: an empty bar, not a moving one.
      const fraction = status.state === 'downloading' ? status.receivedMB / info.sizeMB : 0;
      state = (
        <span className="flex min-w-[140px] flex-col gap-1">
          <span className="text-[var(--color-muted)]">
            {status.state === 'queued'
              ? 'Waiting…'
              : `${formatSize(status.receivedMB)} of ${formatSize(info.sizeMB)}`}
          </span>
          <ProgressBar value={fraction} label={`Downloading ${info.label}`} />
        </span>
      );
      action = (
        <button
          type="button"
          className="btn btn-sm btn-quiet"
          onClick={() => actions.cancel(info.id)}
          aria-label={`Cancel downloading ${info.label}`}
        >
          Cancel
        </button>
      );
      break;
    }
    case 'partial':
      state = (
        <span className="text-[var(--color-muted)]">
          Stopped at {formatSize(status.receivedMB)} of {formatSize(info.sizeMB)}
        </span>
      );
      action = (
        <span className="flex gap-2">
          <button
            type="button"
            className="btn btn-sm btn-quiet"
            onClick={() => actions.remove(info.id)}
            aria-label={`Delete the part of ${info.label} downloaded so far`}
          >
            <Icon name="trash" size={14} /> Delete
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => actions.download([info.id])}
            aria-label={`Resume downloading ${info.label}`}
          >
            <Icon name="download" size={14} /> Resume
          </button>
        </span>
      );
      break;
    case 'error':
      state = <span className="text-[var(--color-danger)]">{status.message}</span>;
      action = (
        <button type="button" className="btn btn-sm" onClick={() => actions.download([info.id])}>
          Try again
        </button>
      );
      break;
    case 'absent':
      state = <span className="text-[var(--color-muted)]">Not downloaded</span>;
      action = (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => actions.download([info.id])}
          aria-label={`Download ${info.label}, ${formatSize(info.sizeMB)}`}
        >
          <Icon name="download" size={14} /> Download
        </button>
      );
      break;
  }
  return (
    <li
      className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
      data-testid={`model-${info.id}`}
    >
      <span className="grid size-8 flex-none place-items-center rounded-lg bg-[var(--color-sunken)] text-[var(--color-muted)]">
        <Icon name={info.role === 'speech' ? 'speech' : 'globe'} />
      </span>
      <span className="min-w-[180px] flex-1">
        <span className="block font-medium">{info.label}</span>
        <span className="block text-[12px] text-[var(--color-muted)]">
          {formatSize(info.sizeMB)}
          {profiles.length > 0 ? ` · ${profiles.map((p) => PROFILES[p].label).join(', ')}` : ''}
          {info.runtime === 'companion' && ' · companion app'}
        </span>
      </span>
      <span className="text-[13px]">{state}</span>
      <span className="ml-auto">{action}</span>
    </li>
  );
}

/** What this device offers, in plain words. */
export function HardwareSummary({ hardware }: { hardware: HardwareInfo | null }) {
  if (!hardware) return <p className="text-[var(--color-muted)]">Checking this device…</p>;
  const gpu = hardware.webgpu.available
    ? hardware.webgpu.shaderF16
      ? 'WebGPU, with 16-bit floats'
      : 'WebGPU'
    : 'No WebGPU';
  const memory =
    hardware.deviceMemoryGB === null
      ? 'Unknown'
      : hardware.deviceMemoryGB >= 8
        ? '8 GB or more'
        : `About ${hardware.deviceMemoryGB} GB`;
  const rows: [string, string][] = [
    ['Graphics', gpu],
    ['Memory', memory],
    ['Processor', `${hardware.cores} threads`],
    ['Companion app', hardware.companion ? 'Running' : 'Not running'],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]" data-testid="hardware">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[var(--color-muted)]">{k}</dt>
          <dd className="whitespace-nowrap">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Whether an engine fits this device (custom picker). */
export function engineFits(
  info: Parameters<typeof checkEngine>[0],
  hw: HardwareInfo | null,
): boolean {
  if (info.unavailable) return false;
  return hw === null || checkEngine(info, hw).ok;
}

/** Chrome's language packs a choice of engines and languages needs, with their status. */
export function ChromePacks({
  actions,
  compact,
}: {
  actions: readonly SetupAction[];
  compact?: boolean;
}) {
  const [states, run] = usePacks(actions);
  return (
    <ul className="divide-y divide-[var(--color-line)]" aria-label="Chrome language packs">
      {actions.map((a) => (
        <PackRow key={a.id} action={a} state={states[a.id]} run={run} compact={compact ?? false} />
      ))}
    </ul>
  );
}

/** Chrome packs `settings` needs on this device (its profile's engines, its languages). */
export function packsForSettings(
  settings: Settings,
  registry: EngineRegistry,
  hardware: HardwareInfo,
): SetupAction[] {
  const engines = resolveEngines(settings.profile, settings.custom, registry, hardware);
  return packsFor({
    asr: engines.asr,
    translation: engines.translation,
    spoken: chosenSpoken(settings),
    target: settings.targetLanguage,
  });
}
