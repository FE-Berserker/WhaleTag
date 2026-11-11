import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { notifyApp, subscribeAppNotices } from './app-notice';

describe('app-notice', () => {
  it('delivers default-error notices to every subscriber', () => {
    const a: { message: string; severity: string }[] = [];
    const b: { message: string; severity: string }[] = [];
    const offA = subscribeAppNotices((n) => a.push(n));
    const offB = subscribeAppNotices((n) => b.push(n));
    try {
      notifyApp('boom');
      const shape = (list: { message: string; severity: string }[]) =>
        list.map(({ message, severity }) => ({ message, severity }));
      assert.deepEqual(shape(a), [{ message: 'boom', severity: 'error' }]);
      assert.deepEqual(shape(b), [{ message: 'boom', severity: 'error' }]);
    } finally {
      offA();
      offB();
    }
  });

  it('preserves an explicit severity and a unique id per notice', () => {
    const seen: { id: number; severity: string }[] = [];
    const off = subscribeAppNotices((n) => seen.push(n));
    try {
      notifyApp('heads up', 'warning');
      notifyApp('fyi', 'info');
      assert.deepEqual(
        seen.map((n) => n.severity),
        ['warning', 'info']
      );
      assert.ok(seen[0].id < seen[1].id);
    } finally {
      off();
    }
  });

  it('stops delivery after unsubscribe', () => {
    let count = 0;
    const off = subscribeAppNotices(() => {
      count += 1;
    });
    notifyApp('one');
    off();
    notifyApp('two');
    assert.equal(count, 1);
  });

  it('keeps notifying the other subscribers when one throws', () => {
    // The host is one subscriber among potentially several; a renderer bug in
    // one must not silence the toast for the rest (and must not throw back
    // into a `.catch()` handler that just handled an IPC failure).
    let reached = 0;
    const offBad = subscribeAppNotices(() => {
      throw new Error('host exploded');
    });
    const offGood = subscribeAppNotices(() => {
      reached += 1;
    });
    try {
      assert.doesNotThrow(() => notifyApp('x'));
      assert.equal(reached, 1);
    } finally {
      offBad();
      offGood();
    }
  });
});
