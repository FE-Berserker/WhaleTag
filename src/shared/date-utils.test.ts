import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addDays, pad2, ymdCompact, ymdLocal } from './date-utils';

describe('date-utils', () => {
  it('pads single digits and leaves larger values untouched', () => {
    assert.equal(pad2(0), '00');
    assert.equal(pad2(7), '07');
    assert.equal(pad2(10), '10');
    assert.equal(pad2(99), '99');
  });

  it('formats local calendar keys with dashes', () => {
    assert.equal(ymdLocal(new Date(2026, 0, 5)), '2026-01-05');
    assert.equal(ymdLocal(new Date(2026, 11, 31)), '2026-12-31');
  });

  it('formats compact smart-tag keys without dashes', () => {
    assert.equal(ymdCompact(new Date(2026, 0, 5)), '20260105');
    assert.equal(ymdCompact(new Date(2026, 11, 31)), '20261231');
  });

  it('adds days across month and year boundaries', () => {
    assert.equal(ymdLocal(addDays(new Date(2026, 0, 31), 1)), '2026-02-01');
    assert.equal(ymdLocal(addDays(new Date(2025, 11, 31), 1)), '2026-01-01');
    assert.equal(ymdLocal(addDays(new Date(2026, 2, 1), -1)), '2026-02-28');
  });
});
