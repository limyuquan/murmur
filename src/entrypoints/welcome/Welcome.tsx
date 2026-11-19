/**
 * First run, opened on install: what Earshot does → language → model size → download → done.
 * Every choice is saved as it's made, so leaving part way keeps what was chosen; the download
 * carries on in the background if the page is closed.
 */
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { createBuiltinRegistry } from '@/engines/builtin';
import { PROFILES, type ProfileId, recommendProfile } from '@/engines/profiles';
import { formatSize } from '@/models/types';
import type { Settings } from '@/settings/settings';
import { Icon, type IconName, Logo, ProgressBar } from '@/ui/components';
import { useHardware, useModels, useSettings } from '@/ui/hooks';
import { languageOptions } from '@/ui/languages';
import { ModelList, ProfileCards, type ProfileModels, profileModels } from '@/ui/models';

const STEPS = [
  { id: 'intro', label: 'Welcome' },
  { id: 'language', label: 'Language' },
  { id: 'model', label: 'Model' },
  { id: 'download', label: 'Download' },
  { id: 'done', label: 'Done' },
] as const;
type Step = (typeof STEPS)[number]['id'];

const EMPTY: ProfileModels = {
  models: [],
  totalMB: 0,
  missingMB: 0,
  ready: false,
  downloading: null,
  simulated: false,
};

export function Welcome({ initial }: { initial: Settings }) {
  const [settings, update] = useSettings(initial);
  const [step, setStep] = useState<Step>('intro');
  const hardware = useHardware();
  const registry = useMemo(createBuiltinRegistry, []);
  const [view, actions] = useModels();
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
    hardware ? profileModels(p, settings, registry, hardware, view) : EMPTY;
  const selected = modelsOf(settings.profile);
  const profileLabel = settings.profile === 'custom' ? 'Custom' : PROFILES[settings.profile].label;

  let body: ReactNode;
  let title: string;
  let next: ReactNode = null;
  switch (step) {
    case 'intro':
      title = 'Live subtitles for any video';
      body = <Intro />;
      next = (
        <button type="button" className="btn btn-primary btn-lg" onClick={() => go('language')}>
          Get started <Icon name="arrow" />
        </button>
      );
      break;
    case 'language':
      title = 'What language do you want subtitles in?';
      body = <LanguageStep settings={settings} update={update} />;
      next = (
        <button type="button" className="btn btn-primary btn-lg" onClick={() => go('model')}>
          Continue <Icon name="arrow" />
        </button>
      );
      break;
    case 'model':
      title = 'Choose a model size';
      body = (
        <div className="grid gap-4">
          <p className="text-[var(--color-muted)]">
            Larger models make fewer mistakes, but need a faster device and a bigger download. You
            can change this later in Settings.
          </p>
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
          />
        </div>
      );
      next = (
        <button type="button" className="btn btn-primary btn-lg" onClick={() => go('download')}>
          Continue <Icon name="arrow" />
        </button>
      );
      break;
    case 'download': {
      title = selected.ready ? 'Models are ready' : `Download the ${profileLabel} models`;
      const ids = selected.models.map((m) => m.id);
      body = (
        <div className="grid gap-4">
          {selected.simulated && (
            <p className="notice text-[13px]">
              Preview: real models aren’t included in this version yet, so this download is
              simulated and nothing is fetched. Subtitles use the demo engines for now.
            </p>
          )}
          <p className="text-[var(--color-muted)]">
            {formatSize(selected.totalMB)} in all, downloaded once and kept on this computer. You
            can close this page: the download carries on.
            {view?.storage.availableMB != null &&
              ` ${formatSize(view.storage.availableMB)} is free for Earshot.`}
          </p>
          {selected.downloading !== null && (
            <div>
              <p className="mb-2 font-medium">{Math.round(selected.downloading * 100)}%</p>
              <ProgressBar value={selected.downloading} label="Downloading models" />
            </div>
          )}
          {view && (
            <div className="card px-4 py-1">
              <ModelList view={view} actions={actions} filter={ids} />
            </div>
          )}
        </div>
      );
      next = selected.ready ? (
        <button type="button" className="btn btn-primary btn-lg" onClick={() => go('done')}>
          Continue <Icon name="arrow" />
        </button>
      ) : (
        <>
          <button type="button" className="btn btn-lg btn-quiet" onClick={() => go('done')}>
            {selected.downloading !== null ? 'Continue in the background' : 'Later'}
          </button>
          {selected.downloading === null && (
            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={() => actions.download(ids)}
              data-testid="welcome-download"
            >
              <Icon name="download" /> Download {formatSize(selected.missingMB)}
            </button>
          )}
        </>
      );
      break;
    }
    case 'done':
      title = 'You’re set';
      body = <Done ready={selected.ready} />;
      next = (
        <button type="button" className="btn btn-primary btn-lg" onClick={() => window.close()}>
          Done
        </button>
      );
      break;
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-[720px] flex-col px-6 py-8 text-[14px] leading-[1.55]">
      <header className="flex items-center gap-2.5">
        <Logo size={28} />
        <span className="text-[16px] font-semibold tracking-[-0.01em]">Earshot</span>
        <ol className="ml-auto flex items-center gap-1.5" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s.id} aria-current={s.id === step ? 'step' : undefined}>
              <span className="sr-only">
                {s.label}
                {i < index ? ' (done)' : ''}
              </span>
              <span
                aria-hidden="true"
                className={`block h-1.5 rounded-full transition-all ${
                  s.id === step
                    ? 'w-6 bg-[var(--color-accent)]'
                    : i < index
                      ? 'w-1.5 bg-[var(--color-accent)]'
                      : 'w-1.5 bg-[var(--color-line-strong)]'
                }`}
              />
            </li>
          ))}
        </ol>
      </header>

      <main className="mt-12 flex flex-1 flex-col" data-testid={`step-${step}`}>
        <p className="text-[13px] font-medium text-[var(--color-muted)]">
          Step {index + 1} of {STEPS.length}
        </p>
        <h1
          ref={heading}
          tabIndex={-1}
          className="step-title mt-1 text-[28px] font-semibold tracking-[-0.02em]"
        >
          {title}
        </h1>
        <div className="mt-5">{body}</div>
      </main>

      <footer className="mt-10 flex items-center gap-3 border-t border-[var(--color-line)] pt-5">
        {index > 0 && step !== 'done' && (
          <button
            type="button"
            className="btn btn-lg btn-quiet"
            onClick={() => go(STEPS[index - 1]?.id ?? 'intro')}
          >
            <Icon name="back" /> Back
          </button>
        )}
        <span className="ml-auto flex items-center gap-3">{next}</span>
      </footer>
    </div>
  );
}

function Intro() {
  const points: { icon: IconName; title: string; text: string }[] = [
    {
      icon: 'speech',
      title: 'Hears the tab',
      text: 'Works with any video player on any site, because it listens to the tab’s sound.',
    },
    {
      icon: 'globe',
      title: 'Translates each line',
      text: 'Shows what was said and its translation, even when the language changes part way.',
    },
    {
      icon: 'lock',
      title: 'Stays on this computer',
      text: 'Speech recognition and translation run here. Nothing you watch is uploaded.',
    },
  ];
  return (
    <div className="grid gap-6">
      <SampleFrame />
      <ul className="grid gap-4 sm:grid-cols-3">
        {points.map((p) => (
          <li key={p.title}>
            <span className="grid size-9 place-items-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
              <Icon name={p.icon} size={18} />
            </span>
            <p className="mt-2.5 font-semibold">{p.title}</p>
            <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">{p.text}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A still of a video with subtitles, drawn with plain elements. */
function SampleFrame() {
  return (
    <div
      className="relative aspect-[21/9] overflow-hidden rounded-[14px]"
      style={{
        background: 'radial-gradient(120% 90% at 75% 15%, #42557a 0%, #1c2438 50%, #0d1019 100%)',
      }}
      role="img"
      aria-label="A video with a subtitle in the original language above its translation"
    >
      <div className="absolute inset-x-0 bottom-[9%] flex flex-col items-center gap-1.5 px-6 text-center">
        <span className="rounded bg-black/70 px-2 py-0.5 text-[13px] text-[#dcdcdc]">
          On se retrouve devant la gare à huit heures ?
        </span>
        <span className="rounded bg-black/70 px-2.5 py-0.5 text-[19px] font-medium text-white">
          Shall we meet outside the station at eight?
        </span>
      </div>
    </div>
  );
}

function LanguageStep({
  settings,
  update,
}: {
  settings: Settings;
  update: ReturnType<typeof useSettings>[1];
}) {
  const languages = useMemo(languageOptions, []);
  return (
    <div className="grid max-w-[420px] gap-3">
      <label htmlFor="welcome-target" className="font-medium">
        Translate into
      </label>
      <select
        id="welcome-target"
        className="input h-10 text-[15px]"
        value={settings.targetLanguage}
        onChange={(e) => update({ targetLanguage: e.target.value })}
      >
        {languages.map((l) => (
          <option key={l.tag} value={l.tag}>
            {l.name}
          </option>
        ))}
      </select>
      <p className="text-[13px] text-[var(--color-muted)]">
        The spoken language is detected for each line, so videos that mix languages work too. Lines
        already in this language are shown as they are.
      </p>
    </div>
  );
}

function Done({ ready }: { ready: boolean }) {
  const steps: ReactNode[] = [
    <>
      <strong>Pin Earshot</strong> so it’s one click away: click the puzzle piece in the toolbar,
      then the pin next to Earshot.
    </>,
    <>
      On a tab with a video, click Earshot and turn on <strong>Subtitles on this tab</strong>. Or
      press <kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>S</kbd>.
    </>,
    <>Drag subtitles to move them. Double-click to put them back.</>,
  ];
  return (
    <div className="grid gap-5">
      {!ready && (
        <p className="notice" data-tone="warn">
          The models aren’t downloaded yet. You can download them any time from Settings.
        </p>
      )}
      <ol className="grid gap-3">
        {steps.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed list.
          <li key={i} className="flex gap-3">
            <span className="grid size-6 flex-none place-items-center rounded-full bg-[var(--color-sunken)] text-[12px] font-semibold">
              {i + 1}
            </span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
      <p className="text-[13px] text-[var(--color-muted)]">
        Settings has languages, model sizes and how subtitles look.{' '}
        <button
          type="button"
          className="link"
          onClick={() => void browser.runtime.openOptionsPage()}
        >
          Open Settings
        </button>
      </p>
    </div>
  );
}
