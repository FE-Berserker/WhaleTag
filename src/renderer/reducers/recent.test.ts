/**
 * Recent-directories LRU: dedupe must consider the location as well as the
 * path. The same directory path can be registered under two locations (the
 * same folder added twice, or a drive mounted at two places), and keying by
 * path alone collapsed them into one slot — the click then jumped to whichever
 * location won, not the one the user actually visited.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REMOVE_LOCATION } from './locations';
import reducer, { clearRecent, recordRecent } from './recent';

describe('recent reducer', () => {
  it('keeps the same path under two locations as two entries', () => {
    let state = reducer(undefined, recordRecent({ path: 'D:\\Work', locationId: 'a' }));
    state = reducer(state, recordRecent({ path: 'D:\\Work', locationId: 'b' }));
    assert.deepEqual(state.items, [
      { path: 'D:\\Work', locationId: 'b' },
      { path: 'D:\\Work', locationId: 'a' },
    ]);
  });

  it('moves an existing (location, path) pair to the front without duplicating it', () => {
    let state = reducer(undefined, recordRecent({ path: 'D:\\A', locationId: 'loc' }));
    state = reducer(state, recordRecent({ path: 'D:\\B', locationId: 'loc' }));
    state = reducer(state, recordRecent({ path: 'D:\\A', locationId: 'loc' }));
    assert.deepEqual(state.items, [
      { path: 'D:\\A', locationId: 'loc' },
      { path: 'D:\\B', locationId: 'loc' },
    ]);
  });

  it('rejects entries without a path or location and keeps at most 15 items', () => {
    let state = reducer(undefined, recordRecent({ path: '', locationId: 'loc' }));
    assert.deepEqual(state.items, []);
    state = reducer(state, recordRecent({ path: 'D:\\X', locationId: '' }));
    assert.deepEqual(state.items, []);
    for (let i = 0; i < 20; i++) {
      state = reducer(state, recordRecent({ path: `D:\\dir${i}`, locationId: 'loc' }));
    }
    assert.equal(state.items.length, 15);
    assert.deepEqual(state.items[0], { path: 'D:\\dir19', locationId: 'loc' });
  });

  it('drops recents of a removed location and clears on demand', () => {
    let state = reducer(undefined, recordRecent({ path: 'D:\\A', locationId: 'a' }));
    state = reducer(state, recordRecent({ path: 'D:\\B', locationId: 'b' }));
    state = reducer(state, { type: REMOVE_LOCATION, payload: 'a' });
    assert.deepEqual(state.items, [{ path: 'D:\\B', locationId: 'b' }]);
    state = reducer(state, clearRecent());
    assert.deepEqual(state.items, []);
  });
});
