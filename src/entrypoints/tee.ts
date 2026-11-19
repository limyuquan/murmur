import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { startPageTee } from '@/lookahead/tee';

/**
 * Lookahead's tee, in the page's own world from `document_start`, on the sites where lookahead is
 * on (registered by src/background/lookahead.ts). No extension APIs here.
 */
export default defineUnlistedScript(() => {
  try {
    startPageTee(window);
  } catch {
    // Never break the page.
  }
});
