import { describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  applyPatch,
  DEFAULT_SETTINGS,
  loadSettings,
  MAX_SPOKEN_FOR_CHROME,
  mergeSettings,
  readStoredSettings,
  SETTINGS_KEY,
  SETTINGS_VERSION,
  saveSettings,
  spokenLanguages,
  watchSettings,
} from '@/settings/settings';

describe('mergeSettings', () => {
  it('fills in defaults for missing or broken data', () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings('nonsense')).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings({ overlay: null, custom: [] })).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid values and replaces invalid ones', () => {
    const s = mergeSettings({
      targetLanguage: 'pt-BR',
      spokenLanguages: ['fr', 'not a tag!', 'fr', 3, 'de'],
      onlySpoken: 'no',
      profile: 'turbo',
      translatePartials: 'yes',
      overlay: { display: 'original', fontScale: 9, backgroundOpacity: -1, position: 'side' },
    });
    expect(s.targetLanguage).toBe('pt-BR');
    expect(s.spokenLanguages).toEqual(['fr', 'de']);
    expect(s.onlySpoken).toBe(false);
    expect(s.profile).toBe(DEFAULT_SETTINGS.profile);
    expect(s.translatePartials).toBe(false);
    expect(s.overlay).toEqual({
      ...DEFAULT_SETTINGS.overlay,
      display: 'original',
      fontScale: 2,
      backgroundOpacity: 0,
    });
  });

  it('applies nested patches one level deep', () => {
    const s = applyPatch(DEFAULT_SETTINGS, { overlay: { position: 'top' }, custom: { asr: 'x' } });
    expect(s.overlay).toEqual({ ...DEFAULT_SETTINGS.overlay, position: 'top' });
    expect(s.custom).toEqual({ ...DEFAULT_SETTINGS.custom, asr: 'x' });
  });
});

describe('display default', () => {
  const old = (display: unknown) => ({
    ...DEFAULT_SETTINGS,
    overlay: { ...DEFAULT_SETTINGS.overlay, display },
  });

  it('is the translation only', () => {
    expect(DEFAULT_SETTINGS.overlay.display).toBe('translation');
    expect(readStoredSettings(undefined).overlay.display).toBe('translation');
  });

  it('takes the old default, stored before version 2, as unset', () => {
    // Before version 2 every save wrote the whole object, `both` included.
    expect(readStoredSettings(old('both')).overlay.display).toBe('translation');
    expect(readStoredSettings({ version: 1, overlay: { display: 'both' } }).overlay.display).toBe(
      'translation',
    );
    // The rest of what was stored stays.
    const s = readStoredSettings({ ...old('both'), targetLanguage: 'ja' });
    expect(s.targetLanguage).toBe('ja');
    expect(s.overlay).toEqual({ ...DEFAULT_SETTINGS.overlay, display: 'translation' });
  });

  it('keeps any other choice, and both once chosen from version 2 on', () => {
    expect(readStoredSettings(old('original')).overlay.display).toBe('original');
    expect(readStoredSettings(old('translation')).overlay.display).toBe('translation');
    expect(readStoredSettings({ ...old('both'), version: SETTINGS_VERSION }).overlay.display).toBe(
      'both',
    );
  });

  it('a choice of both made now survives a reload', async () => {
    await fakeBrowser.storage.local.set({ [SETTINGS_KEY]: old('both') });
    expect((await loadSettings()).overlay.display).toBe('translation');
    // Saving anything stores the new version with the migrated display.
    await saveSettings({ targetLanguage: 'ja' });
    const stored = (await fakeBrowser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
    expect(stored).toMatchObject({
      version: SETTINGS_VERSION,
      overlay: { display: 'translation' },
    });
    await saveSettings({ overlay: { display: 'both' } });
    expect((await loadSettings()).overlay.display).toBe('both');
  });

  it('watchers get migrated settings too', async () => {
    const seen: string[] = [];
    const stop = watchSettings((s) => seen.push(s.overlay.display));
    await fakeBrowser.storage.local.set({ [SETTINGS_KEY]: old('both') });
    expect(seen).toEqual(['translation']);
    stop();
  });
});

describe('spokenLanguages', () => {
  it('uses the chosen languages, else the browser’s offered ones, else English', () => {
    expect(spokenLanguages({ spokenLanguages: ['ja', 'de'] }, ['fr-FR'])).toEqual(['ja', 'de']);
    expect(
      spokenLanguages({ spokenLanguages: [] }, ['fr-CA', 'fr', 'en-GB', 'xx'], ['fr', 'en']),
    ).toEqual(['fr', 'en']);
    expect(spokenLanguages({ spokenLanguages: [] }, ['xx'], ['fr'])).toEqual(['en']);
    expect(spokenLanguages({ spokenLanguages: [] }, ['de', 'es', 'fr', 'it', 'nl']).length).toBe(
      MAX_SPOKEN_FOR_CHROME,
    );
  });
});

describe('storage', () => {
  it('saves, loads and notifies', async () => {
    const seen: string[] = [];
    const stop = watchSettings((s) => seen.push(s.targetLanguage));
    await saveSettings({ targetLanguage: 'ja' });
    expect((await loadSettings()).targetLanguage).toBe('ja');
    const stored = await fakeBrowser.storage.local.get(SETTINGS_KEY);
    expect(stored[SETTINGS_KEY]).toMatchObject({ targetLanguage: 'ja' });
    expect(seen).toEqual(['ja']);
    stop();
  });
});
