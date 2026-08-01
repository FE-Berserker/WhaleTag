import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { clampMaxTurns } from './buildSnapshot';

describe('buildSnapshot.clampMaxTurns', () => {
  it('passes through in-range integers', () => {
    assert.equal(clampMaxTurns(1), 1);
    assert.equal(clampMaxTurns(50), 50);
    assert.equal(clampMaxTurns(200), 200);
    assert.equal(clampMaxTurns(1000), 1000);
  });

  it('clamps below 1 up to 1', () => {
    assert.equal(clampMaxTurns(0), 1);
    assert.equal(clampMaxTurns(-5), 1);
  });

  it('clamps above 1000 down to 1000', () => {
    assert.equal(clampMaxTurns(1001), 1000);
    assert.equal(clampMaxTurns(99999), 1000);
  });

  it('truncates fractional values toward zero', () => {
    assert.equal(clampMaxTurns(50.7), 50);
    assert.equal(clampMaxTurns(0.9), 1); // trunc→0→clamped up to 1
  });

  it('falls back to 200 for non-finite input', () => {
    assert.equal(clampMaxTurns(NaN), 200);
    assert.equal(clampMaxTurns(Infinity), 200);
    assert.equal(clampMaxTurns(-Infinity), 200);
  });
});
