import { useEffect, useMemo, useState } from 'react';
import { createBuiltinRegistry } from '@/engines/builtin';
import { checkRequirements, detectHardware, type HardwareInfo } from '@/engines/hardware';
import { PROFILE_ORDER, PROFILES, type ProfileChoice, recommendProfile } from '@/engines/profiles';
import {
  type CaptionDisplay,
  type Settings,
  type SettingsPatch,
  saveSettings,
} from '@/settings/settings';

/** Languages offered as targets and hints, shown by name in the browser's language. */
const LANGUAGES = [
  'ar',
  'de',
  'en',
  'es',
  'fr',
  'hi',
  'id',
  'it',
  'ja',
  'ko',
  'nl',
  'pl',
  'pt',
  'ru',
  'sv',
  'th',
  'tr',
  'uk',
  'vi',
  'zh',
];

export function Options({ initial }: { initial: Settings }) {
  const [settings, setSettings] = useState(initial);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const registry = useMemo(createBuiltinRegistry, []);
  const names = useMemo(
    () => new Intl.DisplayNames([navigator.language], { type: 'language' }),
    [],
  );
  const languages = useMemo(
    () =>
      LANGUAGES.map((tag) => ({ tag, name: names.of(tag) ?? tag })).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    [names],
  );

  useEffect(() => {
    detectHardware().then(setHardware, () => {});
  }, []);

  const update = (patch: SettingsPatch) => {
    saveSettings(patch).then(setSettings, (err: unknown) => console.error(err));
  };

  const recommended = hardware ? recommendProfile(hardware) : null;

  return (
    <main className="mx-auto max-w-[640px] p-8 text-sm flex flex-col gap-8">
      <header>
        <h1 className="text-xl font-semibold">Earshot settings</h1>
        <p className="text-[var(--color-muted)]">Changes are saved as you make them.</p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">Languages</h2>
        <label className="flex items-center justify-between gap-4">
          Translate into
          <select
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
        </label>
        <label className="flex items-center justify-between gap-4">
          Spoken language
          <select
            className="input"
            value={settings.sourceLanguage}
            onChange={(e) => update({ sourceLanguage: e.target.value })}
          >
            <option value="auto">Detect for each line</option>
            {languages.map((l) => (
              <option key={l.tag} value={l.tag}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">Models</h2>
        {PROFILE_ORDER.map((id) => (
          <label key={id} className="flex items-start gap-2">
            <input
              type="radio"
              name="profile"
              checked={settings.profile === id}
              onChange={() => update({ profile: id })}
            />
            <span>
              {PROFILES[id].label}
              {recommended === id && (
                <span className="text-[var(--color-muted)]"> (suits this device)</span>
              )}
              <br />
              <span className="text-[var(--color-muted)]">{PROFILES[id].description}</span>
            </span>
          </label>
        ))}
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="profile"
            checked={settings.profile === ('custom' satisfies ProfileChoice)}
            onChange={() => update({ profile: 'custom' })}
          />
          <span>Custom</span>
        </label>
        {settings.profile === 'custom' && (
          <div className="ml-6 flex flex-col gap-2">
            <label className="flex items-center justify-between gap-4">
              Speech recognition
              <select
                className="input"
                value={settings.custom.asr}
                onChange={(e) => update({ custom: { asr: e.target.value } })}
              >
                {registry.asrEngines().map((e) => (
                  <option key={e.id} value={e.id} disabled={!fits(e.requirements, hardware)}>
                    {e.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between gap-4">
              Translation
              <select
                className="input"
                value={settings.custom.translation}
                onChange={(e) => update({ custom: { translation: e.target.value } })}
              >
                {registry.translationEngines().map((e) => (
                  <option key={e.id} value={e.id} disabled={!fits(e.requirements, hardware)}>
                    {e.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <p className="text-[var(--color-muted)]">
          Only demo engines are included so far: they show when sound was heard, not words.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">Subtitles</h2>
        <label className="flex items-center justify-between gap-4">
          Show
          <select
            className="input"
            value={settings.overlay.display}
            onChange={(e) => update({ overlay: { display: e.target.value as CaptionDisplay } })}
          >
            <option value="both">Original and translation</option>
            <option value="translation">Translation only</option>
            <option value="original">Original only</option>
          </select>
        </label>
        <label className="flex items-center justify-between gap-4">
          Size
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={settings.overlay.fontScale}
            onChange={(e) => update({ overlay: { fontScale: Number(e.target.value) } })}
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.overlay.showPartials}
            onChange={(e) => update({ overlay: { showPartials: e.target.checked } })}
          />
          Show text that may still change, dimmed
        </label>
      </section>
    </main>
  );
}

function fits(req: Parameters<typeof checkRequirements>[0], hw: HardwareInfo | null): boolean {
  return hw === null || checkRequirements(req, hw).ok;
}
