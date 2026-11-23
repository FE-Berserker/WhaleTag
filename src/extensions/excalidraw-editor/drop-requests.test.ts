import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDropRequestStore } from './drop-requests';

/** Collects expiry callbacks so tests can fire them deterministically. */
function manualScheduler() {
  const queued: { id: number; run: () => void }[] = [];
  let seq = 0;
  return {
    schedule(callback: () => void, _ms: number): unknown {
      const id = (seq += 1);
      queued.push({ id, run: callback });
      return id;
    },
    cancel(handle: unknown): void {
      const index = queued.findIndex((t) => t.id === handle);
      if (index >= 0) queued.splice(index, 1);
    },
    fireAll(): void {
      for (const timer of queued.splice(0)) timer.run();
    },
    pending(): number {
      return queued.length;
    },
  };
}

function makeStore(timeoutMs = 15_000) {
  const scheduler = manualScheduler();
  const expired: string[] = [];
  const store = createDropRequestStore({
    timeoutMs,
    onTimeout: (id) => expired.push(id),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  return { store, scheduler, expired };
}

describe('createDropRequestStore', () => {
  it('places the reply at the coordinates of the drop that asked for it', () => {
    const { store } = makeStore();
    assert.equal(store.begin('drop-1', { x: 12, y: 34 }), true);

    const resolution = store.resolve('drop-1');
    assert.deepEqual(resolution, { accepted: true, position: { x: 12, y: 34 } });
    assert.equal(store.pending(), 0);
  });

  it('keeps two concurrent drops apart (the old single-slot bug)', () => {
    const { store } = makeStore();
    store.begin('drop-1', { x: 10, y: 10 });
    store.begin('drop-2', { x: 200, y: 200 });

    // Replies arrive out of order: the newest drop's reply lands first.
    assert.deepEqual(store.resolve('drop-2'), {
      accepted: true,
      position: { x: 200, y: 200 },
    });
    assert.deepEqual(store.resolve('drop-1'), {
      accepted: true,
      position: { x: 10, y: 10 },
    });
    assert.equal(store.pending(), 0);
  });

  it('rejects a reply whose request id is not pending', () => {
    const { store } = makeStore();
    assert.deepEqual(store.resolve('drop-unknown'), {
      accepted: false,
      reason: 'unknown-request',
    });
    // ...and a request id is single-use.
    store.begin('drop-1', { x: 1, y: 1 });
    assert.equal(store.resolve('drop-1').accepted, true);
    assert.equal(store.resolve('drop-1').accepted, false);
  });

  it('refuses a duplicate request id instead of overwriting the position', () => {
    const { store } = makeStore();
    assert.equal(store.begin('drop-1', { x: 1, y: 1 }), true);
    assert.equal(store.begin('drop-1', { x: 9, y: 9 }), false);
    assert.deepEqual(store.resolve('drop-1'), {
      accepted: true,
      position: { x: 1, y: 1 },
    });
  });

  it('accepts an id-less reply only when nothing else is in flight', () => {
    const { store } = makeStore();
    assert.deepEqual(store.resolve(undefined), { accepted: true, position: null });

    store.begin('drop-1', { x: 5, y: 6 });
    assert.deepEqual(store.resolve(undefined), {
      accepted: false,
      reason: 'missing-request-id',
    });
    // The real reply still lands, so the drop is not lost.
    assert.deepEqual(store.resolve('drop-1'), {
      accepted: true,
      position: { x: 5, y: 6 },
    });
  });

  it('drops a request that timed out and reports it', () => {
    const { store, scheduler, expired } = makeStore(1000);
    store.begin('drop-1', { x: 1, y: 2 });

    scheduler.fireAll();
    assert.deepEqual(expired, ['drop-1']);
    assert.equal(store.pending(), 0);
    assert.deepEqual(store.resolve('drop-1'), {
      accepted: false,
      reason: 'unknown-request',
    });
  });

  it('cancel timers are cleared when the reply arrives in time', () => {
    const { store, scheduler, expired } = makeStore(1000);
    store.begin('drop-1', { x: 1, y: 2 });
    store.resolve('drop-1');

    assert.equal(scheduler.pending(), 0);
    scheduler.fireAll();
    assert.deepEqual(expired, []);
  });

  it('clear() forgets everything (editor unmount)', () => {
    const { store, scheduler } = makeStore();
    store.begin('drop-1', { x: 1, y: 1 });
    store.begin('drop-2', { x: 2, y: 2 });

    store.clear();
    assert.equal(store.pending(), 0);
    assert.equal(scheduler.pending(), 0);
    assert.equal(store.resolve('drop-1').accepted, false);
  });
});
