/**
 * Locations reducer tests. The pre-P? surface (`ADD_LOCATION`,
 * `REMOVE_LOCATION`, `SET_ACTIVE_LOCATION`, `MOVE_LOCATION`) is exercised
 * implicitly through the higher-level integration tests; this file locks
 * down the new `UPDATE_LOCATION` action and its convenience creator
 * `setLocationReadOnly`, since the new UX shortcuts depend on the
 * in-place readOnly toggle persisting without disturbing sibling items.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import reducer, {
  ADD_LOCATION,
  addLocation,
  setLocationReadOnly,
  updateLocation,
  UPDATE_LOCATION,
  type LocationsState,
} from './locations';
import type { WhaleLocation } from '../../shared/ipc-types';

function makeLocation(overrides: Partial<WhaleLocation> = {}): WhaleLocation {
  return {
    id: overrides.id ?? 'loc-1',
    name: overrides.name ?? 'docs',
    path: overrides.path ?? '/tmp/docs',
    type: 'local',
    isReadOnly: overrides.isReadOnly ?? false,
    createdAt: overrides.createdAt ?? '1970-01-01T00:00:00.000Z',
  };
}

function makeState(
  items: WhaleLocation[] = [],
  activeId: string | null = null
): LocationsState {
  return { items, activeId };
}

describe('locations reducer — UPDATE_LOCATION + setLocationReadOnly', () => {
  it('flips isReadOnly on an existing location via setLocationReadOnly', () => {
    const initial = makeState([makeLocation({ isReadOnly: false })]);
    const next = reducer(initial, setLocationReadOnly('loc-1', true));
    assert.equal(next.items[0].isReadOnly, true);
    // Untouched fields are preserved.
    assert.equal(next.items[0].id, 'loc-1');
    assert.equal(next.items[0].path, '/tmp/docs');
    assert.equal(next.items[0].name, 'docs');
  });

  it('flips back from true to false', () => {
    const initial = makeState([makeLocation({ isReadOnly: true })]);
    const next = reducer(initial, setLocationReadOnly('loc-1', false));
    assert.equal(next.items[0].isReadOnly, false);
  });

  it('does not change items when the location id is unknown', () => {
    const initial = makeState([makeLocation({ id: 'loc-A' })]);
    const next = reducer(initial, setLocationReadOnly('loc-Z', true));
    // Returning the same state reference short-circuits selector
    // re-renders downstream. Items themselves are unchanged.
    assert.equal(next, initial);
  });

  it('only mutates the patched location; siblings are untouched', () => {
    const initial = makeState([
      makeLocation({ id: 'a', isReadOnly: false }),
      makeLocation({ id: 'b', isReadOnly: false }),
      makeLocation({ id: 'c', isReadOnly: true }),
    ]);
    const next = reducer(initial, setLocationReadOnly('b', true));
    assert.deepEqual(
      next.items.map((l) => [l.id, l.isReadOnly] as const),
      [
        ['a', false],
        ['b', true],
        ['c', true],
      ]
    );
  });

  it('updateLocation supports arbitrary patches (forward-compatible)', () => {
    const initial = makeState([makeLocation({ name: 'docs' })]);
    const next = reducer(
      initial,
      updateLocation('loc-1', { name: 'documents' })
    );
    assert.equal(next.items[0].name, 'documents');
    assert.equal(next.items[0].id, 'loc-1');
  });

  it('addLocation + setLocationReadOnly compose — newly added can be flipped without re-add', () => {
    let state = makeState();
    state = reducer(state, addLocation('inbox', '/tmp/inbox', false));
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0].isReadOnly, false);
    state = reducer(state, setLocationReadOnly(state.items[0].id, true));
    assert.equal(state.items[0].isReadOnly, true);
    assert.equal(state.items.length, 1);
  });

  it('action creators use the expected action types', () => {
    // Regression: don't let a typo silently desynchronize the action
    // constants between creator and reducer case.
    assert.equal(UPDATE_LOCATION, 'locations/UPDATE_LOCATION');
    assert.equal(ADD_LOCATION, 'locations/ADD_LOCATION');
  });
});
