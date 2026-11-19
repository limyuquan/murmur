/**
 * What lookahead knows about particular sites: which video a page plays (so cues made for it are
 * found again when it comes back in a new MediaSource, as after an ad), and when the player shows
 * an ad (never subtitled ahead). Sites not listed use the MediaSource or source URL as the key.
 *
 * Twitch (MSE in a worker) and Bilibili come later: add them here and, for workers, in tee.ts.
 */

export interface LookaheadSite {
  /** The page's host name (without `www.`) is one of this site's. */
  hosts: readonly string[];
  /** The id of the video the page plays, or null. */
  contentKey(location: Pick<Location, 'pathname' | 'search'>): string | null;
  /** The player around `video` shows an ad now. */
  isAd(video: Element): boolean;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,20}$/;

export const YOUTUBE: LookaheadSite = {
  hosts: ['youtube.com', 'm.youtube.com', 'youtube-nocookie.com'],
  contentKey(location) {
    const v = new URLSearchParams(location.search).get('v');
    const fromPath = /^\/(?:shorts|embed|live)\/([^/?#]+)/.exec(location.pathname)?.[1];
    const id = v ?? fromPath ?? null;
    return id && YOUTUBE_ID.test(id) ? `youtube:${id}` : null;
  },
  isAd(video) {
    return video.closest('.ad-showing, .ad-interrupting') !== null;
  },
};

const SITES: readonly LookaheadSite[] = [YOUTUBE];

export function lookaheadSiteFor(hostname: string): LookaheadSite | null {
  const host = hostname.replace(/^www\./, '');
  return SITES.find((s) => s.hosts.includes(host)) ?? null;
}

/** What a video plays, for lookahead. */
export interface VideoTimeline {
  /** PCM timeline: the MediaSource id, or `p:<url>` for a progressive source. */
  timeline: string;
  /** Cues and finished spans are kept under this. */
  key: string;
  ad: boolean;
}

/**
 * The timeline of `src` (the element's `currentSrc`): a blob URL of a MediaSource the tee saw, or a
 * plain http(s) URL (progressive). Null for anything else (a stream from a camera, a MediaSource
 * made before the tee was in place).
 */
export function videoTimeline(
  src: string,
  mediaSourceOf: (url: string) => string | null,
  site: LookaheadSite | null,
  location: Pick<Location, 'pathname' | 'search'>,
  video: Element,
): VideoTimeline | null {
  let timeline: string | null = null;
  if (src.startsWith('blob:')) timeline = mediaSourceOf(src);
  else if (/^https?:/i.test(src)) timeline = `p:${src}`;
  if (!timeline) return null;
  const ad = site?.isAd(video) ?? false;
  const content = !ad ? (site?.contentKey(location) ?? null) : null;
  return { timeline, key: content ?? timeline, ad };
}

/**
 * Match patterns for a site key (`example.com`: that host and its `www.`), as asked for when
 * lookahead is turned on there and as its page scripts are registered.
 */
export function sitePatterns(site: string): string[] {
  const hosts = site.startsWith('www.') ? [site] : [site, `www.${site}`];
  return hosts.map((h) => `*://${h}/*`);
}
