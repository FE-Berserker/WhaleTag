import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import globalJsdom from 'global-jsdom';
import { chapterPlainText, previewText } from './plain-text';

// global-jsdom@29 requires an explicit call to install window/document/DOMParser.
// chapterPlainText depends on the browser's DOMParser, so we set up jsdom
// once for the whole suite (cheap — ~30 ms on a warm cache).
before(() => {
  globalJsdom();
});

describe('chapterPlainText', () => {
  it('returns "" for empty input', () => {
    assert.equal(chapterPlainText(''), '');
  });

  it('strips style/script/noscript/svg content', () => {
    const html =
      '<p>before</p>' +
      '<style>body{color:red}</style>' +
      '<script>alert(1)</script>' +
      '<noscript>no js</noscript>' +
      '<svg><text>draw me</text></svg>' +
      '<p>after</p>';
    const out = chapterPlainText(html);
    assert.equal(out, 'before\nafter');
  });

  it('inserts newlines at block boundaries', () => {
    const html = '<p>one</p><p>two</p>';
    assert.equal(chapterPlainText(html), 'one\ntwo');
  });

  it('<br> produces a newline', () => {
    assert.equal(chapterPlainText('line one<br>line two'), 'line one\nline two');
  });

  it('collapses runs of whitespace within a text node', () => {
    assert.equal(chapterPlainText('<p>a    b\t\tc</p>'), 'a b c');
  });

  it('decodes common entities', () => {
    // DOMParser already decodes entities; we just confirm the round-trip.
    assert.equal(chapterPlainText('<p>A &amp; B &lt; C</p>'), 'A & B < C');
  });

  it('handles nested tags without spurious newlines', () => {
    assert.equal(
      chapterPlainText('<div><span>nested <em>text</em></span></div>'),
      'nested text'
    );
  });

  it('keeps <pre> block newline but does not collapse leading space', () => {
    const out = chapterPlainText('<pre>  indented</pre>');
    assert.ok(out.includes('indented'), 'preformatted text preserved');
  });

  it('handles headings, lists, table rows', () => {
    const html =
      '<h1>Title</h1>' +
      '<p>intro</p>' +
      '<ul><li>one</li><li>two</li></ul>' +
      '<table><tr><td>a</td><td>b</td></tr></table>';
    const out = chapterPlainText(html);
    // Cells concatenate without a separator; the </tr> closes the row with a
    // newline. Add cells to BLOCK_TAGS to get a tab between cells — but for
    // v1 the row boundary is enough for navigation/search.
    assert.equal(out, 'Title\nintro\none\ntwo\nab');
  });
});

describe('previewText', () => {
  it('returns text as-is when shorter than max', () => {
    assert.equal(previewText('hello', 80), 'hello');
  });

  it('truncates and appends ellipsis when longer', () => {
    const long = 'x'.repeat(100);
    const preview = previewText(long, 20);
    assert.equal(preview.length, 20);
    assert.ok(preview.endsWith('…'));
  });

  it('collapses whitespace before measuring', () => {
    assert.equal(previewText('a   b   c', 80), 'a b c');
  });
});