import { describe, expect, it } from 'vitest';
import { topSiteKey } from '@/overlay';
import { canHoldOverlay } from '@/overlay/controller';

const video = { localName: 'video' };
const el = (localName: string, patch: { shadowRoot?: unknown; holds?: boolean } = {}) => ({
  localName,
  shadowRoot: patch.shadowRoot ?? null,
  contains: (other: unknown) => other === video && (patch.holds ?? true),
});

describe('canHoldOverlay (where the overlay goes in fullscreen)', () => {
  it('goes inside a plain container of the video', () => {
    expect(canHoldOverlay(el('div'), video)).toBe(true);
    // No video in this frame (a top frame showing subtitles at the bottom): any container.
    expect(canHoldOverlay(el('div', { holds: false }), null)).toBe(true);
  });

  it('goes to the top layer for elements whose children are not drawn', () => {
    for (const name of ['iframe', 'video', 'canvas', 'object', 'embed']) {
      expect(canHoldOverlay(el(name), video)).toBe(false);
    }
    // A web component: its shadow root decides what is drawn.
    expect(canHoldOverlay(el('shadow-player', { shadowRoot: {} }), video)).toBe(false);
    // A container that doesn't hold the video (it is in a shadow root, or elsewhere).
    expect(canHoldOverlay(el('div', { holds: false }), video)).toBe(false);
  });
});

describe('topSiteKey (dragged positions are per tab site)', () => {
  const origins = (list: string[]) =>
    Object.assign([...list], { item: (i: number) => list[i] ?? null, contains: () => false });

  it('uses the tab’s site in a frame from another site', () => {
    expect(
      topSiteKey({
        href: 'https://player.example.net/embed/1',
        ancestorOrigins: origins(['https://media.example.org', 'https://www.example.com']),
      }),
    ).toBe('example.com');
  });

  it('uses its own site in the top frame', () => {
    expect(
      topSiteKey({ href: 'https://www.example.com/watch', ancestorOrigins: origins([]) }),
    ).toBe('example.com');
    expect(topSiteKey({ href: 'https://example.com/a' })).toBe('example.com');
  });
});
