import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPTH_DEFAULT,
  DEPTH_MAX,
  DEPTH_MIN,
  FILTERABLE_CATEGORIES,
  sanitizeDepth,
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

describe('sanitizeDepth', () => {
  it('passes through in-range integers', () => {
    assert.equal(sanitizeDepth(DEPTH_MIN), DEPTH_MIN);
    assert.equal(sanitizeDepth(DEPTH_DEFAULT), DEPTH_DEFAULT);
    assert.equal(sanitizeDepth(DEPTH_MAX), DEPTH_MAX);
  });

  it('rounds fractional values that land in range', () => {
    assert.equal(sanitizeDepth(2.4), 2);
  });

  it('rejects out-of-range, NaN, and non-number values', () => {
    assert.equal(sanitizeDepth(DEPTH_MAX + 1), null);
    assert.equal(sanitizeDepth(0), null);
    assert.equal(sanitizeDepth(Number.NaN), null);
    assert.equal(sanitizeDepth('3'), null);
    assert.equal(sanitizeDepth(undefined), null);
  });
});
