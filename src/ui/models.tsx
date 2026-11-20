/** Profile picker and model manager, shared by the options page and the welcome page. */
import type { ReactNode } from 'react';
import { packsFor } from '@/engines/chrome/setup';
import { checkEngine, gpuKey, type HardwareInfo, sharesMemory } from '@/engines/hardware';
import {
  PROFILE_ORDER,
  PROFILES,
  type ProfileChoice,
  type ProfileId,
  type ResolvedEngines,
  recommendProfile,
  resolveEngines,
} from '@/engines/profiles';
import type { EngineRegistry } from '@/engines/registry';
import type { SetupAction } from '@/engines/types';
import { modelsFor, totalMB } from '@/models/catalog';
import { formatSize, type ModelEntry, type ModelInfo, type ModelsView } from '@/models/types';
import { type MemoryFit, resolveOptions, saveMemoryFit } from '@/settings/memoryfit';
import type { Settings, SettingsChange } from '@/settings/settings';
import { browserGaps } from './browser';
import { Checkbox, Icon, Meter, Notice, ProgressBar, State } from './components';
import { engineNames, memoryFitCopy, memoryText, smallerSpeechCopy } from './fitcopy';
import type { ModelActions } from './hooks';
import { PackRow, usePacks } from './setup';
import { chosenSpoken } from './spoken';

interface ProfileCopy {
  /** Who it's for. */
  suits: string;
  accuracy: { level: 1 | 2 | 3; text: string };
  /** Where it runs; the engines it runs on this device come first (`ProfileModels.runs`). */
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
    suits: 'Computers with a graphics card or recent built-in graphics, including Apple silicon.',
    accuracy: { level: 2, text: 'Good' },
    runsOn: 'on the graphics card',
    tradeoff:
      'A large one-time download. Where graphics memory is short, smaller models run instead.',
  },
  best: {
    suits: 'Graphics cards with their own memory, 6\u00a0GB or more.',
    accuracy: { level: 3, text: 'Best' },
    runsOn: 'on the graphics card',
    tradeoff:
      'The largest download, and translations take about twice as long as Balanced’s. Where graphics memory is short, smaller models run instead.',
  },
};

const RANK: Record<ProfileId, number> = { light: 0, balanced: 1, best: 2 };

export interface ProfileModels {
  /** The engines it runs on this device ("Qwen3-ASR 1.7B and Gemma 4 E2B"), when known. */
  runs?: string;
  /** What it resolved to here, with its memory ladder. */
  engines?: ResolvedEngines;
  models: ModelInfo[];
  totalMB: number;
  missingMB: number;
  ready: boolean;
  /** 0–1 while any of its models is downloading, else null. */
  downloading: number | null;
}

/**
 * Download state of what `profile` needs on this device (`fit`: which step of its memory ladder
 * worked here, settings/memoryfit.ts).
 */
export function profileModels(
  profile: ProfileChoice,
  settings: Settings,
  registry: EngineRegistry,
  hardware: HardwareInfo,
  view: ModelsView | null,
  fit: MemoryFit | null = null,
): ProfileModels {
  const options = resolveOptions(settings, profile, hardware, fit);
  const engines = resolveEngines(profile, settings.custom, registry, hardware, options);
  const models = modelsFor(profile, settings.custom, registry, hardware, options);
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
    runs: engineNames(engines, registry),
    engines,
    models,
    totalMB: total,
    missingMB: totalMB(missing),
    ready: view !== null && missing.length === 0,
    downloading: busy && total > 0 ? received / total : null,
  };
}

/**
 * "3.6 GB: speech recognition 1.6 GB, translation 2.0 GB", or just the size with models of one
 * kind.
 */
export function downloadText(models: readonly ModelInfo[]): string {
  const total = formatSize(totalMB(models));
  const of = (role: ModelInfo['role']) => totalMB(models.filter((m) => m.role === role));
  const speech = of('speech');
  const translation = of('translation');
  if (speech === 0 || translation === 0) return total;
  return `${total}: speech recognition ${formatSize(speech)}, translation ${formatSize(translation)}`;
}

/** A plain warning when `profile` is heavier than this device suits, else null. */
export function fitWarning(profile: ProfileId, hardware: HardwareInfo | null): string | null {
  if (!hardware) return null;
  const suggested = recommendProfile(hardware);
  if (RANK[profile] <= RANK[suggested]) return null;
  if (profile === 'balanced' || !hardware.webgpu.available) {
    return 'This device has no WebGPU, so this would run slowly and fall behind.';
  }
  if (sharesMemory(hardware.webgpu)) {
    return 'On graphics that share the computer’s memory, Best starts with Balanced’s models: its largest translation model falls behind here. You can still choose it below.';
  }
  return 'Needs a stronger graphics card; subtitles may fall behind.';
}

export function ProfileCards({
  value,
  onChange,
  hardware,
  modelsOf,
  includeCustom = true,
  name = 'profile',
  foot,
}: {
  value: ProfileChoice;
  onChange(next: ProfileChoice): void;
  hardware: HardwareInfo | null;
  modelsOf(profile: ProfileId): ProfileModels;
  includeCustom?: boolean;
  name?: string;
  /** Drawn inside the chosen card, under its facts (its download). */
  foot?: ReactNode;
}) {
  const suggested = hardware ? recommendProfile(hardware) : null;
  return (
    <div role="radiogroup" aria-label="Model size" className="stack g3">
      {PROFILE_ORDER.map((id) => {
        const copy = PROFILE_COPY[id];
        const models = modelsOf(id);
        const warning = fitWarning(id, hardware);
        return (
          <div key={id} className="option" data-testid={`profile-${id}`}>
            <label>
              <input
                type="radio"
                className="native"
                name={name}
                value={id}
                checked={value === id}
                onChange={() => onChange(id)}
                aria-describedby={`${name}-${id}-desc`}
              />
              <span className="radio" aria-hidden="true" />
              <div className="grow stack g3">
                <div className="stack g1">
                  <div className="row between g4">
                    <span className="row g2 wrap">
                      <span className="t-heading">{PROFILES[id].label}</span>
                      {suggested === id && (
                        <span className="badge" data-tone="accent">
                          Suits this device
                        </span>
                      )}
                      <ModelStateBadge models={models} />
                    </span>
                    <span className="row g2 t-small">
                      <span className="muted">Accuracy</span>
                      <Meter level={copy.accuracy.level} text={copy.accuracy.text} />
                    </span>
                  </div>
                  <p className="muted">{copy.suits}</p>
                </div>
                <div id={`${name}-${id}-desc`} className="stack g3">
                  <dl className="facts">
                    <dt>Download</dt>
                    <dd>
                      {models.totalMB > 0
                        ? downloadText(models.models)
                        : 'Chrome’s language packs only'}
                    </dd>
                    <dt>Runs</dt>
                    <dd>
                      {id !== 'light' && models.runs
                        ? `${models.runs}, ${copy.runsOn}`
                        : copy.runsOn}
                    </dd>
                  </dl>
                  <p className="t-small muted">{copy.tradeoff}</p>
                  {warning && (
                    <Notice tone="behind" icon="clock">
                      {warning}
                    </Notice>
                  )}
                </div>
              </div>
            </label>
            {value === id && foot}
          </div>
        );
      })}
      {includeCustom && (
        <div className="option" data-testid="profile-custom">
          <label>
            <input
              type="radio"
              className="native"
              name={name}
              value="custom"
              checked={value === 'custom'}
              onChange={() => onChange('custom')}
            />
            <span className="radio" aria-hidden="true" />
            <div className="grow stack g1">
              <span className="t-heading">Custom</span>
              <p className="muted">
                Choose the speech recognition and translation engines yourself.
              </p>
            </div>
          </label>
          {value === 'custom' && foot}
        </div>
      )}
    </div>
  );
}

function ModelStateBadge({ models }: { models: ProfileModels }) {
  if (models.downloading !== null) {
    return (
      <span className="badge num" data-tone="translating">
        Downloading {Math.round(models.downloading * 100)}%
      </span>
    );
  }
  if (models.ready && models.totalMB > 0) {
    return (
      <span className="badge" data-tone="success">
        <Icon name="check" size={12} stroke={2.5} /> Downloaded
      </span>
    );
  }
  return null;
}

/**
 * The chosen profile's download, inside its card: what it needs from Murmur (one button for all
 * of it, its progress, or that it's done) and Chrome's language packs for its languages. Each
 * file is also listed under Manage downloads (options page).
 */
export function ProfileDownload({
  label,
  models,
  packs,
  actions,
  compact,
  welcome,
}: {
  /** The profile's name ("Balanced"). */
  label: string;
  models: ProfileModels;
  /** Chrome packs it needs here (`packsForSettings`). */
  packs: readonly SetupAction[];
  actions: ModelActions;
  compact?: boolean;
  /** On the welcome page: the copy says where the models come from. */
  welcome?: boolean;
}) {
  if (models.totalMB === 0 && packs.length === 0) return null;
  const murmur = models.models.length > 0 && models.totalMB > 0;
  return (
    <div className="option-foot">
      {murmur && (
        <div className="row g4 wrap" data-testid="selected-models">
          {models.downloading !== null ? (
            <>
              <div className="grow stack g2">
                <p className="t-label">
                  Downloading {label} models…{' '}
                  <span className="num">{Math.round(models.downloading * 100)}%</span>
                </p>
                <ProgressBar value={models.downloading} label={`Downloading ${label} models`} />
              </div>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  for (const m of models.models) actions.cancel(m.id);
                }}
              >
                Cancel
              </button>
            </>
          ) : models.ready ? (
            <State tone="success" icon="check">
              <span className="t-label">
                {label} models are downloaded ({formatSize(models.totalMB)}).
              </span>
            </State>
          ) : (
            <>
              <p className="grow">
                <span className="t-label">
                  {label} needs {formatSize(models.missingMB)} of models.
                </span>{' '}
                <span className="muted">
                  {welcome
                    ? 'From Hugging Face, downloaded once and kept on this computer.'
                    : 'Downloaded once, then kept on this computer.'}
                </span>
              </p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => actions.download(models.models.map((m) => m.id))}
                data-testid="download-selected"
              >
                <Icon name="download" /> Download {formatSize(models.missingMB)}
              </button>
            </>
          )}
        </div>
      )}
      {packs.length > 0 && (
        <div className="stack g2" data-testid="chrome-packs">
          <div className="stack">
            <p className="t-label">Chrome language packs</p>
            <p className="t-small muted">
              {murmur
                ? `${label} uses Chrome’s own translation where its model is late. Chrome downloads and keeps a pack for each language, after a click.`
                : `${label} uses Chrome’s own ${
                    packs.some((p) => p.kind === 'speech-pack')
                      ? 'speech recognition and translation'
                      : 'translation'
                  }. Chrome downloads and keeps a pack for each language, after a click.`}
            </p>
          </div>
          <ChromePacks actions={packs} compact={compact} bare />
        </div>
      )}
    </div>
  );
}

/**
 * Model sizes for the chosen profile: the smaller speech model (Balanced), and why smaller models
 * run on this device, with a way to try the larger ones again.
 */
export function ModelSizeOptions({
  settings,
  update,
  registry,
  hardware,
  models,
}: {
  settings: Settings;
  update(change: SettingsChange): void;
  registry: EngineRegistry;
  hardware: HardwareInfo | null;
  models: ProfileModels | null;
}) {
  const profile = settings.profile;
  if (profile !== 'balanced' && profile !== 'best') return null;
  const smaller = profile === 'balanced' ? smallerSpeechCopy(registry) : null;
  const fit = models?.engines ? memoryFitCopy(models.engines, registry) : null;
  const ladder = models?.engines?.ladder;
  if (!smaller && !(fit && hardware && ladder)) return null;
  return (
    <div className="card rows" data-testid="model-size">
      {smaller && (
        <label className="list-row top">
          <span className="row" style={{ paddingTop: 'var(--inset-hair)' }}>
            <Checkbox
              checked={settings.smallerSpeech}
              onChange={(smallerSpeech) => update({ smallerSpeech })}
              testId="smaller-speech"
            />
          </span>
          <div className="grow">
            <p className="t-label">{smaller.label}</p>
            <p className="hint">{smaller.hint}</p>
          </div>
        </label>
      )}
      {fit && hardware && ladder && (
        <div className="list-row" data-testid="memory-fit">
          <p className="grow t-small">{fit.text}</p>
          {fit.retry && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                void saveMemoryFit(gpuKey(hardware), profile, {
                  ladder: ladder.id,
                  step: 0,
                  at: Date.now(),
                })
              }
              data-testid="try-larger"
            >
              {fit.action}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** "Speech recognition, small" with its state and actions, for each model. */
export function ModelList({
  view,
  actions,
  filter,
  compact,
}: {
  view: ModelsView;
  actions: ModelActions;
  /** Show only these ids (in this order). */
  filter?: readonly string[];
  compact?: boolean;
}) {
  const entries = filter
    ? filter
        .map((id) => view.models.find((m) => m.info.id === id))
        .filter((m): m is ModelEntry => !!m)
    : view.models;
  return (
    <ul className="rows" aria-label="Models">
      {entries.map((m) => (
        <ModelRow key={m.info.id} entry={m} actions={actions} compact={compact ?? false} />
      ))}
    </ul>
  );
}

function ModelRow({
  entry,
  actions,
  compact,
}: {
  entry: ModelEntry;
  actions: ModelActions;
  compact: boolean;
}) {
  const { info, status, profiles } = entry;
  let state: ReactNode;
  let action: ReactNode;
  switch (status.state) {
    case 'ready':
      state = (
        <State tone="success" icon="check">
          Downloaded
        </State>
      );
      action = (
        <button
          type="button"
          className="btn btn-sm btn-quiet"
          onClick={() => actions.remove(info.id)}
          aria-label={`Delete ${info.label}`}
        >
          <Icon name="trash" /> Delete
        </button>
      );
      break;
    case 'downloading':
    case 'queued': {
      // Waiting its turn: an empty bar, not a moving one.
      const checking = status.state === 'downloading' ? status.checking : undefined;
      const fraction =
        status.state === 'downloading' ? (checking ?? status.receivedMB / info.sizeMB) : 0;
      state = (
        <div>
          <span className="t-small muted num">
            {status.state === 'queued'
              ? 'Waiting…'
              : checking !== undefined
                ? `Checking the download, ${Math.round(checking * 100)}%`
                : `${formatSize(status.receivedMB)} of ${formatSize(info.sizeMB)}`}
          </span>
          <ProgressBar
            value={fraction}
            tone={checking !== undefined ? 'success' : 'translating'}
            label={checking !== undefined ? `Checking ${info.label}` : `Downloading ${info.label}`}
          />
        </div>
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
        <span className="t-small muted num">
          Stopped at {formatSize(status.receivedMB)} of {formatSize(info.sizeMB)}
        </span>
      );
      action = (
        <>
          <button
            type="button"
            className="btn btn-sm btn-quiet"
            onClick={() => actions.remove(info.id)}
            aria-label={`Delete the part of ${info.label} downloaded so far`}
          >
            <Icon name="trash" /> Delete
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => actions.download([info.id])}
            aria-label={`Resume downloading ${info.label}`}
          >
            <Icon name="download" /> Resume
          </button>
        </>
      );
      break;
    case 'error':
      state = (
        <span className="state top" data-tone="error">
          {status.message}
        </span>
      );
      action = (
        <button type="button" className="btn btn-sm" onClick={() => actions.download([info.id])}>
          <Icon name="reload" /> Try again
        </button>
      );
      break;
    case 'absent':
      state = <span className="t-small muted">Not downloaded</span>;
      action = (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => actions.download([info.id])}
          aria-label={`Download ${info.label}, ${formatSize(info.sizeMB)}`}
        >
          <Icon name="download" /> Download
        </button>
      );
      break;
  }
  return (
    <li className={compact ? 'model-row compact' : 'model-row'} data-testid={`model-${info.id}`}>
      <span className="tile">
        <Icon name={info.role === 'speech' ? 'wave' : 'globe'} />
      </span>
      <div>
        <p className="t-label">{info.label}</p>
        <p className="t-caption muted num">
          {formatSize(info.sizeMB)}
          {profiles.length > 0 ? ` · ${profiles.map((p) => PROFILES[p].label).join(', ')}` : ''}
        </p>
      </div>
      <div>{state}</div>
      <div className="actions">{action}</div>
    </li>
  );
}

/** What this browser can't do that the models need (ui/browser.ts), as notes; none: nothing. */
export function BrowserGaps() {
  const gaps = browserGaps();
  if (gaps.length === 0) return null;
  return (
    <div className="stack g2" data-testid="browser-gaps">
      {gaps.map((g) => (
        <Notice key={g.api} tone="behind">
          {g.text}
        </Notice>
      ))}
    </div>
  );
}

/** This device: what it offers, in plain words, and the model size that suits it. */
export function DeviceCard({ hardware }: { hardware: HardwareInfo | null }) {
  const suggested = hardware ? recommendProfile(hardware) : null;
  const rows: [string, string][] = hardware
    ? [
        [
          'Graphics',
          hardware.webgpu.available
            ? hardware.webgpu.shaderF16
              ? 'WebGPU, with 16-bit floats'
              : 'WebGPU'
            : 'No WebGPU',
        ],
        ['Memory', memoryText(hardware.deviceMemoryGB)],
        ['Processor', `${hardware.cores} threads`],
      ]
    : [];
  return (
    <aside className="card device" aria-label="This device" data-testid="hardware">
      <div className="row g3">
        <span className="tile tile-lg" data-tone="listening">
          <Icon name="chip" size={20} />
        </span>
        <div className="stack">
          <h3 className="t-heading">This device</h3>
          <p className="t-small muted">
            {suggested ? (
              <>
                Suggested: <strong className="ink">{PROFILES[suggested].label}</strong>. Based on
                the graphics and memory the browser reports.
              </>
            ) : (
              'Checking this device…'
            )}
          </p>
        </div>
      </div>
      {rows.map(([k, v]) => (
        <div key={k} className="stat">
          <span className="t-caption muted">{k}</span>
          <span className="t-label">{v}</span>
        </div>
      ))}
    </aside>
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
  bare,
}: {
  actions: readonly SetupAction[];
  compact?: boolean | undefined;
  /** Rows without side padding (inside a card that has its own). */
  bare?: boolean;
}) {
  const [states, run] = usePacks(actions);
  return (
    <ul className={bare ? 'rows bare' : 'rows'} aria-label="Chrome language packs">
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
