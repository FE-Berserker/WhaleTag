import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  registerExtensionSaveFlush,
  flushExtensionEditors,
} from './extension-save-flush';
import { subscribeAppNotices, type AppNotice } from './app-notice';

describe('extension-save-flush', () => {
  beforeEach(() => {
    registerExtensionSaveFlush(null);
    // app-notice queues errors raised before the first subscriber so a boot
    // failure is not lost. Earlier tests in this file can raise such a notice;
    // subscribe once here to drain the boot queue, then drop the listener so
    // each test observes only the notices it triggers.
    subscribeAppNotices(() => undefined)();
  });

  it('is a no-op when nothing is registered', async () => {
    await flushExtensionEditors();
  });

  it('awaits the registered flush before resolving', async () => {
    let calls = 0;
    let finished = false;
    registerExtensionSaveFlush(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished = true;
    });

    await flushExtensionEditors();

    assert.equal(calls, 1);
    assert.equal(finished, true);
  });

  it('swallows a rejecting flush so the close handshake still completes', async () => {
    registerExtensionSaveFlush(async () => {
      throw new Error('save failed');
    });

    await assert.doesNotReject(flushExtensionEditors());
  });

  it('tells the user when the flush failed (it used to be console-only)', async () => {
    const notices: AppNotice[] = [];
    const unsubscribe = subscribeAppNotices((notice) => notices.push(notice));
    try {
      registerExtensionSaveFlush(async () => {
        throw new Error('save failed');
      });

      await flushExtensionEditors();
    } finally {
      unsubscribe();
    }

    assert.equal(notices.length, 1);
    assert.match(notices[0].message, /save/i);
  });

  it('stays quiet when the flush succeeds', async () => {
    const notices: AppNotice[] = [];
    const unsubscribe = subscribeAppNotices((notice) => notices.push(notice));
    try {
      registerExtensionSaveFlush(async () => undefined);
      await flushExtensionEditors();
    } finally {
      unsubscribe();
    }

    assert.deepEqual(notices, []);
  });

  it('stops flushing after the provider unregisters', async () => {
    let calls = 0;
    registerExtensionSaveFlush(async () => {
      calls += 1;
    });
    registerExtensionSaveFlush(null);

    await flushExtensionEditors();

    assert.equal(calls, 0);
  });
});
