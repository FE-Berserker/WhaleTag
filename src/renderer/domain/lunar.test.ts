import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { lunarDayLabel } from './lunar';

describe('lunarDayLabel', () => {
  // 2026-02-17 is the Chinese New Year of 2026 → 农历正月初一.
  it('returns the lunar month name on 初一 (lunar new-month day)', () => {
    assert.equal(lunarDayLabel(new Date(2026, 1, 17)), '正月');
  });

  it('returns just the lunar day for a non-初一 date', () => {
    // 2026-07-01 gregorian → 农历五月十七.
    assert.equal(lunarDayLabel(new Date(2026, 6, 1)), '十七');
  });

  it('returns a non-empty string for any normal date', () => {
    assert.ok(lunarDayLabel(new Date(2026, 6, 15)).length > 0);
  });
});
