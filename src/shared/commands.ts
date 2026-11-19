/** Keyboard shortcut names (manifest `commands`, wxt.config.ts). */
export const COMMANDS = {
  /** Opens the popup. */
  popup: '_execute_action',
  /** Subtitles on or off for the current tab. */
  toggle: 'toggle-subtitles',
  /** Show or hide the original line. */
  original: 'toggle-original',
} as const;
