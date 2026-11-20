/** The spoken-languages picker, shared by the options page and the welcome page. */
import { useId, useMemo } from 'react';
import {
  MAX_SPOKEN_FOR_CHROME,
  type Settings,
  type SettingsChange,
  spokenLanguages,
} from '@/settings/settings';
import { Switch } from './components';
import { LANGUAGES, languageOptions, listNames } from './languages';

/** The languages a session will listen for, as the picker shows them. */
export function chosenSpoken(settings: Settings): string[] {
  return spokenLanguages(settings, navigator.languages, LANGUAGES);
}

export function SpokenLanguages({
  settings,
  update,
  chromeSpeech,
}: {
  settings: Settings;
  update(change: SettingsChange): void;
  /** The chosen models use Chrome's speech recognition (it hears only the first few). */
  chromeSpeech: boolean;
}) {
  const options = useMemo(languageOptions, []);
  const chosen = chosenSpoken(settings);
  const anyId = useId();
  const toggle = (tag: string, on: boolean) => {
    // From the stored list at the time of writing, not this page's copy of it.
    update((current) => {
      const list = chosenSpoken(current);
      const next = on ? [...list.filter((t) => t !== tag), tag] : list.filter((t) => t !== tag);
      // At least one: Chrome's speech recognition needs a language to listen for.
      return next.length > 0 ? { spokenLanguages: next } : {};
    });
  };
  const heard = chosen.slice(0, MAX_SPOKEN_FOR_CHROME);
  return (
    <div className="grid gap-3 py-3">
      <fieldset className="grid gap-3" data-testid="spoken">
        <legend className="contents">
          <span className="font-medium">Spoken languages</span>
        </legend>
        <p className="-mt-2 text-[13px] text-[var(--color-muted)]">
          The languages in the videos you watch. Chrome’s speech recognition listens for these (up
          to {MAX_SPOKEN_FOR_CHROME}). Whisper detects the language of each line.
        </p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
          {options.map((l) => (
            <label key={l.tag} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={chosen.includes(l.tag)}
                onChange={(e) => toggle(l.tag, e.target.checked)}
              />
              {l.name}
            </label>
          ))}
        </div>
      </fieldset>
      {chromeSpeech && chosen.length > MAX_SPOKEN_FOR_CHROME && (
        <p className="text-[13px] text-[var(--color-warn)]" data-testid="spoken-limit">
          Chrome’s speech recognition listens for the first {MAX_SPOKEN_FOR_CHROME} chosen:{' '}
          {listNames(heard)}.
        </p>
      )}
      <div className="flex items-center justify-between gap-6 pt-1">
        <div>
          <span id={anyId} className="font-medium">
            Detect any language
          </span>
          <p className="text-[13px] text-[var(--color-muted)]">
            Whisper picks each line’s language from all it knows. Turn off to pick only from the
            languages above.
          </p>
        </div>
        <Switch
          checked={!settings.onlySpoken}
          onChange={(any) => update({ onlySpoken: !any })}
          labelledBy={anyId}
          testId="detect-any"
        />
      </div>
    </div>
  );
}
