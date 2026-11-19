/**
 * The overlay's DOM: one `<earshot-overlay>` host with a closed shadow root (open in e2e builds so
 * Playwright can read it), positioned `fixed` over the visible picture. Pointer events pass
 * through to the player.
 *
 * Fullscreen: the top layer hides everything outside the fullscreen element, so the host moves
 * into the fullscreen element when that's a container; when the `<video>` itself is fullscreen
 * (it can't have children) the host becomes a manual popover, which enters the top layer above it.
 */
import { IS_E2E } from '@/shared/e2e';
import type { CaptionBlock } from './captions';
import type { CaptionLayout } from './geometry';
import { OVERLAY_CSS } from './styles';

export const OVERLAY_TAG = 'earshot-overlay';

export interface ViewStyle {
  position: 'bottom' | 'top';
  backgroundOpacity: number;
}

export class OverlayView {
  readonly host: HTMLElement;
  private readonly stack: HTMLDivElement;
  private popover = false;

  constructor(private readonly doc: Document) {
    this.host = doc.createElement(OVERLAY_TAG);
    const root = this.host.attachShadow({ mode: IS_E2E ? 'open' : 'closed' });
    const style = doc.createElement('style');
    style.textContent = OVERLAY_CSS;
    this.stack = doc.createElement('div');
    this.stack.className = 'stack';
    this.stack.setAttribute('part', 'stack');
    root.append(style, this.stack);
    this.host.setAttribute('aria-live', 'polite');
    this.hide();
  }

  /** Puts the host under `parent` (the document, or the fullscreen element). */
  mount(parent: Element): void {
    if (this.host.parentElement !== parent) parent.append(this.host);
  }

  unmount(): void {
    this.setPopover(false);
    this.host.remove();
  }

  /** Top-layer mode, for a fullscreen `<video>`. Re-shown each time so it stacks above it. */
  setPopover(on: boolean): void {
    const h = this.host as HTMLElement & { showPopover?(): void; hidePopover?(): void };
    if (on) {
      if (!h.showPopover) return;
      this.host.setAttribute('popover', 'manual');
      if (this.popover) h.hidePopover?.();
      h.showPopover();
      this.popover = true;
    } else if (this.popover) {
      h.hidePopover?.();
      this.host.removeAttribute('popover');
      this.popover = false;
    }
  }

  layout(layout: CaptionLayout | null, style: ViewStyle): void {
    if (!layout) {
      this.hide();
      return;
    }
    const { box } = layout;
    const s = this.host.style;
    // `important` so page rules like `* { position: static !important }` can't move us, and so
    // popover UA styles (inset, margin, border, background) don't apply.
    const set = (k: string, v: string) => s.setProperty(k, v, 'important');
    set('display', 'block');
    set('position', 'fixed');
    set('left', `${box.left}px`);
    set('top', `${box.top}px`);
    set('width', `${box.width}px`);
    set('height', `${box.height}px`);
    set('right', 'auto');
    set('bottom', 'auto');
    set('margin', '0');
    set('padding', '0');
    set('border', '0');
    set('background', 'transparent');
    set('overflow', 'visible');
    set('--es-font', `${layout.fontPx}px`);
    set('--es-margin', `${layout.marginPx}px`);
    set('--es-bg', String(style.backgroundOpacity));
    this.stack.dataset.position = style.position;
  }

  render(blocks: readonly CaptionBlock[]): void {
    const doc = this.doc;
    const children = blocks.map((block) => {
      const el = doc.createElement('div');
      el.className = 'block';
      el.dataset.id = block.id;
      for (const line of block.lines) {
        const span = doc.createElement('span');
        span.className = 'line';
        span.dataset.role = line.role;
        span.dataset.final = String(line.final);
        span.lang = line.lang;
        span.textContent = line.text;
        el.append(span);
      }
      return el;
    });
    this.stack.replaceChildren(...children);
  }

  private hide(): void {
    this.host.style.setProperty('display', 'none', 'important');
  }
}
