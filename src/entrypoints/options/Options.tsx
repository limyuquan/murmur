import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { createBuiltinRegistry } from '@/engines/builtin';
import { CHROME_WEBSPEECH_ID } from '@/engines/chrome/info';
import { PROFILES, type ProfileId, resolveEngines } from '@/engines/profiles';
import { sitePatterns } from '@/lookahead/sites';
import { call } from '@/messaging/client';
import { formatSize, freeSpaceText } from '@/models/types';
import { SubtitlePreview } from '@/overlay/preview';
import { clearPositions, loadPositions, watchPositions } from '@/settings/positions';
import {
  type CaptionBackground,
  type CaptionDisplay,
  type Settings,
  siteFromInput,
} from '@/settings/settings';
import { REPO_URL } from '@/shared/ids';
import {
  Icon,
  type IconName,
  Keys,
  Logo,
  Notice,
  Segmented,
  Select,
  Switch,
} from '@/ui/components';
import { GlossaryEditor } from '@/ui/glossary';
import {
  openShortcutSettings,
  useHardware,
  useMemoryFit,
  useModels,
  useReducedMotion,
  useSettings,
} from '@/ui/hooks';
import { languageOptions } from '@/ui/languages';
import {
  BrowserGaps,
  DeviceCard,
  engineFits,
  ModelList,
  ModelSizeOptions,
  ProfileCards,
  ProfileDownload,
  type ProfileModels,
  packsForSettings,
  profileModels,
} from '@/ui/models';
import { Scene, type SceneKind } from '@/ui/scenes';
import { SpokenLanguages } from '@/ui/spoken';

const SECTIONS: readonly { id: string; label: string; icon: IconName }[] = [
  { id: 'models', label: 'Models', icon: 'layers' },
  { id: 'languages', label: 'Languages', icon: 'globe' },
  { id: 'glossary', label: 'Glossary', icon: 'book' },
  { id: 'subtitles', label: 'Subtitles', icon: 'subtitles' },
  { id: 'ahead', label: 'Ahead of time', icon: 'ahead' },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard' },
  { id: 'privacy', label: 'Privacy', icon: 'lock' },
];

/** The section being read: the last whose top has scrolled near the top of the window. */
function useCurrentSection(): string {
  const [current, setCurrent] = useState<string>(SECTIONS[0]?.id ?? '');
  useEffect(() => {
    const onScroll = () => {
      let id = SECTIONS[0]?.id ?? '';
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= window.innerHeight / 3) id = s.id;
      }
      // At the very bottom, the last section is the one being read.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
        id = SECTIONS.at(-1)?.id ?? id;
      }
      setCurrent(id);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return current;
}

export function Options({ initial }: { initial: Settings }) {
  const [settings, update] = useSettings(initial);
  const current = useCurrentSection();

  // The page renders after load, so the browser's own jump to #section missed it.
  useEffect(() => {
    const id = location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView();
  }, []);

  return (
    <div className="page">
      <nav className="nav" aria-label="Sections">
        <div className="nav-brand">
          <Logo size={32} />
          <span className="t-heading">Murmur</span>
        </div>
        <ul className="nav-list">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a className="nav-item" href={`#${s.id}`} aria-current={s.id === current}>
                <Icon name={s.icon} size={20} />
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <main className="main">
        <header className="page-head">
          <h1 className="t-display">Settings</h1>
          <p className="muted">Changes are saved as you make them.</p>
        </header>
        <ModelsSection settings={settings} update={update} />
        <LanguagesSection settings={settings} update={update} />
        <GlossarySection settings={settings} update={update} />
        <SubtitlesSection settings={settings} update={update} />
        <AheadSection settings={settings} update={update} />
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
    <section id={id} aria-labelledby={`${id}-title`} className="section">
      <div className="section-head">
        <h2 id={`${id}-title`} className="t-title">
          {title}
        </h2>
        {intro && <p>{intro}</p>}
      </div>
      {children}
    </section>
  );
}

/** A row in a card: a label (and hint) on the left, its control on the right. */
function Row({
  label,
  hint,
  htmlFor,
  id,
  disabled,
  children,
}: {
  label: string;
  hint?: string | undefined;
  htmlFor?: string;
  id?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="list-row" data-disabled={disabled ? 'true' : undefined}>
      <div className="grow">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="t-label">
            {label}
          </label>
        ) : (
          <p id={id} className="t-label">
            {label}
          </p>
        )}
        {hint && <p className="hint">{hint}</p>}
      </div>
      <div className="control">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function ModelsSection({ settings, update }: { settings: Settings; update: Update }) {
  const registry = useMemo(createBuiltinRegistry, []);
  const hardware = useHardware();
  const [view, actions, error] = useModels();
  const fit = useMemoryFit();
  const modelsOf = (p: ProfileId | 'custom'): ProfileModels | null =>
    hardware ? profileModels(p, settings, registry, hardware, view, fit) : null;
  const selected = modelsOf(settings.profile);
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
      <DeviceCard hardware={hardware} />
      <BrowserGaps />
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
        foot={
          selected && (
            <ProfileDownload
              label={selectedLabel}
              models={selected}
              packs={packs}
              actions={actions}
            />
          )
        }
      />

      <ModelSizeOptions
        settings={settings}
        update={update}
        registry={registry}
        hardware={hardware}
        models={selected}
      />

      {settings.profile === 'custom' && (
        <CustomEngines
          settings={settings}
          update={update}
          hardware={hardware}
          registry={registry}
        />
      )}

      <details
        className="card disclosure"
        id="downloads"
        data-testid="manage-downloads"
        open={location.hash === '#downloads' || undefined}
      >
        <summary>
          <span className="grow stack g1">
            <span className="t-heading">Manage downloads</span>
            <span className="t-small muted">Each model from Murmur, one by one.</span>
          </span>
          {view && (
            <span className="t-small muted num" data-testid="disk-usage">
              {formatSize(view.storage.modelsMB)} used
              {freeSpaceText(view.storage.availableMB) !== null &&
                ` · ${freeSpaceText(view.storage.availableMB)}`}
            </span>
          )}
          <span className="chev">
            <Icon name="chevron" size={20} />
          </span>
        </summary>
        <div className="topline">
          {error && (
            <div className="block-row">
              <Notice tone="error" icon="alert">
                {error}
              </Notice>
            </div>
          )}
          {view ? (
            view.models.length > 0 ? (
              <ModelList view={view} actions={actions} />
            ) : (
              <p className="block-row muted">
                None of the model sizes needs a download from Murmur on this device.
              </p>
            )
          ) : (
            <p className="block-row muted">Loading…</p>
          )}
        </div>
        <div className="card-foot">
          <span className="t-small muted">
            Models are downloaded from Hugging Face and kept on this computer.
          </span>
          {view && view.storage.modelsMB > 0 && (
            <button
              type="button"
              className="btn btn-sm btn-quiet"
              onClick={() => {
                for (const m of view.models)
                  if (m.status.state === 'ready' || m.status.state === 'partial')
                    actions.remove(m.info.id);
              }}
            >
              <Icon name="trash" /> Delete all
            </button>
          )}
        </div>
      </details>
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
    <div className="card rows">
      <Row label="Speech recognition" htmlFor="custom-asr">
        <Select
          id="custom-asr"
          value={settings.custom.asr}
          onChange={(e) => update({ custom: { asr: e.target.value } })}
        >
          {registry.asrEngines().map((e) => (
            <option key={e.id} value={e.id} disabled={!engineFits(e, hardware)}>
              {e.unavailable ? `${e.label} (${e.unavailable})` : e.label}
            </option>
          ))}
        </Select>
      </Row>
      <Row label="Translation" htmlFor="custom-mt">
        <Select
          id="custom-mt"
          value={settings.custom.translation}
          onChange={(e) => update({ custom: { translation: e.target.value } })}
        >
          {registry.translationEngines().map((e) => (
            <option key={e.id} value={e.id} disabled={!engineFits(e, hardware)}>
              {e.unavailable ? `${e.label} (${e.unavailable})` : e.label}
            </option>
          ))}
        </Select>
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
      <div className="card rows">
        <Row
          label="Translate into"
          hint="Lines already in this language are shown as they are."
          htmlFor="target"
        >
          <Select
            id="target"
            value={settings.targetLanguage}
            onChange={(e) => update({ targetLanguage: e.target.value })}
          >
            {languages.map((l) => (
              <option key={l.tag} value={l.tag}>
                {l.name}
              </option>
            ))}
          </Select>
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

function SubtitlesSection({ settings, update }: { settings: Settings; update: Update }) {
  const o = settings.overlay;
  const [scene, setScene] = useState<SceneKind>('dark');
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
      <div className="card">
        <div
          className="preview"
          role="img"
          aria-label="Preview of subtitles on a video"
          data-testid="preview"
        >
          <Scene kind={scene} />
          <div ref={box} className="fill" />
        </div>
        <div className="card-foot">
          <Segmented<SceneKind>
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
            <Icon name={playing ? 'stop' : 'play'} /> {playing ? 'Stop' : 'Play a sample'}
          </button>
        </div>
      </div>

      <div className="card rows">
        <Row label="Show" id="show-label">
          <Segmented<CaptionDisplay>
            label="Show"
            value={o.display}
            onChange={(display) => update({ overlay: { display } })}
            options={[
              { value: 'translation', label: 'Translation' },
              { value: 'both', label: 'Original and translation' },
              { value: 'original', label: 'Original' },
            ]}
          />
        </Row>
        <Row
          label="Original line"
          hint="Shown smaller than the translation."
          id="placement-label"
          disabled={o.display !== 'both'}
        >
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
          <Range
            id="size"
            min={0.5}
            max={2}
            value={o.fontScale}
            onChange={(fontScale) => update({ overlay: { fontScale } })}
          />
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
            <Range
              id="opacity"
              min={0}
              max={1}
              value={o.backgroundOpacity}
              onChange={(backgroundOpacity) => update({ overlay: { backgroundOpacity } })}
            />
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

/** A slider with its value in per cent beside it. */
function Range({
  id,
  min,
  max,
  value,
  onChange,
}: {
  id: string;
  min: number;
  max: number;
  value: number;
  onChange(next: number): void;
}) {
  const pct = `${Math.round(value * 100)}%`;
  const at = `${((value - min) / (max - min)) * 100}%`;
  return (
    <>
      <input
        id={id}
        type="range"
        className="range"
        min={min}
        max={max}
        step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-valuetext={pct}
        style={{ '--at': at } as React.CSSProperties}
      />
      <output htmlFor={id} className="range-value">
        {pct}
      </output>
    </>
  );
}

function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  testId,
}: {
  label: string;
  hint?: string | undefined;
  checked: boolean;
  onChange(next: boolean): void;
  testId?: string;
}) {
  const id = `sw-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <Row label={label} hint={hint} id={id}>
      <Switch checked={checked} onChange={onChange} labelledBy={id} testId={testId} />
    </Row>
  );
}

// ---------------------------------------------------------------------------------------------

/** Where adding a site is: asking Chrome for access, refused, or added (until a reload). */
type AddState =
  | { state: 'asking'; site: string }
  | { state: 'refused'; site: string }
  | { state: 'added'; site: string }
  | { state: 'failed'; message: string }
  | { state: 'invalid' }
  | { state: 'already'; site: string };

function AheadSection({ settings, update }: { settings: Settings; update: Update }) {
  const { sites, off } = settings.lookahead;
  const [text, setText] = useState('');
  const [adding, setAdding] = useState<AddState | null>(null);
  const site = siteFromInput(text);

  /**
   * Adds the typed site: access to it is asked for straight from the submit (the click or Enter
   * is what lets Chrome ask), then the service worker turns lookahead on there.
   */
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!site) {
      setAdding(text.trim() ? { state: 'invalid' } : null);
      return;
    }
    if (sites.includes(site)) {
      setAdding({ state: 'already', site });
      return;
    }
    setAdding({ state: 'asking', site });
    let request: Promise<boolean>;
    try {
      request = browser.permissions.request({ origins: sitePatterns(site) });
    } catch (err) {
      request = Promise.reject(err);
    }
    const fail = (err: unknown) =>
      setAdding({ state: 'failed', message: err instanceof Error ? err.message : String(err) });
    request.then((granted) => {
      if (!granted) {
        setAdding({ state: 'refused', site });
        return;
      }
      call('setLookahead', { site, on: true }).then((result) => {
        if (!result.sites.includes(site)) {
          setAdding({
            state: 'failed',
            message: `Murmur can’t show subtitles ahead of time on ${site}.`,
          });
          return;
        }
        setText('');
        setAdding({ state: 'added', site });
      }, fail);
    }, fail);
  };

  const note = (() => {
    switch (adding?.state) {
      case undefined:
        return null;
      case 'asking':
        return (
          <Notice tone="translating" icon="clock">
            Waiting for access to {adding.site}… Chrome asks at the top of the window.
          </Notice>
        );
      case 'refused':
        return (
          <Notice tone="error" icon="alert">
            Murmur needs access to {adding.site} for this. Chrome didn’t give it.
          </Notice>
        );
      case 'added':
        return (
          <Notice tone="success" icon="check">
            On for {adding.site}. It starts when a page there loads or reloads.
          </Notice>
        );
      case 'failed':
        return (
          <Notice tone="error" icon="alert">
            Couldn’t add it: {adding.message}
          </Notice>
        );
      case 'invalid':
        return (
          <Notice tone="behind" icon="info">
            That isn’t a site address. Type one such as video.example.com.
          </Notice>
        );
      case 'already':
        return (
          <Notice tone="behind" icon="info">
            {adding.site} is already in the list.
          </Notice>
        );
    }
  })();

  return (
    <Section
      id="ahead"
      title="Subtitles ahead of time (beta)"
      intro="On the sites you choose, Murmur reads the audio the video player has already loaded and makes subtitles before the speech plays, so they show on time. Turn it on for a site in the popup, or add it below. It needs the Balanced or Best model size."
    >
      <div className="card rows" data-testid="ahead">
        <SwitchRow
          label="On for the sites below"
          hint="Off: Murmur leaves every site’s player alone. Takes effect when a page reloads."
          checked={!off}
          onChange={(on) => update({ lookahead: { off: !on } })}
          testId="ahead-all"
        />
        {sites.length === 0 ? (
          <div className="list-row">
            <p className="muted">No sites yet.</p>
          </div>
        ) : (
          sites.map((s) => (
            <div key={s} className="list-row" data-testid={`ahead-site-${s}`}>
              <span className="tile">
                <Icon name="globe" />
              </span>
              <span className="grow t-label">{s}</span>
              <button
                type="button"
                className="btn btn-sm btn-quiet"
                aria-label={`Remove ${s}`}
                onClick={() =>
                  update((current) => ({
                    lookahead: { sites: current.lookahead.sites.filter((x) => x !== s) },
                  }))
                }
              >
                Remove
              </button>
            </div>
          ))
        )}
        <form className="stack g3 add-site" onSubmit={add} data-testid="ahead-add">
          <div className="row g4">
            <span className="tile">
              <Icon name="plus" />
            </span>
            <label htmlFor="ahead-site" className="sr-only">
              Site to add
            </label>
            <input
              id="ahead-site"
              className="input grow"
              value={text}
              placeholder="Add a site, such as video.example.com"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setText(e.target.value);
                if (adding?.state !== 'asking') setAdding(null);
              }}
            />
            <button
              type="submit"
              className="btn"
              disabled={!text.trim() || adding?.state === 'asking'}
            >
              Add
            </button>
          </div>
          {note && (
            <div role="status" data-testid="ahead-add-note">
              {note}
            </div>
          )}
        </form>
      </div>
    </Section>
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
      <div className="card rows" data-testid="shortcuts">
        {commands.map((c) => (
          <div key={c.name} className="list-row">
            <span className="grow t-label">
              {c.name === '_execute_action' ? 'Open Murmur' : c.description}
            </span>
            {c.shortcut ? (
              <Keys shortcut={c.shortcut} />
            ) : (
              <span className="t-small muted">Not set</span>
            )}
          </div>
        ))}
      </div>
      <div>
        <button type="button" className="btn" onClick={openShortcutSettings}>
          <Icon name="keyboard" /> Change shortcuts
        </button>
      </div>
    </Section>
  );
}

function PrivacySection() {
  const version = browser.runtime.getManifest().version;
  const points = [
    'The tab’s audio is turned into subtitles on this computer and never sent anywhere.',
    'Subtitles and translations aren’t saved or sent.',
    'On sites where subtitles ahead of time are on, Murmur reads the audio the video player loads, on this computer, while subtitles are on.',
    'No account, no analytics, no tracking.',
    'The network is used only to download a model you choose, once.',
  ];
  return (
    <Section id="privacy" title="Privacy">
      <div className="card card-pad stack g3">
        <div className="row g3">
          <span className="tile tile-lg" data-tone="success">
            <Icon name="lock" size={20} />
          </span>
          <p className="t-heading">Everything stays on this computer.</p>
        </div>
        <ul className="list under-tile muted">
          {points.map((t) => (
            <li key={t}>
              <span className="mark" data-tone="success">
                <Icon name="check" />
              </span>
              <span className="measure">{t}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="t-small muted">
        Murmur {version} ·{' '}
        <a className="link" href={REPO_URL} target="_blank" rel="noreferrer">
          Source code
        </a>{' '}
        · MIT License
      </p>
    </Section>
  );
}
