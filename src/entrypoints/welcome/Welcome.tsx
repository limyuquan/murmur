/**
 * First run, opened on install: what Murmur does → languages → model size and its download →
 * done. Every choice is saved as it's made, so leaving part way keeps what was chosen; the
 * download carries on in the background if the page is closed.
 */
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { createBuiltinRegistry } from '@/engines/builtin';
import { PROFILES, type ProfileId, recommendProfile } from '@/engines/profiles';
import { freeSpaceText } from '@/models/types';
import type { Settings } from '@/settings/settings';
import { COMMANDS } from '@/shared/commands';
import { Icon, type IconName, Keys, Logo, Notice, Select, type Tone } from '@/ui/components';
import { useHardware, useMemoryFit, useModels, useSettings, useShortcut } from '@/ui/hooks';
import { languageOptions } from '@/ui/languages';
import {
  BrowserGaps,
  ModelSizeOptions,
  ProfileCards,
  ProfileDownload,
  type ProfileModels,
  packsForSettings,
  profileModels,
} from '@/ui/models';
import { Scene } from '@/ui/scenes';
import { SpokenLanguages } from '@/ui/spoken';

const STEPS = [
  { id: 'intro', label: 'Welcome' },
  { id: 'language', label: 'Languages' },
  { id: 'model', label: 'Model size and download' },
  { id: 'done', label: 'Done' },
] as const;
type Step = (typeof STEPS)[number]['id'];

const EMPTY: ProfileModels = {
  models: [],
  totalMB: 0,
  missingMB: 0,
  ready: false,
  downloading: null,
};

export function Welcome({ initial }: { initial: Settings }) {
  const [settings, update] = useSettings(initial);
  const [step, setStep] = useState<Step>('intro');
  const hardware = useHardware();
  const registry = useMemo(createBuiltinRegistry, []);
  const [view, actions] = useModels();
  const fit = useMemoryFit();
  const heading = useRef<HTMLHeadingElement>(null);
  const suggested: ProfileId | null = hardware ? recommendProfile(hardware) : null;
  const picked = useRef(false);

  // Preselect the suggestion once the device is known (until the person picks one).
  useEffect(() => {
    if (suggested && !picked.current && settings.profile !== suggested) {
      update({ profile: suggested });
    }
  }, [suggested, settings.profile, update]);

  // Move focus to the new step's heading, so keyboard and screen-reader users follow along.
  const firstStep = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on step change only.
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);

  const index = STEPS.findIndex((s) => s.id === step);
  const go = (to: Step) => setStep(to);
  const modelsOf = (p: ProfileId | 'custom') =>
    hardware ? profileModels(p, settings, registry, hardware, view, fit) : EMPTY;
  const selected = modelsOf(settings.profile);
  const packs = hardware ? packsForSettings(settings, registry, hardware) : [];
  const profileLabel = settings.profile === 'custom' ? 'Custom' : PROFILES[settings.profile].label;
  /** Something to download from Murmur that isn't on disk yet. */
  const needsDownload = selected.totalMB > 0 && !selected.ready;
  const next = (label: string, to: Step) => (
    <button type="button" className="btn btn-primary btn-lg" onClick={() => go(to)}>
      {label} <Icon name="arrow" />
    </button>
  );

  let body: ReactNode;
  let title: string;
  let end: ReactNode = null;
  switch (step) {
    case 'intro':
      title = 'Live subtitles for any video';
      body = <Intro />;
      end = next('Get started', 'language');
      break;
    case 'language':
      title = 'Your languages';
      body = (
        <LanguageStep
          settings={settings}
          update={update}
          chromeSpeech={packs.some((p) => p.kind === 'speech-pack')}
        />
      );
      end = next('Continue', 'model');
      break;
    case 'model': {
      title = 'Choose a model size';
      const free = view ? freeSpaceText(view.storage.availableMB) : null;
      body = (
        <>
          <p className="muted measure">
            Larger models make fewer mistakes, but need a faster device and a bigger download. You
            can change this later in Settings.
          </p>
          <BrowserGaps />
          <ProfileCards
            value={settings.profile}
            onChange={(profile) => {
              picked.current = true;
              update({ profile });
            }}
            hardware={hardware}
            modelsOf={modelsOf}
            includeCustom={false}
            name="welcome-profile"
            foot={
              <ProfileDownload
                label={profileLabel}
                models={selected}
                packs={packs}
                actions={actions}
                compact
                welcome
              />
            }
          />
          <ModelSizeOptions
            settings={settings}
            update={update}
            registry={registry}
            hardware={hardware}
            models={selected}
          />
          {needsDownload && (
            <p className="t-small muted measure" data-testid="welcome-download-note">
              You can close this page while the models download: the download carries on.
              {free !== null && ` There’s ${free}.`}
            </p>
          )}
        </>
      );
      end =
        needsDownload && selected.downloading !== null ? (
          <button type="button" className="btn btn-lg" onClick={() => go('done')}>
            Continue in the background
          </button>
        ) : needsDownload ? (
          <button type="button" className="btn btn-lg" onClick={() => go('done')}>
            Later
          </button>
        ) : (
          next('Continue', 'done')
        );
      break;
    }
    case 'done':
      title = 'You’re set';
      body = <Done ready={!needsDownload} />;
      end = (
        <button type="button" className="btn btn-primary btn-lg" onClick={() => window.close()}>
          Done
        </button>
      );
      break;
  }

  return (
    <div className="welcome">
      <header className="welcome-head">
        <Logo size={32} />
        <span className="t-heading">Murmur</span>
        <ol className="steps" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s.id} aria-current={s.id === step ? 'step' : undefined}>
              <span className="sr-only">
                {s.label}
                {i < index ? ' (done)' : ''}
              </span>
              <i aria-hidden="true" data-done={i < index} data-now={s.id === step} />
            </li>
          ))}
        </ol>
      </header>

      <main className="card sheet" data-testid={`step-${step}`}>
        <div className="sheet-body">
          <div className="stack g1">
            <p className="t-label muted">
              Step {index + 1} of {STEPS.length}
            </p>
            <h1 ref={heading} tabIndex={-1} className="step-title t-display">
              {title}
            </h1>
          </div>
          {body}
        </div>
        <footer className="sheet-foot">
          {index > 0 && step !== 'done' && (
            <button
              type="button"
              className="btn btn-lg btn-quiet"
              onClick={() => go(STEPS[index - 1]?.id ?? 'intro')}
            >
              <Icon name="back" /> Back
            </button>
          )}
          <span className="end">{end}</span>
        </footer>
      </main>
    </div>
  );
}

function Intro() {
  const points: { icon: IconName; tone: Tone; title: string; text: string }[] = [
    {
      icon: 'wave',
      tone: 'listening',
      title: 'Hears the tab',
      text: 'Works with any video player on any site, because it listens to the tab’s sound.',
    },
    {
      icon: 'globe',
      tone: 'translating',
      title: 'Translates each line',
      text: 'Shows each line in your language, even when the spoken language changes part way.',
    },
    {
      icon: 'lock',
      tone: 'success',
      title: 'Stays on this computer',
      text: 'Speech recognition and translation run here. Nothing you watch is uploaded.',
    },
  ];
  return (
    <>
      <SampleFrame />
      <ul className="points">
        {points.map((p) => (
          <li key={p.title} className="stack g3">
            <span className="tile tile-lg" data-tone={p.tone}>
              <Icon name={p.icon} size={20} />
            </span>
            <div className="stack g1">
              <p className="t-heading">{p.title}</p>
              <p className="t-small muted">{p.text}</p>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** A still of a video with a subtitle, drawn as the overlay draws one. */
function SampleFrame() {
  return (
    <div className="frame sample" role="img" aria-label="A video with a translated subtitle">
      <Scene kind="dark" />
      <p className="sample-line">
        <span>Shall we meet outside the station at eight?</span>
      </p>
    </div>
  );
}

function LanguageStep({
  settings,
  update,
  chromeSpeech,
}: {
  settings: Settings;
  update: ReturnType<typeof useSettings>[1];
  chromeSpeech: boolean;
}) {
  const languages = useMemo(languageOptions, []);
  return (
    <>
      <div className="stack g1">
        <label htmlFor="welcome-target" className="t-label">
          Translate into
        </label>
        <Select
          id="welcome-target"
          large
          block
          value={settings.targetLanguage}
          onChange={(e) => update({ targetLanguage: e.target.value })}
        >
          {languages.map((l) => (
            <option key={l.tag} value={l.tag}>
              {l.name}
            </option>
          ))}
        </Select>
        <p className="t-small muted">Lines already in this language are shown as they are.</p>
      </div>
      <div className="card flat rows">
        <SpokenLanguages settings={settings} update={update} chromeSpeech={chromeSpeech} />
      </div>
    </>
  );
}

function Done({ ready }: { ready: boolean }) {
  const shortcut = useShortcut(COMMANDS.toggle);
  const steps: ReactNode[] = [
    <>
      <b className="t-label">Pin Murmur</b> so it’s one click away: click the puzzle piece in the
      toolbar, then the pin next to Murmur.
    </>,
    <>
      On a tab with a video, click Murmur and turn on{' '}
      <b className="t-label">Subtitles on this tab</b>.
      {shortcut ? (
        <>
          {' '}
          Or press <Keys shortcut={shortcut} />.
        </>
      ) : null}
    </>,
    <>Drag subtitles to move them. Double-click to put them back.</>,
  ];
  return (
    <>
      {!ready && (
        <Notice tone="behind" testId="done-not-ready">
          The models aren’t downloaded yet. You can download them any time from Settings.
        </Notice>
      )}
      <ol className="list numbers">
        {steps.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed list.
          <li key={i}>
            <span className="numbered">{i + 1}</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
      <p className="t-small muted">
        Settings has languages, model sizes and how subtitles look.{' '}
        <button
          type="button"
          className="link"
          onClick={() => void browser.runtime.openOptionsPage()}
        >
          Open Settings
        </button>
      </p>
    </>
  );
}
