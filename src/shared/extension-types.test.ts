import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSaveAckCurrent } from './extension-types';

describe('isSaveAckCurrent', () => {
  it('keeps legacy acknowledgements backward compatible', () => {
    assert.equal(isSaveAckCurrent(undefined, undefined), true);
    assert.equal(isSaveAckCurrent(undefined, 3), true);
    assert.equal(isSaveAckCurrent(3, undefined), true);
  });

  it('accepts only an ack that covers the latest edit', () => {
    assert.equal(isSaveAckCurrent(2, 2), true);
    assert.equal(isSaveAckCurrent(3, 2), true);
    assert.equal(isSaveAckCurrent(1, 2), false);
  });
});
