/**
 * Lookahead's page scripts, registered with the browser only for the sites where the person
 * turned it on: the tee (`tee.js`, the page's own world) and its relay (`tee-relay.js`, Murmur's
 * isolated world), both from `document_start` in every frame, so they are in place before a
 * player creates its MediaSource. A site needs Murmur's access to it (asked for when the person
 * turns lookahead on there); sites without it are left out. Registrations persist across browser
 * restarts and are brought in line with the settings whenever the service worker starts or they
 * change. The kill switch (`lookahead.off`) removes them all.
 */
import { browser } from 'wxt/browser';
import { sitePatterns } from '@/lookahead/sites';
import { type LookaheadSettings, loadSettings, saveSettings } from '@/settings/settings';
import { LOG_PREFIX } from '@/shared/ids';

export const TEE_SCRIPT = { id: 'murmur-tee', file: 'tee.js' } as const;
export const RELAY_SCRIPT = { id: 'murmur-tee-relay', file: 'tee-relay.js' } as const;

/** The patterns the scripts should run on, for these settings, among those Murmur may access. */
export async function wantedPatterns(
  settings: LookaheadSettings,
  allowed: (pattern: string) => Promise<boolean>,
): Promise<string[]> {
  if (settings.off) return [];
  const out: string[] = [];
  for (const site of settings.sites) {
    for (const pattern of sitePatterns(site)) {
      if (await allowed(pattern)) out.push(pattern);
    }
  }
  return out;
}

let syncing: Promise<void> = Promise.resolve();

/** Registers, updates or removes the page scripts to match the settings. Serialised. */
export function syncLookaheadScripts(): Promise<void> {
  const run = syncing.then(async () => {
    const settings = await loadSettings();
    const matches = await wantedPatterns(settings.lookahead, (pattern) =>
      browser.permissions.contains({ origins: [pattern] }).catch(() => false),
    );
    const ids = [TEE_SCRIPT.id, RELAY_SCRIPT.id];
    const existing = await browser.scripting.getRegisteredContentScripts({ ids });
    if (matches.length === 0) {
      if (existing.length > 0) await browser.scripting.unregisterContentScripts({ ids });
      return;
    }
    const common = {
      matches,
      runAt: 'document_start' as const,
      allFrames: true,
      matchOriginAsFallback: true,
      persistAcrossSessions: true,
    };
    const scripts = [
      { id: TEE_SCRIPT.id, js: [TEE_SCRIPT.file], world: 'MAIN' as const, ...common },
      { id: RELAY_SCRIPT.id, js: [RELAY_SCRIPT.file], world: 'ISOLATED' as const, ...common },
    ];
    if (existing.length === 2) {
      await browser.scripting.updateContentScripts(scripts);
    } else {
      if (existing.length > 0) await browser.scripting.unregisterContentScripts({ ids });
      await browser.scripting.registerContentScripts(scripts);
    }
  });
  syncing = run.catch((err: unknown) =>
    console.warn(LOG_PREFIX, 'lookahead scripts not registered', err),
  );
  return run;
}

/** Turns lookahead on or off for `site` (access must already be granted to turn it on). */
export async function setLookaheadSite(site: string, on: boolean): Promise<LookaheadSettings> {
  const next = await saveSettings((current) => {
    const sites = current.lookahead.sites.filter((s) => s !== site);
    if (on) sites.push(site);
    return { lookahead: { sites } };
  });
  await syncLookaheadScripts();
  return next.lookahead;
}
