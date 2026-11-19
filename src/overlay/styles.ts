/**
 * The overlay's CSS, inside its shadow root. `:host { all: initial }` keeps page styles out;
 * nothing here leaks into the page. Sizes come from `--es-font` (set from the layout) so text
 * scales with the video.
 */
export const OVERLAY_CSS = `
:host {
  all: initial;
  position: fixed;
  z-index: 2147483647;
  pointer-events: none;
  display: block;
  contain: layout style;
}
.stack {
  position: absolute;
  left: 5%;
  right: 5%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.3em;
  font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans", "Noto Sans CJK JP",
    "Noto Sans CJK KR", "Noto Sans CJK SC", "Apple SD Gothic Neo", "Hiragino Sans",
    "Microsoft YaHei", sans-serif;
  font-size: var(--es-font, 24px);
  line-height: 1.3;
  text-align: center;
}
.stack[data-position="bottom"] { bottom: var(--es-margin, 24px); }
.stack[data-position="top"] { top: var(--es-margin, 24px); }
.block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.1em;
  max-width: 100%;
}
.line {
  display: inline;
  color: #fff;
  background: rgb(0 0 0 / var(--es-bg, 0.75));
  padding: 0.08em 0.4em;
  border-radius: 0.15em;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  text-wrap: balance;
  overflow-wrap: anywhere;
  text-shadow: 0 0 2px rgb(0 0 0 / 0.6);
  white-space: pre-line;
}
.line[data-role="original"] { font-size: 0.7em; color: #e6e6e6; }
.line[data-final="false"] { opacity: 0.6; }
`;
