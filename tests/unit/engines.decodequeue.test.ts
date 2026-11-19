import { describe, expect, it } from 'vitest';
import { DecodeQueue } from '@/engines/decodequeue';

describe('DecodeQueue', () => {
  it('sends one decode at a time, live ones before lookahead’s, each kind in order', async () => {
    const q = new DecodeQueue();
    const started: string[] = [];
    const finishers = new Map<string, () => void>();
    const decode = (name: string) => () => {
      started.push(name);
      return new Promise<string>((resolve) => finishers.set(name, () => resolve(name)));
    };
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const results = [
      q.run('batch', decode('b1')),
      q.run('batch', decode('b2')),
      q.run('batch', decode('b3')),
      q.run('live', decode('l1')),
      q.run('live', decode('l2')),
    ];
    expect(started).toEqual(['b1']);
    expect(q.length).toBe(4);
    for (const name of ['b1', 'l1', 'l2', 'b2', 'b3']) {
      finishers.get(name)?.();
      await tick();
    }
    expect(started).toEqual(['b1', 'l1', 'l2', 'b2', 'b3']);
    expect(await Promise.all(results)).toEqual(['b1', 'b2', 'b3', 'l1', 'l2']);
  });

  it('goes on after a failed decode', async () => {
    const q = new DecodeQueue();
    const failed = q.run('live', () => Promise.reject(new Error('boom')));
    const next = q.run('live', async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    expect(await next).toBe('ok');
    const thrown = q.run('batch', () => {
      throw new Error('sync');
    });
    await expect(thrown).rejects.toThrow('sync');
    expect(await q.run('batch', async () => 1)).toBe(1);
  });
});
