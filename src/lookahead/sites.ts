/**
 * What lookahead knows about particular sites: which video a page plays (so cues made for it are
 * found again when it comes back in a new MediaSource, as after an ad), when the player shows an
 * ad (never subtitled ahead), when it plays a live stream (lookahead stays off: there is nothing
 * buffered ahead worth the work, and the live path handles it), and which sites run MSE in a
 * worker (the tee wraps their workers: tee.ts, worker.ts). Sites not listed use the MediaSource
 * or source URL as the key.
 */

export interface LookaheadSite {
  /** The page's host name (without `www.`) is one of this site's. */
  hosts: readonly string[];
  /** The id of the video the page plays, or null. */
  contentKey(location: Pick<Location, 'pathname' | 'search'>): string | null;
  /** The player around `video` shows an ad now. */
  isAd(video: Element): boolean;
  /** The page plays a live stream (besides any video whose duration is infinite). */
  isLive?(location: Pick<Location, 'pathname' | 'search'>): boolean;
  /** The player runs MSE in a dedicated worker: the tee goes into the page's workers. */
  workers?: boolean;
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

const TWITCH_VIDEO = /^\/videos\/(\d{1,20})(?:\/|$)/;

/**
 * Twitch: MSE in a worker (the element plays a `MediaSourceHandle`). VODs (`/videos/<id>`, or the
 * embedded player's `?video=`) are subtitled ahead; channels play live.
 */
export const TWITCH: LookaheadSite = {
  hosts: ['twitch.tv', 'm.twitch.tv', 'player.twitch.tv'],
  contentKey(location) {
    const id =
      TWITCH_VIDEO.exec(location.pathname)?.[1] ??
      /^v?(\d{1,20})$/.exec(new URLSearchParams(location.search).get('video') ?? '')?.[1];
    return id ? `twitch:v${id}` : null;
  },
  isAd(video) {
    const player =
      video.closest('.video-player, [data-a-target="video-player"]') ?? video.ownerDocument;
    return (
      player.querySelector(
        '[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"], [data-test-selector="ad-banner-default-text"]',
      ) !== null
    );
  },
  isLive(location) {
    return this.contentKey(location) === null && !/^\/[^/]+\/clip\//.test(location.pathname);
  },
  workers: true,
};

/** Bilibili: DASH (AAC in fMP4) on the main thread. A video's parts (`?p=`) are separate. */
export const BILIBILI: LookaheadSite = {
  hosts: ['bilibili.com', 'm.bilibili.com'],
  contentKey(location) {
    const video = /^\/video\/(BV[0-9A-Za-z]{10}|av\d{1,20})(?:\/|$)/i.exec(location.pathname)?.[1];
    if (video) {
      const part = Number(new URLSearchParams(location.search).get('p') ?? '1');
      return `bilibili:${video}:p${Number.isInteger(part) && part > 0 ? part : 1}`;
    }
    const episode = /^\/bangumi\/play\/((?:ep|ss)\d{1,20})(?:\/|$)/.exec(location.pathname)?.[1];
    return episode ? `bilibili:${episode}` : null;
  },
  isAd() {
    return false;
  },
};

const SITES: readonly LookaheadSite[] = [YOUTUBE, TWITCH, BILIBILI];

export function lookaheadSiteFor(hostname: string): LookaheadSite | null {
  const host = hostname.replace(/^www\./, '');
  return SITES.find((s) => s.hosts.includes(host)) ?? null;
}

/**
 * Whether the tee goes into the page's workers here: only on sites whose player needs it (a
 * worker started from a blob changes its `location`, and a page's CSP may not allow blob
 * workers). E2e builds also let a fixture page ask for it (`?murmur-worker-tee`).
 */
export function workerTeeHost(hostname: string, search = ''): boolean {
  if (lookaheadSiteFor(hostname)?.workers) return true;
  return import.meta.env.MODE === 'e2e' && new URLSearchParams(search).has('murmur-worker-tee');
}

/** What a video plays, for lookahead. */
export interface VideoTimeline {
  /** PCM timeline: the MediaSource id, or `p:<url>` for a progressive source. */
  timeline: string;
  /** Cues and finished spans are kept under this. */
  key: string;
  ad: boolean;
}

/** How the element's MediaSource is found (the relay's maps). */
export interface MediaSourceLookup {
  /** By the blob URL it plays. */
  byUrl(url: string): string | null;
  /** By buffered ranges, for a `MediaSourceHandle` (MSE in a worker). */
  byBuffered(buffered: readonly (readonly [number, number])[], time: number): string | null;
}

/** The parts of a media element `videoTimeline` reads. */
export interface TimelineVideo extends Element {
  currentSrc: string;
  src: string;
  srcObject: unknown;
  duration: number;
  currentTime: number;
  buffered: TimeRanges;
}

/**
 * The timeline of a media element: a blob URL of a MediaSource the tee saw, a MediaSource in a
 * worker the tee saw (`srcObject` a `MediaSourceHandle`), or a plain http(s) URL (progressive).
 * Null for anything else (a camera stream, a MediaSource made before the tee was in place) and for
 * a live stream (infinite duration, or the site says so).
 */
export function videoTimeline(
  video: TimelineVideo,
  lookup: MediaSourceLookup,
  site: LookaheadSite | null,
  location: Pick<Location, 'pathname' | 'search'>,
): VideoTimeline | null {
  if (video.duration === Number.POSITIVE_INFINITY || site?.isLive?.(location)) return null;
  const src = video.currentSrc || video.src;
  let timeline: string | null = null;
  if (src.startsWith('blob:')) timeline = lookup.byUrl(src);
  else if (/^https?:/i.test(src)) timeline = `p:${src}`;
  else if (!src && isHandle(video.srcObject)) {
    const ranges: [number, number][] = [];
    const b = video.buffered;
    for (let i = 0; i < b.length; i++) ranges.push([b.start(i), b.end(i)]);
    timeline = lookup.byBuffered(ranges, video.currentTime);
  }
  if (!timeline) return null;
  const ad = site?.isAd(video) ?? false;
  const content = !ad ? (site?.contentKey(location) ?? null) : null;
  return { timeline, key: content ?? timeline, ad };
}

/** A `MediaSourceHandle` (not a camera's `MediaStream`, nor a `Blob`). */
function isHandle(object: unknown): boolean {
  if (typeof object !== 'object' || object === null) return false;
  const name = (object as { constructor?: { name?: string } }).constructor?.name;
  return name === 'MediaSourceHandle';
}

/**
 * Match patterns for a site key (`example.com`: that host and its `www.`), as asked for when
 * lookahead is turned on there and as its page scripts are registered.
 */
export function sitePatterns(site: string): string[] {
  const hosts = site.startsWith('www.') ? [site] : [site, `www.${site}`];
  return hosts.map((h) => `*://${h}/*`);
}
