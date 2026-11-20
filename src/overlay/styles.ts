/**
 * The overlay's CSS, inside its shadow root. `:host { all: initial }` keeps page styles out;
 * nothing here leaks into the page. Sizes come from custom properties set from the layout, so text
 * scales with the video:
 *
 * - `--es-font` main line size, `--es-bg` box or shadow opacity, `--es-lift` px to move up (player
 *   controls showing), `--es-x` / `--es-y` the dragged anchor (share of the picture).
 * - `data-bg` on the host: `box` | `shadow` | `outline`.
 *
 * The shadow root can't see the extension pages' tokens (src/styles/tokens.css), so the `--ov-*`
 * values are copied here as `OV`. Subtitle text is white in the system font on a near-black box
 * with the violet cast of the UI's ink; the chrome around it (status chip, language tag, original
 * line) uses the same pastels as the extension pages.
 */

/** The overlay's colours, the `--ov-*` tokens of src/styles/tokens.css. */
export const OV = {
  text: '#ffffff',
  textPartial: 'rgb(255 255 255 / 0.66)',
  original: '#e6e3f0',
  originalPartial: 'rgb(230 227 240 / 0.62)',
  /** RGB channels of the subtitle box; its alpha is the person's setting. */
  box: '12 11 18',
  chromeBg: 'rgb(27 25 38 / 0.84)',
  chromeLine: 'rgb(255 255 255 / 0.14)',
  chromeText: '#f3f1fa',
  tagBg: '#ccc5f8',
  tagText: '#221c4e',
  busy: '#a9d2f5',
  warn: '#f6c89c',
  error: '#f5b5c0',
} as const;

/** Font stack shared with the canvas that measures lines (controller). */
export const FONT_STACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial, ' +
  '"Hiragino Sans", "Noto Sans CJK JP", "Noto Sans CJK SC", "Noto Sans CJK TC", ' +
  '"Apple SD Gothic Neo", "Noto Sans CJK KR", "Microsoft YaHei", "Yu Gothic UI", sans-serif';
export const MAIN_WEIGHT = 500;
/** Original line size, as a share of the main line. */
export const ORIGINAL_SCALE = 0.68;
/** Never draw the original smaller than this. */
export const ORIGINAL_MIN_PX = 12;

export const OVERLAY_CSS = `
:host {
  all: initial;
  position: fixed;
  z-index: 2147483647;
  pointer-events: none;
  display: block;
  contain: layout style;
  --es-ease: cubic-bezier(.2, .7, .2, 1);
  --ov-text: ${OV.text};
  --ov-text-partial: ${OV.textPartial};
  --ov-original: ${OV.original};
  --ov-original-partial: ${OV.originalPartial};
  --ov-box: ${OV.box};
  --ov-chrome-bg: ${OV.chromeBg};
  --ov-chrome-line: ${OV.chromeLine};
  --ov-chrome-text: ${OV.chromeText};
  --ov-tag-bg: ${OV.tagBg};
  --ov-tag-text: ${OV.tagText};
  --ov-busy: ${OV.busy};
  --ov-warn: ${OV.warn};
  --ov-error: ${OV.error};
}
.stack {
  position: absolute;
  left: 4%;
  right: 4%;
  display: flex;
  flex-direction: column;
  align-items: center;
  /* Wider between segments than between a segment's own lines, so pairs read as pairs. */
  gap: 0.55em;
  font-family: ${FONT_STACK};
  font-size: var(--es-font, 24px);
  font-weight: ${MAIN_WEIGHT};
  line-height: 1.28;
  letter-spacing: 0.005em;
  text-align: center;
  font-synthesis: none;
  font-kerning: normal;
  -webkit-font-smoothing: antialiased;
  transform: translate(var(--es-dx, 0px), calc(-1 * var(--es-lift, 0px)));
  transition: transform 220ms var(--es-ease);
}
.stack[data-position="bottom"] { bottom: var(--es-margin, 24px); }
.stack[data-position="top"] { top: var(--es-margin, 24px); }
.stack[data-position="custom"] { bottom: calc((1 - var(--es-y, 0.95)) * 100%); }
.stack.dragging { transition: none; }

.block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.06em;
  max-width: 100%;
  animation: es-in 140ms var(--es-ease);
}
.block.leaving {
  position: absolute;
  left: 0;
  right: 0;
  opacity: 0;
  transition: opacity 160ms ease-in;
}

.line {
  display: block;
  max-width: 100%;
  white-space: pre-line;
  overflow-wrap: anywhere;
  /* Growing text: start-aligned inside a width that only grows (set inline), so words don't
     slide sideways as more arrive. */
}
.line[data-final="false"] { text-align: start; }

.text {
  color: var(--ov-text);
  transition: color 180ms ease;
  pointer-events: auto;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
}
.stack.dragging .text { cursor: grabbing; }
.line[data-final="false"] .text { color: var(--ov-text-partial); }
.line[data-role="original"] {
  font-size: max(${ORIGINAL_MIN_PX}px, ${ORIGINAL_SCALE}em);
  font-weight: 400;
}
.line[data-role="original"] .text { color: var(--ov-original); }
.line[data-role="original"][data-final="false"] .text { color: var(--ov-original-partial); }
.line.revised .text { animation: es-revise 320ms ease-out; }

/* Backgrounds */
:host([data-bg="box"]) .text {
  background: rgb(var(--ov-box) / var(--es-bg, 0.75));
  padding: 0.06em 0.4em 0.08em;
  border-radius: 0.24em;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  text-shadow: 0 0 0.12em rgb(0 0 0 / 0.35);
}
:host([data-bg="shadow"]) .text {
  text-shadow:
    0 0 0.06em rgb(0 0 0 / calc(var(--es-bg, 0.7) + 0.25)),
    0 0.03em 0.06em rgb(0 0 0 / calc(var(--es-bg, 0.7) + 0.2)),
    0 0 0.22em rgb(0 0 0 / var(--es-bg, 0.7)),
    0 0 0.6em rgb(0 0 0 / calc(var(--es-bg, 0.7) * 0.6));
}
:host([data-bg="outline"]) .text {
  text-shadow:
    -0.045em -0.045em 0 #000, 0.045em -0.045em 0 #000,
    -0.045em 0.045em 0 #000, 0.045em 0.045em 0 #000,
    0 0.06em 0 #000, 0 -0.06em 0 #000, 0.06em 0 0 #000, -0.06em 0 0 #000,
    0 0.08em 0.18em rgb(0 0 0 / 0.55);
}

/* Language tag: a solid pastel pill with ink text at the start of the line, so it reads with a
   box, a shadow or an outline behind it, on bright frames too. */
.tag {
  display: inline-block;
  vertical-align: 0.14em;
  margin-inline-end: 0.45em;
  padding: 0.1em 0.42em 0.08em;
  border-radius: 999px;
  font-size: 0.52em;
  font-weight: 600;
  letter-spacing: 0.06em;
  line-height: 1.2;
  color: var(--ov-tag-text);
  background: var(--ov-tag-bg);
  box-shadow: 0 0 0 1px rgb(var(--ov-box) / 0.5);
  text-shadow: none;
}
.line[data-role="original"] .tag { font-size: 0.7em; }

/* Status chip, top-left of the picture: dark glass with a hairline edge, so it holds on bright
   frames, a pastel dot and a pastel progress bar. */
.pill {
  position: absolute;
  top: max(8px, 3%);
  left: max(8px, 2.5%);
  display: flex;
  align-items: center;
  gap: 0.6em;
  max-width: 70%;
  padding: 0.45em 0.9em 0.45em 0.7em;
  border-radius: 999px;
  font: 500 var(--es-pill, 13px)/1.3 ${FONT_STACK};
  color: var(--ov-chrome-text);
  background: var(--ov-chrome-bg);
  box-shadow: inset 0 0 0 1px var(--ov-chrome-line), 0 1px 3px rgb(0 0 0 / 0.3);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  opacity: 0;
  transform: translateY(-4px);
  transition: opacity 200ms ease, transform 200ms var(--es-ease);
}
.pill[data-show="true"] { opacity: 1; transform: none; }
.pill .dot {
  flex: none;
  width: 0.62em;
  height: 0.62em;
  border-radius: 50%;
  background: var(--ov-busy);
}
.pill[data-tone="busy"] .dot { animation: es-pulse 1.2s ease-in-out infinite; }
.pill[data-tone="warn"] .dot { background: var(--ov-warn); }
.pill[data-tone="error"] .dot { background: var(--ov-error); }
.pill .bar {
  flex: none;
  width: 4em;
  height: 0.31em;
  border-radius: 999px;
  background: rgb(255 255 255 / 0.2);
  overflow: hidden;
}
.pill .bar > i {
  display: block;
  height: 100%;
  border-radius: inherit;
  width: calc(var(--es-progress, 0) * 100%);
  background: var(--ov-busy);
  transition: width 200ms linear;
}

/* Screen readers: finished lines only, announced once. */
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@keyframes es-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes es-revise { from { opacity: 0.35; } to { opacity: 1; } }
@keyframes es-pulse { 50% { opacity: 0.35; } }

@media (prefers-reduced-motion: reduce) {
  .stack, .text, .pill, .block.leaving { transition: none; }
  .block, .line.revised .text, .pill .dot { animation: none !important; }
}
`;
