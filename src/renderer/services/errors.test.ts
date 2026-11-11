import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { errorMessage } from './errors';

describe('errorMessage', () => {
  it('uses an Error message', () => {
    assert.equal(errorMessage(new Error('EACCES: permission denied')), 'EACCES: permission denied');
  });

  it('passes a thrown string through unchanged', () => {
    assert.equal(errorMessage('boom'), 'boom');
  });

  it('stringifies non-Error rejects', () => {
    assert.equal(errorMessage({ code: 'EPERM' }), '[object Object]');
    assert.equal(errorMessage(42), '42');
  });

  it('never returns an empty string for nullish values', () => {
    assert.equal(errorMessage(null), 'null');
    assert.equal(errorMessage(undefined), 'undefined');
  });
});
