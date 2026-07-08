import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import globalJsdom from 'global-jsdom';
import { SearchIndex, type SearchableChapter } from './search-index';

// chapterPlainText (used by SearchIndex) needs DOMParser. global-jsdom@29
// requires an explicit setup call.
before(() => {
  globalJsdom();
});

function ch(id: string, title: string, html: string): SearchableChapter {
  return { id, title, html };
}

describe('SearchIndex', () => {
  it('finds a hit in a single chapter', () => {
    const idx = new SearchIndex([
      ch('c1', 'Call me Ishmael', '<p>Call me Ishmael. Some years ago...</p>'),
    ]);
    const hits = idx.search('ishmael');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].chapterId, 'c1');
    assert.equal(hits[0].chapterIndex, 0);
    assert.equal(hits[0].length, 7);
    assert.ok(hits[0].snippet.toLowerCase().includes('ishmael'));
  });

  it('is case-insensitive', () => {
    const idx = new SearchIndex([ch('c1', 't', '<p>FOO bar FOO</p>')]);
    const hits = idx.search('foo');
    assert.equal(hits.length, 2);
  });

  it('returns hits across chapters in source order', () => {
    const idx = new SearchIndex([
      ch('a', 'A', '<p>foo</p>'),
      ch('b', 'B', '<p>bar</p>'),
      ch('c', 'C', '<p>foo</p>'),
    ]);
    const hits = idx.search('foo');
    assert.equal(hits.length, 2);
    assert.equal(hits[0].chapterId, 'a');
    assert.equal(hits[1].chapterId, 'c');
  });

  it('returns empty for empty query', () => {
    const idx = new SearchIndex([ch('a', 'A', '<p>foo</p>')]);
    assert.equal(idx.search('').length, 0);
    assert.equal(idx.search('   ').length, 0);
  });

  it('returns empty for unmatched query', () => {
    const idx = new SearchIndex([ch('a', 'A', '<p>foo</p>')]);
    assert.equal(idx.search('zzz').length, 0);
  });

  it('counts every non-overlapping occurrence', () => {
    const idx = new SearchIndex([ch('a', 'A', '<p>aaa</p>')]);
    assert.equal(idx.search('aa').length, 1);
    assert.equal(idx.search('a').length, 3);
  });

  it('replaces chapter set via setChapters', () => {
    const idx = new SearchIndex([ch('a', 'A', '<p>foo</p>')]);
    assert.equal(idx.search('foo').length, 1);
    idx.setChapters([ch('b', 'B', '<p>foo</p><p>bar</p>')]);
    assert.equal(idx.search('bar').length, 1);
    assert.equal(idx.search('foo').length, 1);
  });
});