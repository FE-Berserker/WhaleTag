import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createInitialContentDeferred } from './initial-content';

describe('Excalidraw initial content deferred', () => {
  it('resolves initialization with the first host document exactly once', async () => {
    const deferred = createInitialContentDeferred();
    const first = { path: '/tmp/first.excalidraw', content: '{"elements":[1]}' };
    deferred.resolve(first);
    deferred.resolve({ path: '/tmp/late.excalidraw', content: '{"elements":[]}' });

    assert.equal(await deferred.promise, first);
    assert.equal(deferred.consumed, false);
  });

  it('reports a repeated first-document resolve as ignored', () => {
    const deferred = createInitialContentDeferred();
    assert.equal(deferred.resolve({ path: '/tmp/first.excalidraw', content: '{}' }), true);
    assert.equal(deferred.resolve({ path: '/tmp/late.excalidraw', content: '{}' }), false);
    assert.equal(deferred.consumed, false);
  });
});
