/**
 * The overlay's DOM: one `<earshot-overlay>` host with a closed shadow root (open in e2e builds so
 * Playwright can read it), positioned over the visible picture. Pointer events pass through to the
 * player, except on the subtitle text itself, which can be dragged.
 *
 * Rendering is keyed (block by cue id, line by role) and only touches what changed, so a growing
 * line is the same element from first word to last. Blocks that move (a new block rolls the older
 * one up, a line gains a row) glide to their new place; blocks that leave fade out where they were.
 *
 * Fullscreen: the top layer hides everything outside the fullscreen element, so the host moves
 * into the fullscreen element when that's a container; when the `<video>` itself is fullscreen
 * (it can't have children) the host becomes a manual popover, which enters the top layer above it.
 *
 * `contained` mode (the options page preview) positions the host `absolute` inside its parent.
 */
import { IS_E2E } from '@/shared/e2e';
import type { CaptionBlock, CaptionLine } from './captions';
import type { CaptionLayout } from './geometry';
import { OVERLAY_CSS } from './styles';

export const OVERLAY_TAG = 'earshot-overlay';

export interface ViewStyle {
  /** `custom`: anchored at the dragged position (`anchorY`). */
  position: 'bottom' | 'top' | 'custom';
  background: 'box' | 'shadow' | 'outline';
  backgroundOpacity: number;
  /** Bottom edge of the subtitles as a share of the picture height (`custom` only). */
  anchorY: number;
  /** Horizontal shift of the subtitles from the centre, px. */
  shiftX: number;
  /** Px to move up while the player's controls or captions are showing. */
  lift: number;
}

export interface StatusChip {
  tone: 'busy' | 'warn' | 'error' | 'info';
  text: string;
  /** 0–1 shows a progress bar. */
  progress?: number | null;
}

export interface DragHandlers {
  start(e: PointerEvent): void;
  move(e: PointerEvent): void;
  end(e: PointerEvent): void;
  reset(): void;
}

/** Widest row a line may take, px, by role: growing lines reserve width in steps of it. */
export interface RowWidths {
  main: number;
  original: number;
}

const RATCHET_STEPS = 6;
const SR_KEEP = 3;

export class OverlayView {
  readonly host: HTMLElement;
  private readonly stack: HTMLDivElement;
  private readonly pill: HTMLDivElement;
  private readonly pillText: HTMLSpanElement;
  private readonly pillBar: HTMLSpanElement;
  private readonly sr: HTMLDivElement;
  private readonly announced = new Set<string>();
  private popover = false;
  private drag: DragHandlers | null = null;

  constructor(
    private readonly doc: Document,
    private readonly options: { contained?: boolean } = {},
  ) {
    this.host = doc.createElement(OVERLAY_TAG);
    const root = this.host.attachShadow({ mode: IS_E2E ? 'open' : 'closed' });
    const style = doc.createElement('style');
    style.textContent = OVERLAY_CSS;
    this.stack = doc.createElement('div');
    this.stack.className = 'stack';
    this.stack.setAttribute('part', 'stack');
    this.stack.setAttribute('aria-hidden', 'true');

    this.pill = doc.createElement('div');
    this.pill.className = 'pill';
    this.pill.setAttribute('role', 'status');
    const dot = doc.createElement('span');
    dot.className = 'dot';
    this.pillText = doc.createElement('span');
    this.pillBar = doc.createElement('span');
    this.pillBar.className = 'bar';
    this.pillBar.append(doc.createElement('i'));
    this.pill.append(dot, this.pillText, this.pillBar);

    this.sr = doc.createElement('div');
    this.sr.className = 'sr';
    this.sr.setAttribute('aria-live', 'polite');
    this.sr.setAttribute('aria-atomic', 'false');

    root.append(style, this.stack, this.pill, this.sr);
    this.host.dataset.bg = 'box';
    this.hide();
    this.status(null);
    this.listen();
  }

  /** Puts the host under `parent` (the document, the fullscreen element, or a preview box). */
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

  setDragHandlers(handlers: DragHandlers | null): void {
    this.drag = handlers;
  }

  setDragging(on: boolean): void {
    this.stack.classList.toggle('dragging', on);
  }

  /**
   * The subtitles' box in viewport coordinates without the lift and shift (even mid-transition),
   * or null when nothing is shown.
   */
  stackRect(): { top: number; bottom: number; left: number; right: number } | null {
    if (this.stack.childElementCount === 0) return null;
    const r = this.stack.getBoundingClientRect();
    const t = this.doc.defaultView?.getComputedStyle(this.stack).transform;
    const m = t && t !== 'none' ? new DOMMatrixReadOnly(t) : null;
    const dx = m?.e ?? 0;
    const dy = m?.f ?? 0;
    return { top: r.top - dy, bottom: r.bottom - dy, left: r.left - dx, right: r.right - dx };
  }

  /** Width of the widest block on screen, px. */
  contentWidth(): number {
    let width = 0;
    for (const block of this.stack.querySelectorAll('.block:not(.leaving)')) {
      width = Math.max(width, block.getBoundingClientRect().width);
    }
    return width;
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
    set('position', this.options.contained ? 'absolute' : 'fixed');
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
    set('--es-pill', `${Math.round(Math.min(15, Math.max(11, layout.fontPx * 0.5)))}px`);
    set('--es-bg', String(style.backgroundOpacity));
    set('--es-y', String(style.anchorY));
    set('--es-dx', `${Math.round(style.shiftX)}px`);
    set('--es-lift', `${Math.round(style.lift)}px`);
    this.host.dataset.bg = style.background;
    this.stack.dataset.position = style.position;
  }

  render(blocks: readonly CaptionBlock[], widths: RowWidths): void {
    const before = this.lineTops();
    const current = new Map<string, HTMLElement>();
    for (const el of this.stack.children) {
      const b = el as HTMLElement;
      if (!b.classList.contains('leaving') && b.dataset.id) current.set(b.dataset.id, b);
    }

    let cursor: Element | null = this.stack.firstElementChild;
    for (const block of blocks) {
      let el = current.get(block.id);
      current.delete(block.id);
      if (!el) {
        el = this.doc.createElement('div');
        el.className = 'block';
        el.dataset.id = block.id;
      }
      this.renderLines(el, block, widths);
      // Skip blocks that are on their way out.
      while (cursor && (cursor as HTMLElement).classList.contains('leaving')) {
        cursor = cursor.nextElementSibling;
      }
      if (cursor !== el) this.stack.insertBefore(el, cursor);
      cursor = el.nextElementSibling;
      this.announce(block);
    }
    for (const el of current.values()) this.leave(el);
    this.glide(before);
  }

  status(chip: StatusChip | null): void {
    this.pill.dataset.show = String(chip !== null);
    if (!chip) return;
    this.pill.dataset.tone = chip.tone;
    if (this.pillText.textContent !== chip.text) this.pillText.textContent = chip.text;
    const hasBar = chip.progress !== undefined && chip.progress !== null;
    this.pillBar.style.display = hasBar ? '' : 'none';
    if (hasBar) this.pill.style.setProperty('--es-progress', String(chip.progress));
  }

  // -------------------------------------------------------------------------------------------

  private renderLines(el: HTMLElement, block: CaptionBlock, widths: RowWidths): void {
    const existing = new Map<string, HTMLElement>();
    for (const child of el.children) {
      existing.set((child as HTMLElement).dataset.role ?? '', child as HTMLElement);
    }
    let cursor: Element | null = el.firstElementChild;
    for (const line of block.lines) {
      let lineEl = existing.get(line.role);
      existing.delete(line.role);
      if (!lineEl) lineEl = this.createLine(line);
      this.updateLine(lineEl, line, widths[line.role]);
      if (cursor !== lineEl) el.insertBefore(lineEl, cursor);
      cursor = lineEl.nextElementSibling;
    }
    for (const stale of existing.values()) stale.remove();
  }

  private createLine(line: CaptionLine): HTMLElement {
    const el = this.doc.createElement('div');
    el.className = 'line';
    el.dataset.role = line.role;
    el.dataset.rev = String(line.revision);
    const text = this.doc.createElement('span');
    text.className = 'text';
    text.append(this.doc.createTextNode(''));
    el.append(text);
    return el;
  }

  private updateLine(el: HTMLElement, line: CaptionLine, maxRowPx: number): void {
    const text = el.firstElementChild as HTMLSpanElement;
    const final = String(line.final);
    if (el.dataset.final !== final) el.dataset.final = final;
    if (text.lang !== line.lang) text.lang = line.lang;

    // Language tag at the start of the line.
    let tag = text.querySelector<HTMLElement>('.tag');
    if (line.tag) {
      if (!tag) {
        tag = this.doc.createElement('span');
        tag.className = 'tag';
        text.prepend(tag);
      }
      const label = line.tag.split('-')[0]?.toUpperCase() ?? line.tag;
      if (tag.textContent !== label) tag.textContent = label;
    } else {
      tag?.remove();
    }
    const node = text.lastChild as Text;
    const rows = line.rows.join('\n');
    if (node.data !== rows) node.data = rows;

    // A revision of finished text: a brief fade so the change is noticed.
    const rev = String(line.revision);
    if (el.dataset.rev !== rev) {
      el.dataset.rev = rev;
      el.classList.remove('revised');
      void el.offsetWidth;
      el.classList.add('revised');
    }

    // Growing text reserves width in steps, so its start doesn't slide with every word.
    if (!line.final && maxRowPx > 0) {
      const step = maxRowPx / RATCHET_STEPS;
      const width = text.getBoundingClientRect().width;
      const reserved = Math.min(maxRowPx, Math.ceil(width / step) * step);
      const previous = Number(el.dataset.reserve ?? 0);
      if (reserved > previous) {
        el.dataset.reserve = String(reserved);
        el.style.minWidth = `${reserved}px`;
      }
    } else if (el.dataset.reserve) {
      delete el.dataset.reserve;
      el.style.minWidth = '';
    }
  }

  /** Each line's top before a change, to animate the move. */
  private lineTops(): Map<Element, number> {
    const tops = new Map<Element, number>();
    if (this.reducedMotion()) return tops;
    for (const line of this.stack.querySelectorAll('.block:not(.leaving) > .line')) {
      tops.set(line, line.getBoundingClientRect().top);
    }
    return tops;
  }

  /** FLIP: lines that moved start where they were and glide to their new place. */
  private glide(before: Map<Element, number>): void {
    const moved: HTMLElement[] = [];
    for (const [line, top] of before) {
      if (!line.isConnected) continue;
      const delta = top - line.getBoundingClientRect().top;
      if (Math.abs(delta) < 0.5) continue;
      const el = line as HTMLElement;
      el.style.transition = 'none';
      el.style.transform = `translateY(${delta}px)`;
      moved.push(el);
    }
    if (moved.length === 0) return;
    void this.stack.offsetHeight;
    for (const el of moved) {
      el.style.transition = 'transform 200ms cubic-bezier(.2, .7, .2, 1)';
      el.style.transform = '';
    }
  }

  private leave(el: HTMLElement): void {
    if (this.reducedMotion() || !el.isConnected) {
      el.remove();
      return;
    }
    el.style.top = `${el.offsetTop}px`;
    el.classList.add('leaving');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    // In case the transition never runs (hidden, detached).
    setTimeout(() => el.remove(), 400);
  }

  /** Finished main lines go to the screen-reader region once each. */
  private announce(block: CaptionBlock): void {
    for (const line of block.lines) {
      if (line.role !== 'main' || !line.final) continue;
      const text = line.rows.join(' ');
      const key = `${block.id}\u0000${line.revision}\u0000${text}`;
      if (this.announced.has(key)) continue;
      this.announced.add(key);
      if (this.announced.size > 64)
        this.announced.delete(this.announced.values().next().value as string);
      const p = this.doc.createElement('p');
      p.textContent = text;
      p.lang = line.lang;
      this.sr.append(p);
      while (this.sr.childElementCount > SR_KEEP) this.sr.firstElementChild?.remove();
    }
  }

  private listen(): void {
    const isText = (e: Event) => (e.target as Element | null)?.closest?.('.text') != null;
    // Keep presses on the subtitles from reaching the player (no pause on a drag).
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerup', 'touchstart'] as const) {
      this.stack.addEventListener(type, (e) => {
        if (isText(e)) e.stopPropagation();
      });
    }
    this.stack.addEventListener('pointerdown', (e) => {
      if (!isText(e) || e.button !== 0 || !this.drag) return;
      e.stopPropagation();
      e.preventDefault();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      this.drag.start(e);
    });
    this.stack.addEventListener('pointermove', (e) => this.drag?.move(e));
    this.stack.addEventListener('pointerup', (e) => this.drag?.end(e));
    this.stack.addEventListener('lostpointercapture', (e) => this.drag?.end(e));
    this.stack.addEventListener('dblclick', (e) => {
      if (!isText(e)) return;
      e.stopPropagation();
      this.drag?.reset();
    });
  }

  private reducedMotion(): boolean {
    return this.doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }

  private hide(): void {
    this.host.style.setProperty('display', 'none', 'important');
  }
}
