import { describe, expect, it } from 'vitest';
import {
  clampOffset,
  loadPosition,
  loadPositions,
  savePosition,
  siteKey,
} from '@/settings/positions';

describe('siteKey', () => {
  it('uses the host name without www, for web pages only', () => {
    expect(siteKey('https://www.example.com/watch?v=1')).toBe('example.com');
    expect(siteKey('http://video.example.org:8080/')).toBe('video.example.org');
    expect(siteKey('chrome://extensions')).toBeNull();
    expect(siteKey('not a url')).toBeNull();
  });
});

describe('positions', () => {
  it('keeps the anchor inside the picture', () => {
    expect(clampOffset({ x: -1, y: 2 })).toEqual({ x: 0.1, y: 0.98 });
    expect(clampOffset({ x: Number.NaN, y: 0.5 })).toEqual({ x: 0.5, y: 0.5 });
  });

  it('saves, reads and forgets a position per site', async () => {
    await savePosition('example.com', { x: 0.5, y: 0.6 });
    await savePosition('example.org', { x: 0.3, y: 0.9 });
    expect(await loadPosition('example.com')).toEqual({ x: 0.5, y: 0.6 });
    await savePosition('example.com', null);
    expect(await loadPosition('example.com')).toBeNull();
    expect(Object.keys(await loadPositions())).toEqual(['example.org']);
  });
});
