import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cancelThumbLoad, enqueueThumbLoad } from './thumb-load-queue';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every queued microtask (settle → re-pump → next task) run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('thumb-load-queue', () => {
  it('caps concurrent loads at four and keeps FIFO order', async () => {
    const started: string[] = [];
    const pending: Deferred[] = [];
    for (let i = 0; i < 6; i += 1) {
      const task = deferred();
      pending.push(task);
      enqueueThumbLoad(`k${i}`, () => {
        started.push(`k${i}`);
        return task.promise;
      });
    }

    assert.deepEqual(started, ['k0', 'k1', 'k2', 'k3']);

    pending[0].resolve();
    await flush();
    assert.deepEqual(started, ['k0', 'k1', 'k2', 'k3', 'k4']);

    for (const task of pending.slice(1)) task.resolve();
    await flush();
    assert.deepEqual(started, ['k0', 'k1', 'k2', 'k3', 'k4', 'k5']);
  });

  it('keeps only the newest pending task for a key', async () => {
    const started: string[] = [];
    const running = [deferred(), deferred(), deferred(), deferred()];
    running.forEach((task, index) =>
      enqueueThumbLoad(`run${index}`, () => {
        started.push(`run${index}`);
        return task.promise;
      })
    );

    const first = deferred();
    const second = deferred();
    enqueueThumbLoad('dup', () => {
      started.push('dup-first');
      return first.promise;
    });
    enqueueThumbLoad('dup', () => {
      started.push('dup-second');
      return second.promise;
    });

    running[0].resolve();
    await flush();
    assert.deepEqual(started.slice(4), ['dup-second']);

    second.resolve();
    running[1].resolve();
    running[2].resolve();
    running[3].resolve();
    await flush();
  });

  it('re-runs a key re-enqueued while its load is in flight (after it settles)', async () => {
    const order: string[] = [];
    const first = deferred();
    enqueueThumbLoad('a', () => {
      order.push('first-start');
      return first.promise;
    });

    const second = deferred();
    enqueueThumbLoad('a', () => {
      order.push('second-start');
      return second.promise;
    });
    // Never two IPC loads for the same key concurrently.
    assert.deepEqual(order, ['first-start']);

    first.resolve();
    await flush();
    assert.deepEqual(order, ['first-start', 'second-start']);

    second.resolve();
    await flush();
  });

  it('logs a failed task and keeps draining the queue', async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const started: string[] = [];
      const failing = deferred();
      const good = deferred();
      enqueueThumbLoad('bad', () => {
        started.push('bad');
        return failing.promise;
      });
      enqueueThumbLoad('good', () => {
        started.push('good');
        return good.promise;
      });

      failing.reject(new Error('EIO: thumbnail read failed'));
      await flush();

      assert.deepEqual(started, ['bad', 'good']);
      assert.ok(
        warnings.some(
          (args) =>
            String(args[0]).includes('thumbnail load failed') &&
            String(args[1]) === 'bad'
        ),
        'a failed thumbnail load must be logged, not swallowed'
      );

      good.resolve();
      await flush();
    } finally {
      console.warn = originalWarn;
    }
  });

  it('cancels pending loads and follow-ups for a key', async () => {
    const started: string[] = [];
    const running = [deferred(), deferred(), deferred(), deferred()];
    running.forEach((task, index) =>
      enqueueThumbLoad(`busy${index}`, () => {
        started.push(`busy${index}`);
        return task.promise;
      })
    );

    const pendingX = deferred();
    enqueueThumbLoad('x', () => {
      started.push('x');
      return pendingX.promise;
    });
    cancelThumbLoad('x');

    running[0].resolve();
    await flush();
    assert.ok(!started.includes('x'), 'a cancelled pending load must not run');

    const inFlightY = deferred();
    enqueueThumbLoad('y', () => {
      started.push('y-start');
      return inFlightY.promise;
    });
    const followUpY = deferred();
    enqueueThumbLoad('y', () => {
      started.push('y-follow');
      return followUpY.promise;
    });
    cancelThumbLoad('y');

    inFlightY.resolve();
    await flush();
    assert.ok(
      !started.includes('y-follow'),
      'a cancelled follow-up must not run after the in-flight load settles'
    );

    running[1].resolve();
    running[2].resolve();
    running[3].resolve();
    followUpY.resolve();
    await flush();
  });
});
