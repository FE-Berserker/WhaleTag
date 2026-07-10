import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Semaphore, mapWithConcurrency } from './concurrency';

/** Tiny async sleep so concurrent tasks overlap and `peak` is observable. */
const tick = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('Semaphore', () => {
  it('runs at most `limit` tasks concurrently', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      active += 1;
      peak = Math.max(peak, active);
      await tick(10);
      active -= 1;
    };
    await Promise.all(Array.from({ length: 12 }, () => sem.run(task)));
    assert.equal(peak, 2, 'never exceeded the limit, and reached it');
    assert.equal(active, 0, 'released every permit');
  });

  it('caps at 1 (serialization)', async () => {
    const sem = new Semaphore(1);
    let active = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      active += 1;
      peak = Math.max(peak, active);
      await tick(5);
      active -= 1;
    };
    await Promise.all(Array.from({ length: 6 }, () => sem.run(task)));
    assert.equal(peak, 1, 'ran strictly one at a time');
  });

  it('releases the permit even when the task throws', async () => {
    const sem = new Semaphore(1);
    await assert.rejects(
      sem.run(async () => {
        throw new Error('boom');
      }),
      /boom/
    );
    // If the failed run leaked the permit, this would hang until the test
    // times out — so reaching the assertion proves release-on-throw.
    let ran = false;
    await sem.run(async () => {
      ran = true;
    });
    assert.equal(ran, true);
  });

  it('processes waiters in FIFO order', async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];
    // Hold the only permit until we release it.
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const holder = sem.run(async () => {
      await gate;
    });
    const queued = ['a', 'b', 'c'].map((id) =>
      sem.run(async () => {
        order.push(id);
        await tick(2);
      })
    );
    await tick(5); // let a/b/c queue up behind the holder
    openGate();
    await Promise.all([holder, ...queued]);
    assert.deepEqual(order, ['a', 'b', 'c']);
  });
});

describe('mapWithConcurrency', () => {
  it('respects the limit and preserves input order', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await tick(5);
      active -= 1;
      return n * 10;
    });
    assert.deepEqual(out, [10, 20, 30, 40, 50]);
    assert.ok(peak <= 2, 'never exceeded the limit');
  });
});
