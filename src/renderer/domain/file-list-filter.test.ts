import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { DirEntry } from '../../shared/ipc-types';
import { filterEntriesByTag } from './file-list-filter';

const NOW = new Date(2026, 6, 4, 12, 0);

function file(name: string): DirEntry {
  return {
    name,
    path: `/loc/${name}`,
    isDirectory: false,
    isFile: true,
    size: 0,
    modified: '',
    extension: '',
  };
}

const plainFirst = file('plain-first.txt');
const geo = file('geo.txt');
const period = file('period.txt');
const staleDate = file('stale-date.txt');
const smartToday = file('smart-today.txt');
const smartTodayLegacy = file('smart-today-legacy.txt');
const plainLast = file('plain-last.txt');
const untagged = file('untagged.txt');
const entries = [
  plainFirst,
  geo,
  period,
  staleDate,
  smartToday,
  smartTodayLegacy,
  plainLast,
  untagged,
];
const tagsByName: ReadonlyMap<string, readonly string[]> = new Map([
  [plainFirst.path, ['work']],
  [geo.path, ['geo:31.2304,121.4737', 'work']],
  [period.path, ['20260701-20260703']],
  [staleDate.path, ['20251223']],
  [smartToday.path, ['20260704']],
  [smartTodayLegacy.path, ['today-20260704']],
  [plainLast.path, ['work']],
]);

describe('filterEntriesByTag', () => {
  it('returns the original entries reference when no tag is active', () => {
    assert.strictEqual(filterEntriesByTag(entries, tagsByName, null, NOW), entries);
  });

  it('filters plain tags in entry order and preserves entry references', () => {
    const result = filterEntriesByTag(entries, tagsByName, 'work', NOW);

    assert.deepEqual(result.map((e) => e.path), [
      plainFirst.path,
      geo.path,
      plainLast.path,
    ]);
    assert.strictEqual(result[0], plainFirst);
    assert.strictEqual(result[1], geo);
    assert.strictEqual(result[2], plainLast);
  });

  it('matches entries carrying a geo: coordinate tag', () => {
    assert.deepEqual(filterEntriesByTag(entries, tagsByName, 'geo:', NOW), [geo]);
  });

  it('matches entries carrying a period: date-range tag', () => {
    assert.deepEqual(filterEntriesByTag(entries, tagsByName, 'period:', NOW), [
      period,
    ]);
  });

  it('matches only stale date-shaped tags for date:', () => {
    assert.deepEqual(filterEntriesByTag(entries, tagsByName, 'date:', NOW), [
      staleDate,
    ]);
  });

  it('matches current and legacy variants of the same smart: functionality', () => {
    assert.deepEqual(
      filterEntriesByTag(entries, tagsByName, 'smart:today', NOW),
      [smartToday, smartTodayLegacy]
    );
  });
});
