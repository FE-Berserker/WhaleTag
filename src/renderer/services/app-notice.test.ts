import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_NOTICE_QUEUE,
  enqueueNotice,
  notifyApp,
  subscribeAppNotices,
  type AppNotice,
} from './app-notice';

describe('app-notice', () => {
  it('queues error notices emitted before the first subscriber', () => {
    const seen: { message: string }[] = [];
    // The boot-time persist reporter can fire before <AppNoticeHost> mounts.
    notifyApp('boot failure');
    notifyApp('quiet warning', 'warning');
    const off = subscribeAppNotices((n) => seen.push(n));
    try {
      assert.deepEqual(
        seen.map((n) => n.message),
        ['boot failure']
      );
    } finally {
      off();
    }
  });

  it('drops notices after the host has unsubscribed', () => {
    const off = subscribeAppNotices(() => {});
    off();
    const seen: { message: string }[] = [];
    notifyApp('dropped');
    const offLate = subscribeAppNotices((n) => seen.push(n));
    try {
      assert.deepEqual(seen, []);
    } finally {
      offLate();
    }
  });

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

  describe('enqueueNotice', () => {
    const notice = (id: number, message: string): AppNotice => ({
      id,
      message,
      severity: 'error',
    });

    it('queues behind the visible head in arrival order', () => {
      const a = notice(1, 'a');
      const b = notice(2, 'b');
      const c = notice(3, 'c');
      assert.deepEqual(enqueueNotice([], a), [a]);
      assert.deepEqual(enqueueNotice([a], b), [a, b]);
      assert.deepEqual(enqueueNotice([a, b], c), [a, b, c]);
    });

    it('never evicts the head and drops the oldest pending notice', () => {
      const head = notice(10, 'on screen');
      const pending = Array.from({ length: MAX_NOTICE_QUEUE }, (_, i) =>
        notice(11 + i, `pending ${i}`)
      );
      const newest = notice(99, 'newest');
      const next = enqueueNotice([head, ...pending], newest);
      assert.equal(next.length, MAX_NOTICE_QUEUE + 1);
      // The notice the user is reading must not disappear mid-toast.
      assert.equal(next[0], head);
      // Oldest pending is gone; the newest one takes the last slot.
      assert.deepEqual(
        next.slice(1).map((n) => n.id),
        [...pending.slice(1).map((n) => n.id), 99]
      );
      assert.equal(next[next.length - 1], newest);
    });
  });
});
