import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import tagLibraryReducer, {
  addGroup,
  addTagToGroup,
  renameGroup,
  toggleGroup,
} from './taglibrary';

/** Seed a state with one group and return the id the reducer generated. */
function seed(title = 'Inbox') {
  const action = addGroup(title);
  return { state: tagLibraryReducer(undefined, action), id: action.payload.id };
}

describe('taglibrary reducer: renameGroup', () => {
  it('renames the matching group and trims the new title', () => {
    const { state, id } = seed('Inbox');
    const next = tagLibraryReducer(state, renameGroup(id, '  Projects  '));
    assert.equal(next.groups.length, 1);
    assert.equal(next.groups[0].title, 'Projects');
    assert.equal(next.groups[0].id, id);
  });

  it('leaves every other field of the group untouched', () => {
    const { state, id } = seed('Inbox');
    const withTag = tagLibraryReducer(state, addTagToGroup(id, 'alpha'));
    const collapsed = tagLibraryReducer(withTag, toggleGroup(id));
    const before = collapsed.groups[0];

    const next = tagLibraryReducer(collapsed, renameGroup(id, 'Renamed'));
    const after = next.groups[0];

    assert.deepEqual(after.tags, before.tags);
    assert.equal(after.expanded, before.expanded);
    assert.equal(after.color, before.color);
    assert.equal(after.title, 'Renamed');
  });

  it('only touches the group whose id matches', () => {
    const first = addGroup('First');
    const second = addGroup('Second');
    const state = tagLibraryReducer(
      tagLibraryReducer(undefined, first),
      second
    );

    const next = tagLibraryReducer(state, renameGroup(first.payload.id, 'Renamed'));
    assert.deepEqual(
      next.groups.map((g) => g.title),
      ['Renamed', 'Second']
    );
  });

  it('is a no-op for an unknown id', () => {
    const { state } = seed('Inbox');
    const next = tagLibraryReducer(state, renameGroup('missing', 'Other'));
    assert.deepEqual(
      next.groups.map((g) => g.title),
      ['Inbox']
    );
  });
});
