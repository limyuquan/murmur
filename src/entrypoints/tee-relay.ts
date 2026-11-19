import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { startRelay } from '@/lookahead/relay';
import { siteKey } from '@/settings/positions';
import { loadSettings, lookaheadOn, watchSettings } from '@/settings/settings';

/**
 * Lookahead's relay, in Murmur's isolated world from `document_start`, next to the tee (see
 * src/lookahead/relay.ts). Checks the settings as soon as it can: with lookahead turned off for
 * this site, or the kill switch on, the tee is told to pass straight through at once.
 */
export default defineUnlistedScript(() => {
  const relay = startRelay(window);
  if (!relay) return;
  const ancestors = location.ancestorOrigins;
  const site =
    siteKey(location.href) ??
    (ancestors && ancestors.length > 0 ? siteKey(ancestors.item(0) ?? '') : null);
  const check = (settings: Parameters<typeof lookaheadOn>[0]) => {
    if (!lookaheadOn(settings, site) && !relay.isOff) relay.off();
  };
  loadSettings().then(check, () => {});
  watchSettings(check);
});
