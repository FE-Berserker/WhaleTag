import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { saveForExtensionClose } from './extension-save-close';

describe('saveForExtensionClose notification ownership', () => {
  it('notifies exactly once when no host save handler is registered', async () => {
    let notices = 0;
    const ok = await saveForExtensionClose(undefined, () => {
      notices += 1;
    });
    assert.equal(ok, false);
    assert.equal(notices, 1);
  });

  it('leaves a registered handler failure to the host and returns false', async () => {
    let saves = 0;
    let notices = 0;
    let stillDirtyNotices = 0;
    const ok = await saveForExtensionClose(
      async () => {
        saves += 1;
        return false;
      },
      () => {
        notices += 1;
      },
      {
        isDirty: () => assert.fail('failed saves must skip the dirty recheck'),
        notifyStillDirty: () => {
          stillDirtyNotices += 1;
        },
      }
    );
    assert.equal(ok, false);
    assert.equal(saves, 1);
    assert.equal(notices, 0);
    assert.equal(stillDirtyNotices, 0);
  });

  it('returns a successful save without a fallback notice', async () => {
    let notices = 0;
    const ok = await saveForExtensionClose(
      async () => true,
      () => {
        notices += 1;
      }
    );
    assert.equal(ok, true);
    assert.equal(notices, 0);
  });

  it('rejects a successful save when the post-save state is still dirty', async () => {
    let missingHandlerNotices = 0;
    let stillDirtyNotices = 0;
    const ok = await saveForExtensionClose(
      async () => true,
      () => {
        missingHandlerNotices += 1;
      },
      {
        isDirty: () => true,
        notifyStillDirty: () => {
          stillDirtyNotices += 1;
        },
      }
    );
    assert.equal(ok, false);
    assert.equal(missingHandlerNotices, 0);
    assert.equal(stillDirtyNotices, 1);
  });

  it('allows a successful save when the post-save state is clean', async () => {
    let stillDirtyNotices = 0;
    const ok = await saveForExtensionClose(
      async () => true,
      () => assert.fail('missing handler must not be reported'),
      {
        isDirty: () => false,
        notifyStillDirty: () => {
          stillDirtyNotices += 1;
        },
      }
    );
    assert.equal(ok, true);
    assert.equal(stillDirtyNotices, 0);
  });
});
