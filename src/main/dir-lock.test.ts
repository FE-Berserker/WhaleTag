import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { withLock } from './dir-lock';

/**
 * Per-key async mutex correctness. The sidecar store relies on `withLock` to
 * serialize read-modify-write on a single directory's `wsd.json`; a regression
 * here means lost updates (same-key overlap) or a poisoned queue (one failing
 * write stalling every later write). These pin the documented invariants.
 */
describe('withLock — per-key async mutex', () => {
  it('serializes tasks queued on the same key (no overlap)', async () => {
    // Same-key tasks must run one at a time. Track the high-water mark of
    // concurrent executions — it must stay at 1.
    let active = 0;
    let maxActive = 0;
    const task = (label: string) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((r) => setTimeout(r, 5));
      active -= 1;
      return label;
    };
    const results = await Promise.all([
      withLock('same', task('a')),
      withLock('same', task('b')),
      withLock('same', task('c')),
    ]);
    assert.equal(maxActive, 1, 'same-key tasks overlapped');
    assert.deepEqual(results, ['a', 'b', 'c']);
  });

  it('runs different keys in parallel', async () => {
    // Different-key tasks are independent and must be able to overlap (this
    // is the whole point of per-key locking vs. a single global lock).
    let active = 0;
    let maxActive = 0;
    const task = () => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((r) => setTimeout(r, 10));
      active -= 1;
    };
    await Promise.all([
      withLock('dirA', task()),
      withLock('dirB', task()),
      withLock('dirC', task()),
    ]);
    assert.ok(maxActive >= 2, `different keys ran serially (maxActive=${maxActive})`);
  });

  it('a rejected task does NOT poison the queue for later tasks', async () => {
    // Core invariant: the chain itself never rejects. A failing task surfaces
    // its error to its OWN caller, but tasks queued after it still run and
    // return their own result. Without this, one bad write would leave every
    // later write pending forever.
    const boom = () => Promise.reject(new Error('boom'));
    const ok = () => Promise.resolve('survived');

    await assert.rejects(withLock('queue', boom), /boom/);
    const r = await withLock('queue', ok);
    assert.equal(r, 'survived');
  });

  it('returns the task value and propagates the task rejection', async () => {
    assert.equal(await withLock('value', () => Promise.resolve(42)), 42);
    await assert.rejects(
      withLock('value', () => Promise.reject(new Error('nope'))),
      /nope/
    );
  });

  it('chains a long sequence without losing order', async () => {
    // Many same-key tasks queued near-simultaneously must all run, in order.
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        withLock('seq', async () => {
          order.push(i);
          await new Promise<void>((r) => setTimeout(r, 0));
        })
      )
    );
    assert.deepEqual(order, Array.from({ length: 50 }, (_, i) => i));
  });

  it('works after a chain has fully drained', async () => {
    // Once every task for a key has settled, its entry is dropped; a later
    // withLock must still work (it chains off Promise.resolve()).
    await withLock('drain', () => Promise.resolve('first'));
    // Yield so the tail's cleanup microtask runs before the next lock.
    await new Promise<void>((r) => setTimeout(r, 0));
    assert.equal(await withLock('drain', () => Promise.resolve('second')), 'second');
  });
});
