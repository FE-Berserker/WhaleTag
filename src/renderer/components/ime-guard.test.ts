import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isImeComposing } from './ime-guard';

describe('isImeComposing', () => {
  it('accepts ordinary keydown events', () => {
    assert.equal(
      isImeComposing({ nativeEvent: { isComposing: false, keyCode: 13 } }),
      false
    );
    assert.equal(isImeComposing({ nativeEvent: {} }), false);
  });

  it('detects both native composition signals', () => {
    assert.equal(
      isImeComposing({ nativeEvent: { isComposing: true, keyCode: 13 } }),
      true
    );
    assert.equal(
      isImeComposing({ nativeEvent: { isComposing: false, keyCode: 229 } }),
      true
    );
  });
});
