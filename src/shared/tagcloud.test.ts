import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  countTags,
  scaleCount,
  tagCategory,
  tagCloudData,
  tagCooccurrenceMatrix,
} from './tagcloud';

describe('countTags', () => {
  it('counts each tag once per file', () => {
    const counts = countTags([
      ['work', 'urgent'],
      ['work'],
      ['work', 'idea'],
    ]);
    assert.deepEqual(counts, [
      { tag: 'work', count: 3 },
      { tag: 'idea', count: 1 },
      { tag: 'urgent', count: 1 },
    ]);
  });

  it('collapses duplicate tags within a single file', () => {
    const counts = countTags([['work', 'work', 'work']]);
    assert.deepEqual(counts, [{ tag: 'work', count: 1 }]);
  });

  it('ignores empty arrays, undefined, and blank tags', () => {
    const counts = countTags([undefined, [], ['  ', 'work'], ['work']]);
    assert.deepEqual(counts, [{ tag: 'work', count: 2 }]);
  });

  it('sorts by frequency desc then tag name asc', () => {
    const counts = countTags([['b'], ['a'], ['a'], ['c'], ['c']]);
    assert.deepEqual(counts.map((c) => c.tag), ['a', 'c', 'b']);
  });

  it('returns an empty array for no tags', () => {
    assert.deepEqual(countTags([undefined, [], []]), []);
  });
});

describe('scaleCount', () => {
  it('sqrt compresses high frequencies', () => {
    assert.equal(scaleCount(1, 'sqrt'), 1);
    assert.equal(scaleCount(4, 'sqrt'), 2);
    assert.equal(scaleCount(100, 'sqrt'), 10);
  });

  it('linear passes the count through unchanged', () => {
    assert.equal(scaleCount(7, 'linear'), 7);
  });

  it('log keeps single-use tags above zero', () => {
    assert.ok(scaleCount(1, 'log') > 0);
    assert.ok(scaleCount(100, 'log') > scaleCount(1, 'log'));
  });

  it('defaults to sqrt and returns 0 for non-positive counts', () => {
    assert.equal(scaleCount(9), 3);
    assert.equal(scaleCount(0), 0);
  });
});

describe('tagCloudData', () => {
  it('builds {name, value, count} with sqrt sizing by default', () => {
    const data = tagCloudData([['a'], ['a'], ['a'], ['a'], ['b']]);
    assert.deepEqual(data, [
      { name: 'a', value: 2, count: 4 },
      { name: 'b', value: 1, count: 1 },
    ]);
  });

  it('honors a custom scale', () => {
    const data = tagCloudData([['a'], ['a'], ['a'], ['a']], { scale: 'linear' });
    assert.equal(data[0].value, 4);
  });

  it('keeps only the top-N when limit is set', () => {
    const data = tagCloudData([['a'], ['a'], ['b'], ['c']], { limit: 1 });
    assert.deepEqual(data, [{ name: 'a', value: Math.sqrt(2), count: 2 }]);
  });

  it('returns an empty array when there are no tags', () => {
    assert.deepEqual(tagCloudData([undefined, []]), []);
  });

  it('drops excluded categories before counting', () => {
    const data = tagCloudData(
      [
        ['work', 'in-progress', '3star'],
        ['work', 'urgent-important', '20251223'],
      ],
      { exclude: ['workflow', 'priority', 'date'] }
    );
    assert.deepEqual(data, [
      { name: 'work', value: Math.sqrt(2), count: 2 },
      { name: '3star', value: 1, count: 1 },
    ]);
  });

  it('keeps geo tags when geo is not excluded', () => {
    const data = tagCloudData([['geo:36.1,117.8', 'work']], { exclude: [] });
    assert.equal(data.length, 2);
    assert.ok(data.some((d) => d.name === 'geo:36.1,117.8'));
    assert.ok(data.some((d) => d.name === 'work'));
  });

  it('drops geo tags when geo is excluded', () => {
    const data = tagCloudData([['geo:36.1,117.8', 'work']], { exclude: ['geo'] });
    assert.equal(data.length, 1);
    assert.equal(data[0].name, 'work');
  });

  it('applies limit AFTER exclude (top-N among remaining categories)', () => {
    // `in-progress` is the most frequent tag but is excluded; the limit:1 then
    // applies to what survives, so the top *plain* tag wins — not the globally
    // most frequent tag. Locks the P2-4 "exclude first, then limit" ordering.
    const data = tagCloudData(
      [
        ['in-progress', 'work'],
        ['in-progress', 'work'],
        ['in-progress', 'idea'],
      ],
      { exclude: ['workflow'], limit: 1 }
    );
    assert.deepEqual(data, [{ name: 'work', value: Math.sqrt(2), count: 2 }]);
  });

  it('categorizes each distinct tag once regardless of occurrence count', () => {
    // Regression for the P2-4 O(N) rewrite: a tag repeated across many files
    // must be classified by its distinct value, not re-filtered per occurrence.
    // 100 files all carrying the same excluded workflow tag → empty result.
    const lists = Array.from({ length: 100 }, () => ['in-progress', 'keep']);
    const data = tagCloudData(lists, { exclude: ['workflow'] });
    assert.deepEqual(data, [{ name: 'keep', value: 10, count: 100 }]);
  });
});

describe('tagCategory', () => {
  it('classifies smart tags and falls back to plain', () => {
    assert.equal(tagCategory('3star'), 'rating');
    assert.equal(tagCategory('in-progress'), 'workflow');
    assert.equal(tagCategory('urgent-important'), 'priority');
    assert.equal(tagCategory('20251223'), 'date');
    assert.equal(tagCategory('geo:36.1,117.8'), 'geo');
    assert.equal(tagCategory('vacation'), 'plain');
  });

  it('classifies year/month/relative date smart tags as date', () => {
    assert.equal(tagCategory('year-2025'), 'date');
    assert.equal(tagCategory('month-202506'), 'date');
    assert.equal(tagCategory('today-20251223'), 'date');
    assert.equal(tagCategory('now-20251223T1430'), 'date');
    // Look-alikes that are NOT smart date tags stay plain.
    assert.equal(tagCategory('year-end'), 'plain');
    assert.equal(tagCategory('month-report'), 'plain');
  });
});

describe('tagCooccurrenceMatrix', () => {
  it('builds a symmetric matrix with diagonal tag counts', () => {
    const { tags, matrix } = tagCooccurrenceMatrix([
      ['work', 'weekly'],
      ['work', 'weekly'],
      ['work', 'finance'],
      ['life'],
    ]);
    assert.deepEqual(tags, ['work', 'weekly', 'finance', 'life']);
    // work row
    assert.equal(matrix[0][0], 3); // work count
    assert.equal(matrix[0][1], 2); // work + weekly
    assert.equal(matrix[0][2], 1); // work + finance
    assert.equal(matrix[0][3], 0); // work + life
    // weekly row
    assert.equal(matrix[1][0], 2);
    assert.equal(matrix[1][1], 2); // weekly count
    assert.equal(matrix[1][2], 0);
    // finance row
    assert.equal(matrix[2][0], 1);
    assert.equal(matrix[2][2], 1); // finance count
    assert.equal(matrix[2][3], 0);
    // life row
    assert.equal(matrix[3][3], 1); // life count
  });

  it('collapses duplicate tags within a single file', () => {
    const { matrix } = tagCooccurrenceMatrix([['work', 'work', 'weekly']]);
    assert.equal(matrix[0][0], 1);
    assert.equal(matrix[0][1], 1);
    assert.equal(matrix[1][1], 1);
  });

  it('ignores empty and undefined tag lists', () => {
    const { tags, matrix, totalFiles } = tagCooccurrenceMatrix([
      undefined,
      [],
      ['work'],
    ]);
    assert.deepEqual(tags, ['work']);
    assert.equal(matrix[0][0], 1);
    assert.equal(totalFiles, 1);
  });

  it('limits the tag axis to the top-N most frequent', () => {
    const { tags } = tagCooccurrenceMatrix(
      [['a'], ['a'], ['b'], ['c']],
      { limit: 2 }
    );
    assert.deepEqual(tags, ['a', 'b']);
  });

  it('excludes categories before building the matrix', () => {
    const { tags, matrix } = tagCooccurrenceMatrix(
      [
        ['work', 'in-progress'],
        ['work', 'in-progress'],
        ['work', 'urgent-important'],
      ],
      { exclude: ['workflow', 'priority'] }
    );
    assert.deepEqual(tags, ['work']);
    assert.equal(matrix[0][0], 3);
  });

  it('returns empty matrix when no tags match', () => {
    const { tags, matrix, totalFiles } = tagCooccurrenceMatrix([undefined, []]);
    assert.deepEqual(tags, []);
    assert.deepEqual(matrix, []);
    assert.equal(totalFiles, 0);
  });
});
