/**
 * Player chrome to keep subtitles clear of: the control bar and the player's own captions.
 *
 * Every player gets the generic rule (controller.ts): while the pointer moves over the picture,
 * or the video is paused, most players show their controls along the bottom, so subtitles move up
 * by a control bar's height. Players listed here are measured instead: their controls and caption
 * elements are found by selector and avoided exactly. Data only; add a row for a player whose
 * controls the generic rule gets wrong.
 */

export interface PlayerAdapter {
  /** Host names it applies to (and their subdomains). */
  hosts: readonly string[];
  /** The player element, an ancestor of the `<video>`. */
  player: string;
  /** Class on the player while its controls are hidden. */
  controlsHiddenClass?: string;
  /** The control bar, inside the player. */
  controls?: string;
  /** The player's own caption windows, inside the player. */
  captions?: string;
}

export const PLAYER_ADAPTERS: readonly PlayerAdapter[] = [
  {
    hosts: ['youtube.com', 'youtube-nocookie.com'],
    player: '.html5-video-player',
    controlsHiddenClass: 'ytp-autohide',
    controls: '.ytp-chrome-bottom',
    captions: '.caption-window',
  },
];

export function adapterFor(hostname: string): PlayerAdapter | null {
  const host = hostname.toLowerCase();
  return (
    PLAYER_ADAPTERS.find((a) => a.hosts.some((h) => host === h || host.endsWith(`.${h}`))) ?? null
  );
}

/**
 * How far (px) subtitles spanning `subs` (viewport y) must move up to clear `obstacles` below or
 * across them. Obstacles entirely above the subtitles don't count.
 */
export function liftToClear(
  subs: { top: number; bottom: number },
  obstacles: readonly { top: number; bottom: number }[],
  gap: number,
): number {
  let lift = 0;
  for (const o of obstacles) {
    if (o.bottom <= o.top || o.bottom <= subs.top) continue;
    lift = Math.max(lift, subs.bottom - (o.top - gap));
  }
  return Math.max(0, Math.round(lift));
}
