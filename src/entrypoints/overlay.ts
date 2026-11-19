import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { startOverlay } from '@/overlay';

/**
 * Injected into the captured tab (all frames) by the service worker with
 * `scripting.executeScript({ files: ['/overlay.js'] })`. Plain TS, no framework: it runs inside
 * other people's pages.
 */
export default defineUnlistedScript(() => {
  startOverlay();
});
