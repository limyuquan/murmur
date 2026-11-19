import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { createBuiltinRegistry } from '@/engines/builtin';
import { CHROME_WEBSPEECH_ID } from '@/engines/chrome/info';
import { PROFILES, type ProfileId, recommendProfile, resolveEngines } from '@/engines/profiles';
import { formatSize } from '@/models/types';
import { SubtitlePreview } from '@/overlay/preview';
import { clearPositions, loadPositions, watchPositions } from '@/settings/positions';
import type { CaptionBackground, CaptionDisplay, Settings } from '@/settings/settings';
import { REPO_URL } from '@/shared/ids';
import { Icon, Logo, ProgressBar, Segmented, Switch } from '@/ui/components';
import { GlossaryEditor } from '@/ui/glossary';
import { useHardware, useModels, useReducedMotion, useSettings } from '@/ui/hooks';
import { languageOptions } from '@/ui/languages';
import {
  ChromePacks,
  engineFits,
  HardwareSummary,
  ModelList,
  ProfileCards,
  type ProfileModels,
  packsForSettings,
  profileModels,
} from '@/ui/models';
import { SpokenLanguages } from '@/ui/spoken';

const SECTIONS = [
  { id: 'models', label: 'Models' },
  { id: 'languages', label: 'Languages' },
  { id: 'glossary', label: 'Glossary' },
  { id: 'subtitles', label: 'Subtitles' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'privacy', label: 'Privacy' },
] as const;

export function Options({ initial }: { initial: Settings }) {
  const [settings, update] = useSettings(initial);

  // The page renders after load, so the browser's own jump to #section missed it.
  useEffect(() => {
    const id = location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView();
  }, []);

  return (
    <div className="mx-auto flex max-w-[1040px] gap-10 px-6 py-8 text-[14px] leading-[1.5]">
      <nav aria-label="Sections" className="sticky top-8 hidden h-fit w-[168px] flex-none md:block">
        <div className="mb-6 flex items-center gap-2.5">
          <Logo size={26} />
          <span className="text-[16px] font-semibold tracking-[-0.01em]">Murmur</span>
        </div>
        <ul className="grid gap-0.5">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                className="block rounded-lg px-2.5 py-1.5 text-[var(--color-muted)] hover:bg-[var(--color-hover)] hover:text-[var(--color-ink)]"
              >
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <main className="flex min-w-0 flex-1 flex-col gap-12">
        <header>
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Settings</h1>
          <p className="text-[var(--color-muted)]">Changes are saved as you make them.</p>
        </header>
        <ModelsSection settings={settings} update={update} />
        <LanguagesSection settings={settings} update={update} />
        <GlossarySection settings={settings} update={update} />
        <SubtitlesSection settings={settings} update={update} />
        <ShortcutsSection />
        <PrivacySection />
      </main>
    </div>
  );
}

type Update = ReturnType<typeof useSettings>[1];

function Section({
  id,
  title,
  intro,
  children,
}: {
  id: string;
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-8">
      <h2 id={`${id}-title`} className="text-[18px] font-semibold tracking-[-0.01em]">
        {title}
      </h2>
      {intro && <p className="mt-1 max-w-[62ch] text-[var(--color-muted)]">{intro}</p>}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

function Row({
  label,
  hint,
  htmlFor,
  id,
  children,
}: {
  label: string;
  hint?: string | undefined;
  htmlFor?: string;
  id?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3">
      <div className="min-w-[180px] flex-1">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="font-medium">
            {label}
          </label>
        ) : (
          <span id={id} className="font-medium">
            {label}
          </span>
        )}
        {hint && <p className="text-[13px] text-[var(--color-muted)]">{hint}</p>}
      </div>
      <div className="flex items-center gap-3">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function ModelsSection({ settings, update }: { settings: Settings; update: Update }) {
  const registry = useMemo(createBuiltinRegistry, []);
  const hardware = useHardware();
  const [view, actions, error] = useModels();
  const modelsOf = (p: ProfileId | 'custom'): ProfileModels | null =>
    hardware ? profileModels(p, settings, registry, hardware, view) : null;
  const selected = modelsOf(settings.profile);
  const suggested = hardware ? recommendProfile(hardware) : null;
  const packs = useMemo(
    () => (hardware ? packsForSettings(settings, registry, hardware) : []),
    [settings, registry, hardware],
  );
  const selectedLabel = settings.profile === 'custom' ? 'Custom' : PROFILES[settings.profile].label;

  return (
    <Section
      id="models"
      title="Models"
      intro="Murmur turns speech into text and translates it on this computer. Larger models make fewer mistakes, but need a faster device and a bigger one-time download."
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
        <ProfileCards
          value={settings.profile}
          onChange={(profile) => update({ profile })}
          hardware={hardware}
          modelsOf={(p) =>
            modelsOf(p) ?? {
              models: [],
              totalMB: 0,
              missingMB: 0,
              ready: false,
              downloading: null,
            }
          }
        />
        <aside className="card h-fit p-4" aria-label="This device">
          <h3 className="flex items-center gap-2 font-semibold">
            <Icon name="chip" /> This device
          </h3>
          <div className="mt-3">
            <HardwareSummary hardware={hardware} />
          </div>
          {suggested && (
            <p className="mt-3 text-[13px] text-[var(--color-muted)]">
              Suggested:{' '}
              <strong className="text-[var(--color-ink)]">{PROFILES[suggested].label}</strong>.
              Based on the graphics and memory the browser reports.
            </p>
          )}
        </aside>
      </div>

      {settings.profile === 'custom' && (
        <CustomEngines
          settings={settings}
          update={update}
          hardware={hardware}
          registry={registry}
        />
      )}

      {selected && selected.totalMB > 0 && (
        <div
          className="card flex flex-wrap items-center gap-x-4 gap-y-3 p-4"
          data-testid="selected-models"
        >
          {selected.downloading !== null ? (
            <>
              <div className="min-w-[220px] flex-1">
                <p className="font-medium">
                  Downloading {selectedLabel} models… {Math.round(selected.downloading * 100)}%
                </p>
                <div className="mt-2">
                  <ProgressBar
                    value={selected.downloading}
                    label={`Downloading ${selectedLabel} models`}
                  />
                </div>
              </div>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  for (const m of selected.models) actions.cancel(m.id);
                }}
              >
                Cancel
              </button>
            </>
          ) : selected.ready ? (
            <p className="flex items-center gap-2 font-medium">
              <span className="text-[var(--color-accent)]">
                <Icon name="check" />
              </span>
              {selectedLabel} models are downloaded ({formatSize(selected.totalMB)}).
            </p>
          ) : (
            <>
              <p className="min-w-[220px] flex-1">
                <span className="font-medium">
                  {selectedLabel} needs {formatSize(selected.missingMB)} of models.
                </span>{' '}
                <span className="text-[var(--color-muted)]">
                  Downloaded once, then kept on this computer.
                </span>
              </p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => actions.download(selected.models.map((m) => m.id))}
                data-testid="download-selected"
              >
                <Icon name="download" /> Download {formatSize(selected.missingMB)}
              </button>
            </>
          )}
        </div>
      )}

      {packs.length > 0 && (
        <div className="card p-4" data-testid="chrome-packs">
          <h3 className="font-semibold">Chrome language packs</h3>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">
            {selectedLabel} uses Chrome’s own{' '}
            {packs.some((p) => p.kind === 'speech-pack')
              ? 'speech recognition and translation'
              : 'translation'}
            . Chrome downloads and keeps a pack for each language, after a click.
          </p>
          <div className="mt-1">
            <ChromePacks actions={packs} />
          </div>
        </div>
      )}

      <div className="card p-4" id="downloads">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-semibold">Models from Murmur</h3>
          {view && (
            <p className="text-[13px] text-[var(--color-muted)]" data-testid="disk-usage">
              {formatSize(view.storage.modelsMB)} used
              {view.storage.availableMB !== null &&
                ` · ${formatSize(view.storage.availableMB)} free for Murmur`}
            </p>
          )}
        </div>
        {error && (
          <p className="notice mt-3" data-tone="error">
            {error}
          </p>
        )}
        {view ? (
          view.models.length > 0 ? (
            <div className="mt-1">
              <ModelList view={view} actions={actions} />
            </div>
          ) : (
            <p className="mt-3 text-[var(--color-muted)]">
              None of the model sizes needs a download from Murmur on this device.
            </p>
          )
        ) : (
          <p className="mt-3 text-[var(--color-muted)]">Loading…</p>
        )}
        {view && view.storage.modelsMB > 0 && (
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              className="btn btn-sm btn-quiet"
              onClick={() => {
                for (const m of view.models)
                  if (m.status.state === 'ready' || m.status.state === 'partial')
                    actions.remove(m.info.id);
              }}
            >
              <Icon name="trash" size={14} /> Delete all
            </button>
          </div>
        )}
      </div>
    </Section>
  );
}

function CustomEngines({
  settings,
  update,
  hardware,
  registry,
}: {
  settings: Settings;
  update: Update;
  hardware: ReturnType<typeof useHardware>;
  registry: ReturnType<typeof createBuiltinRegistry>;
}) {
  return (
    <div className="card divide-y divide-[var(--color-line)] px-4">
      <Row label="Speech recognition" htmlFor="custom-asr">
        <select
          id="custom-asr"
          className="input"
          value={settings.custom.asr}
          onChange={(e) => update({ custom: { asr: e.target.value } })}
        >
          {registry.asrEngines().map((e) => (
            <option key={e.id} value={e.id} disabled={!engineFits(e, hardware)}>
              {e.unavailable ? `${e.label} (${e.unavailable})` : e.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Translation" htmlFor="custom-mt">
        <select
          id="custom-mt"
          className="input"
          value={settings.custom.translation}
          onChange={(e) => update({ custom: { translation: e.target.value } })}
        >
          {registry.translationEngines().map((e) => (
            <option key={e.id} value={e.id} disabled={!engineFits(e, hardware)}>
              {e.unavailable ? `${e.label} (${e.unavailable})` : e.label}
            </option>
          ))}
        </select>
      </Row>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function LanguagesSection({ settings, update }: { settings: Settings; update: Update }) {
  const languages = useMemo(languageOptions, []);
  const registry = useMemo(createBuiltinRegistry, []);
  const hardware = useHardware();
  const chromeSpeech =
    hardware !== null &&
    resolveEngines(settings.profile, settings.custom, registry, hardware).asr ===
      CHROME_WEBSPEECH_ID;
  return (
    <Section
      id="languages"
      title="Languages"
      intro="Each line is translated on its own, so a video that switches language part way through is fine."
    >
      <div className="card divide-y divide-[var(--color-line)] px-4">
        <Row label="Translate into" htmlFor="target">
          <select
            id="target"
            className="input"
            value={settings.targetLanguage}
            onChange={(e) => update({ targetLanguage: e.target.value })}
          >
            {languages.map((l) => (
              <option key={l.tag} value={l.tag}>
                {l.name}
              </option>
            ))}
          </select>
        </Row>
        <SpokenLanguages settings={settings} update={update} chromeSpeech={chromeSpeech} />
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------

function GlossarySection({ settings, update }: { settings: Settings; update: Update }) {
  return (
    <Section
      id="glossary"
      title="Glossary"
      intro="Names and terms, and how to write them. When a line mentions one, or something close to it (speech recognition often mishears names), the translation uses your spelling. Only the Gemma translation models (Balanced and Best) use it."
    >
      <GlossaryEditor settings={settings} update={update} />
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------

type Scene = 'dark' | 'bright';

const SCENES: Record<Scene, string> = {
  dark: 'radial-gradient(120% 80% at 70% 20%, #3a4a6b 0%, #1b2236 45%, #0c0f18 100%)',
  bright:
    'linear-gradient(180deg, #bfe1ff 0%, #e9f4ff 46%, #f6efe0 62%, #efe1c4 80%, #f8f1e2 100%)',
};

function SubtitlesSection({ settings, update }: { settings: Settings; update: Update }) {
  const o = settings.overlay;
  const [scene, setScene] = useState<Scene>('dark');
  const [playing, setPlaying] = useState(false);
  const [sitesMoved, setSitesMoved] = useState(0);
  const reduced = useReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  const preview = useRef<SubtitlePreview | null>(null);

  useEffect(() => {
    if (!box.current) return;
    const p = new SubtitlePreview(box.current);
    preview.current = p;
    return () => {
      p.destroy();
      preview.current = null;
    };
  }, []);
  useEffect(() => preview.current?.setSettings(o), [o]);
  useEffect(() => {
    if (playing && !reduced) preview.current?.play();
    else preview.current?.stop();
  }, [playing, reduced]);

  useEffect(() => {
    loadPositions().then(
      (p) => setSitesMoved(Object.keys(p).length),
      () => {},
    );
    return watchPositions((p) => setSitesMoved(Object.keys(p).length));
  }, []);

  const strengthLabel = o.background === 'box' ? 'Box opacity' : 'Shadow strength';

  return (
    <Section id="subtitles" title="Subtitles" intro="How subtitles look on videos.">
      <div className="card overflow-hidden">
        <div
          ref={box}
          className="relative aspect-video w-full"
          style={{ background: SCENES[scene] }}
          role="img"
          aria-label="Preview of subtitles on a video"
          data-testid="preview"
        />
        <div className="divider flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
          <Segmented<Scene>
            label="Preview background"
            value={scene}
            onChange={setScene}
            options={[
              { value: 'dark', label: 'Dark scene' },
              { value: 'bright', label: 'Bright scene' },
            ]}
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setPlaying((p) => !p)}
            disabled={reduced}
            aria-pressed={playing}
          >
            {playing ? 'Stop' : 'Play a sample'}
          </button>
        </div>
      </div>

      <div className="card divide-y divide-[var(--color-line)] px-4">
        <Row label="Show" id="show-label">
          <Segmented<CaptionDisplay>
            label="Show"
            value={o.display}
            onChange={(display) => update({ overlay: { display } })}
            options={[
              { value: 'both', label: 'Original and translation' },
              { value: 'translation', label: 'Translation' },
              { value: 'original', label: 'Original' },
            ]}
          />
        </Row>
        <Row label="Original line" hint="Shown smaller than the translation." id="placement-label">
          <Segmented
            label="Original line"
            value={o.originalPlacement}
            disabled={o.display !== 'both'}
            onChange={(originalPlacement) => update({ overlay: { originalPlacement } })}
            options={[
              { value: 'above', label: 'Above' },
              { value: 'below', label: 'Below' },
            ]}
          />
        </Row>
        <Row label="Text size" hint="Scales with the video, like TV subtitles." htmlFor="size">
          <input
            id="size"
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={o.fontScale}
            onChange={(e) => update({ overlay: { fontScale: Number(e.target.value) } })}
            className="w-[180px]"
            aria-valuetext={`${Math.round(o.fontScale * 100)}%`}
          />
          <output
            htmlFor="size"
            className="w-[44px] text-right tabular-nums text-[var(--color-muted)]"
          >
            {Math.round(o.fontScale * 100)}%
          </output>
        </Row>
        <Row label="Background" hint="A box reads best over busy or bright pictures." id="bg-label">
          <Segmented<CaptionBackground>
            label="Background"
            value={o.background}
            onChange={(background) => update({ overlay: { background } })}
            options={[
              { value: 'box', label: 'Box' },
              { value: 'shadow', label: 'Shadow' },
              { value: 'outline', label: 'Outline' },
            ]}
          />
        </Row>
        {o.background !== 'outline' && (
          <Row label={strengthLabel} htmlFor="opacity">
            <input
              id="opacity"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={o.backgroundOpacity}
              onChange={(e) => update({ overlay: { backgroundOpacity: Number(e.target.value) } })}
              className="w-[180px]"
              aria-valuetext={`${Math.round(o.backgroundOpacity * 100)}%`}
            />
            <output
              htmlFor="opacity"
              className="w-[44px] text-right tabular-nums text-[var(--color-muted)]"
            >
              {Math.round(o.backgroundOpacity * 100)}%
            </output>
          </Row>
        )}
        <Row
          label="Position"
          hint="Drag subtitles on a video to move them there; double-click them to put them back."
          id="position-label"
        >
          <Segmented
            label="Position"
            value={o.position}
            onChange={(position) => update({ overlay: { position } })}
            options={[
              { value: 'bottom', label: 'Bottom' },
              { value: 'top', label: 'Top' },
            ]}
          />
        </Row>
        {sitesMoved > 0 && (
          <Row label={`Moved on ${sitesMoved} ${sitesMoved === 1 ? 'site' : 'sites'}`}>
            <button type="button" className="btn btn-sm" onClick={() => void clearPositions()}>
              Reset all
            </button>
          </Row>
        )}
        <SwitchRow
          label="Show words while they’re heard"
          hint="Dimmed until they’re final. Turn off to see only finished lines."
          checked={o.showPartials}
          onChange={(showPartials) => update({ overlay: { showPartials } })}
        />
        <SwitchRow
          label="Tag lines in another language"
          hint="A small tag, such as DE, when a line isn’t in the language mostly spoken."
          checked={o.languageTags}
          onChange={(languageTags) => update({ overlay: { languageTags } })}
        />
        <SwitchRow
          label="Move up for player controls"
          hint="While the player shows its controls or its own captions."
          checked={o.avoidControls}
          onChange={(avoidControls) => update({ overlay: { avoidControls } })}
        />
      </div>
    </Section>
  );
}

function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string | undefined;
  checked: boolean;
  onChange(next: boolean): void;
}) {
  const id = `sw-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <Row label={label} hint={hint} id={id}>
      <Switch checked={checked} onChange={onChange} labelledBy={id} />
    </Row>
  );
}

// ---------------------------------------------------------------------------------------------

interface Command {
  name?: string;
  description?: string;
  shortcut?: string;
}

function ShortcutsSection() {
  const [commands, setCommands] = useState<Command[]>([]);
  useEffect(() => {
    browser.commands.getAll().then(setCommands, () => {});
  }, []);
  return (
    <Section id="shortcuts" title="Keyboard shortcuts">
      <div className="card divide-y divide-[var(--color-line)] px-4" data-testid="shortcuts">
        {commands.map((c) => (
          <div key={c.name} className="flex items-center justify-between gap-4 py-3">
            <span>{c.name === '_execute_action' ? 'Open Murmur' : c.description}</span>
            {c.shortcut ? (
              <span className="flex gap-1">
                {c.shortcut.split('+').map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </span>
            ) : (
              <span className="text-[var(--color-muted)]">Not set</span>
            )}
          </div>
        ))}
      </div>
      <div>
        <button
          type="button"
          className="btn"
          onClick={() => void browser.tabs.create({ url: 'chrome://extensions/shortcuts' })}
        >
          <Icon name="keyboard" /> Change shortcuts
        </button>
      </div>
    </Section>
  );
}

function PrivacySection() {
  const version = browser.runtime.getManifest().version;
  return (
    <Section id="privacy" title="Privacy">
      <div className="card p-5">
        <p className="flex items-center gap-2 text-[15px] font-semibold">
          <span className="text-[var(--color-accent)]">
            <Icon name="lock" size={18} />
          </span>
          Everything stays on this computer.
        </p>
        <ul className="mt-3 grid list-disc gap-1.5 pl-5 text-[var(--color-muted)]">
          <li>
            The tab’s audio is turned into subtitles on this computer and never sent anywhere.
          </li>
          <li>Subtitles and translations aren’t saved or sent.</li>
          <li>No account, no analytics, no tracking.</li>
          <li>The network is used only to download a model you choose, once.</li>
          <li>
            With the companion app, audio goes to that app on this computer, and nowhere else.
          </li>
        </ul>
      </div>
      <p className="text-[13px] text-[var(--color-muted)]">
        Murmur {version} ·{' '}
        <a className="link" href={REPO_URL} target="_blank" rel="noreferrer">
          Source code
        </a>{' '}
        · MIT License
      </p>
    </Section>
  );
}
