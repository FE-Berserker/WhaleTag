import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  registerExtensionSaveFlush,
  flushExtensionEditors,
} from './extension-save-flush';

describe('extension-save-flush', () => {
  beforeEach(() => {
    registerExtensionSaveFlush(null);
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
