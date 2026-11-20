/** The spoken-languages picker, shared by the options page and the welcome page. */
import { useId, useMemo } from 'react';
import {
  MAX_SPOKEN_FOR_CHROME,
  type Settings,
  type SettingsChange,
  spokenLanguages,
} from '@/settings/settings';
import { Icon, Notice, Switch } from './components';
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
  const hintId = useId();
  return (
    <>
      <div className="stack g3 block-row">
        <fieldset className="stack g3" data-testid="spoken" aria-describedby={hintId}>
          <legend className="sr-only">Spoken languages</legend>
          <div className="stack">
            <p className="t-label" aria-hidden="true">
              Spoken languages
            </p>
            <p id={hintId} className="t-small muted">
              The languages in the videos you watch. Chrome’s speech recognition listens for these
              (up&nbsp;to&nbsp;{MAX_SPOKEN_FOR_CHROME}). Whisper detects the language of each line.
            </p>
          </div>
          <div className="chips">
            {options.map((l) => {
              const on = chosen.includes(l.tag);
              return (
                <label key={l.tag} className="chip">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => toggle(l.tag, e.target.checked)}
                  />
                  {on && <Icon name="check" />}
                  {l.name}
                </label>
              );
            })}
          </div>
        </fieldset>
        {chromeSpeech && chosen.length > MAX_SPOKEN_FOR_CHROME && (
          <Notice tone="behind" testId="spoken-limit">
            Chrome’s speech recognition listens for the first {MAX_SPOKEN_FOR_CHROME} chosen:{' '}
            {listNames(heard)}.
          </Notice>
        )}
      </div>
      <div className="list-row">
        <div className="grow">
          <p id={anyId} className="t-label">
            Detect any language
          </p>
          <p className="hint">
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
    </>
  );
}
