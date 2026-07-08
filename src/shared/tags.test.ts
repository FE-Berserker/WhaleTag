import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTagsInput,
  extractTags,
  generateFileName,
  stripTagsFromName,
} from './tags';

describe('tags parseTagsInput', () => {
  it('splits whitespace-separated tags', () => {
    assert.deepEqual(parseTagsInput('work photo 2026'), [
      'work',
      'photo',
      '2026',
    ]);
  });

  it('preserves a geo tag whose value contains a comma', () => {
    // Regression: tags used to be split on /[,\s]+/, which fractured
    // `geo:lat,lng` into two junk tags on every edit/save round-trip.
    const out = parseTagsInput('work geo:39.9042,116.4074 photo');
    assert.deepEqual(out, ['work', 'geo:39.9042,116.4074', 'photo']);
  });

  it('preserves a geo tag as the only tag', () => {
    assert.deepEqual(parseTagsInput('geo:1.5,2.5'), ['geo:1.5,2.5']);
  });

  it('trims and de-duplicates, dropping empties', () => {
    assert.deepEqual(parseTagsInput('  work   work  '), ['work']);
    assert.deepEqual(parseTagsInput('   '), []);
  });
});

describe('tags extractTags / generateFileName', () => {
  it('extracts space-separated tags from [brackets]', () => {
    assert.deepEqual(extractTags('report[work 2026].pdf'), ['work', '2026']);
    assert.deepEqual(extractTags('plain.pdf'), []);
  });

  it('round-trips tags through generateFileName (space-separated)', () => {
    const name = generateFileName('report.pdf', ['work', '2026']);
    assert.equal(name, 'report[work 2026].pdf');
    assert.deepEqual(extractTags(name), ['work', '2026']);
  });

  it('stripTagsFromName keeps the extension', () => {
    assert.equal(stripTagsFromName('report[work 2026].pdf'), 'report.pdf');
  });
});
