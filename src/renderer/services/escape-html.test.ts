import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml } from './escape-html';

describe('escapeHtml', () => {
  it('neutralizes markup injected through a tag name', () => {
    assert.equal(
      escapeHtml('<img src=x onerror="alert(1)">'),
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
    );
  });

  it('escapes ampersands before the entities it produces', () => {
    // A single pass must not double-escape: `&` → `&amp;`, not `&amp;amp;`.
    assert.equal(escapeHtml('a & b < c'), 'a &amp; b &lt; c');
  });

  it('escapes single quotes and both quote styles', () => {
    assert.equal(escapeHtml(`it's "quoted"`), 'it&#39;s &quot;quoted&quot;');
  });

  it('leaves ordinary tag text untouched', () => {
    assert.equal(escapeHtml('2026年 项目/alpha'), '2026年 项目/alpha');
  });

  it('renders null and undefined as an empty string', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });

  it('stringifies non-string values', () => {
    assert.equal(escapeHtml(42), '42');
  });
});
