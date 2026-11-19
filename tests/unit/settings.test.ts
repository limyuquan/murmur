import { describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  applyPatch,
  DEFAULT_SETTINGS,
  loadSettings,
  mergeSettings,
  SETTINGS_KEY,
  saveSettings,
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
      sourceLanguage: 'not a tag!',
      profile: 'turbo',
      translatePartials: 'yes',
      overlay: { display: 'original', fontScale: 9, backgroundOpacity: -1, position: 'side' },
    });
    expect(s.targetLanguage).toBe('pt-BR');
    expect(s.sourceLanguage).toBe('auto');
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
