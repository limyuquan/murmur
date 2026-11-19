/** A set of half-open intervals `[start, end)` on one number line, kept sorted and merged. */
import type { Span } from './types';

export class SpanSet {
  private spans: [number, number][] = [];

  /** `gap`: spans closer than this are joined. */
  constructor(private readonly gap = 0) {}

  get list(): readonly Span[] {
    return this.spans;
  }

  get isEmpty(): boolean {
    return this.spans.length === 0;
  }

  clear(): void {
    this.spans = [];
  }

  add(start: number, end: number): void {
    if (!(end > start)) return;
    const out: [number, number][] = [];
    let s = start;
    let e = end;
    let placed = false;
    for (const span of this.spans) {
      if (span[1] + this.gap < s) out.push(span);
      else if (span[0] - this.gap > e) {
        if (!placed) {
          out.push([s, e]);
          placed = true;
        }
        out.push(span);
      } else {
        s = Math.min(s, span[0]);
        e = Math.max(e, span[1]);
      }
    }
    if (!placed) out.push([s, e]);
    this.spans = out;
  }

  subtract(start: number, end: number): void {
    if (!(end > start)) return;
    const out: [number, number][] = [];
    for (const [s, e] of this.spans) {
      if (e <= start || s >= end) {
        out.push([s, e]);
        continue;
      }
      if (s < start) out.push([s, start]);
      if (e > end) out.push([end, e]);
    }
    this.spans = out;
  }

  /** The span holding `t` (within `slack` of its ends), or null. */
  at(t: number, slack = 0): Span | null {
    for (const span of this.spans) {
      if (span[0] - slack <= t && t < span[1] + slack) return span;
      if (span[0] - slack > t) break;
    }
    return null;
  }

  /** The first span that ends after `t` (holding it, or after it), or null. */
  from(t: number): Span | null {
    for (const span of this.spans) if (span[1] > t) return span;
    return null;
  }

  /** How much of `[start, end)` the set covers. */
  overlap(start: number, end: number): number {
    let n = 0;
    for (const [s, e] of this.spans) {
      if (s >= end) break;
      n += Math.max(0, Math.min(e, end) - Math.max(s, start));
    }
    return n;
  }
}
