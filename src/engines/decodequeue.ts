/**
 * The order decodes reach a speech model's worker, which runs them one at a time in arrival
 * order. Live and lookahead pipelines share the worker: a live decode (what is being said now)
 * goes before lookahead's (audio that plays later), so live lines never wait behind a stretch of
 * lookahead finals. One decode is with the worker at a time; the rest wait here, live first, each
 * kind in order.
 */
export type DecodePriority = 'live' | 'batch';

export class DecodeQueue {
  private running = false;
  private readonly waiting: Record<DecodePriority, (() => void)[]> = { live: [], batch: [] };

  /** Runs `decode` when the worker is free and no live decode is waiting before it. */
  run<T>(priority: DecodePriority, decode: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.running = true;
        let result: Promise<T>;
        try {
          result = decode();
        } catch (err) {
          result = Promise.reject(err);
        }
        result.then(resolve, reject).finally(() => {
          this.running = false;
          this.next();
        });
      };
      this.waiting[priority].push(start);
      if (!this.running) this.next();
    });
  }

  /** Decodes waiting (not counting the one with the worker). */
  get length(): number {
    return this.waiting.live.length + this.waiting.batch.length;
  }

  private next(): void {
    if (this.running) return;
    const start = this.waiting.live.shift() ?? this.waiting.batch.shift();
    start?.();
  }
}
