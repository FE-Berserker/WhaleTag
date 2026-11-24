import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FILTERABLE_CATEGORIES,
  sanitizeShownCategories,
} from './perspective-prefs';

describe('sanitizeShownCategories', () => {
  it('keeps only known filterable categories', () => {
    assert.deepEqual(
      sanitizeShownCategories(['rating', 'bogus', 'geo']),
      ['rating', 'geo']
    );
  });

  it('returns an empty array for an all-unknown list (valid empty selection)', () => {
    assert.deepEqual(sanitizeShownCategories(['nope', 42, null]), []);
  });

  it('returns null when the value is not an array', () => {
    assert.equal(sanitizeShownCategories('rating'), null);
    assert.equal(sanitizeShownCategories(undefined), null);
    assert.equal(sanitizeShownCategories({ rating: true }), null);
  });

  it('accepts every declared filterable category', () => {
    assert.deepEqual(
      sanitizeShownCategories([...FILTERABLE_CATEGORIES]),
      [...FILTERABLE_CATEGORIES]
    );
  });
});
