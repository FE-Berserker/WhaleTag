import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  newRequest,
  completeRequest,
  failRequest,
  rejectAllPending,
  markWorkerActivity,
  WORKER_TIMEOUT_ERROR,
  type Pending,
} from './worker-protocol';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('worker-protocol — request correlation', () => {
  it('resolves the matching request and drops it from the map', async () => {
    const pending = new Map<string, Pending>();
    const { reqId, promise } = newRequest(pending);

    assert.equal(pending.size, 1);
    assert.equal(completeRequest(pending, reqId, { ok: 1 }), true);
    assert.deepEqual(await promise, { ok: 1 });
    assert.equal(pending.size, 0);
    // A duplicate reply (or a reply after a timeout) is dropped, not thrown.
    assert.equal(completeRequest(pending, reqId, { ok: 2 }), false);
  });

  it('rejects with a named timeout error when the worker never answers', async () => {
    const pending = new Map<string, Pending>();
    const { reqId, promise } = newRequest(pending, {
      timeoutMs: 20,
      label: 'index:query',
    });

    await assert.rejects(promise, (err: Error) => {
      assert.equal(err.name, WORKER_TIMEOUT_ERROR);
      assert.match(err.message, /index:query/);
      assert.match(err.message, /20 ms/);
      return true;
    });
    // The entry must be gone, otherwise the map leaks one promise per hang.
    assert.equal(pending.has(reqId), false);
  });

  it('keeps a request alive while the worker is still posting messages', async () => {
    const pending = new Map<string, Pending>();
    const { reqId, promise } = newRequest(pending, {
      timeoutMs: 50,
      label: 'index:build',
    });

    // Four rounds of "progress", each well inside the window. Without the
    // activity refresh the watchdog would fire at ~50 ms.
    for (let i = 0; i < 4; i += 1) {
      await sleep(20);
      markWorkerActivity(pending);
    }

    assert.equal(pending.has(reqId), true, 'still in flight after 80 ms');
    completeRequest(pending, reqId, { count: 3 });
    assert.deepEqual(await promise, { count: 3 });
    assert.equal(pending.size, 0);
  });

  it('does not arm a watchdog when timeoutMs is omitted', async () => {
    const pending = new Map<string, Pending>();
    const { reqId, promise } = newRequest(pending);

    await sleep(30);
    assert.equal(pending.has(reqId), true, 'untimed request still pending');

    failRequest(pending, reqId, new Error('worker died'));
    await assert.rejects(promise, /worker died/);
  });

  it('rejectAllPending clears every request and its timer', async () => {
    const pending = new Map<string, Pending>();
    const a = newRequest(pending, { timeoutMs: 20, label: 'index:query' });
    const b = newRequest(pending, { timeoutMs: 20, label: 'index:status' });

    rejectAllPending(pending, new Error('index worker exited'));
    assert.equal(pending.size, 0);
    await assert.rejects(a.promise, /exited/);
    await assert.rejects(b.promise, /exited/);

    // If the timers had survived they would fire during this sleep; the
    // promises are already settled, so just make sure nothing throws.
    await sleep(40);
    assert.equal(pending.size, 0);
  });
});
