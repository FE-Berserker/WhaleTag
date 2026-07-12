import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { quotePathForShell } from './shell-quote';

/**
 * Path quoting for the user-command feature. The path the user right-clicks is
 * the untrusted input, so it must be quoted before landing in a shell string.
 * These lock the two platform branches (POSIX single-quote + Windows cmd
 * double-quote) that `substituteAndQuote` relies on.
 */
describe('quotePathForShell — POSIX (single-quote)', () => {
  it('wraps a plain path in single quotes', () => {
    assert.equal(quotePathForShell('/tmp/foo.txt', 'linux'), "'/tmp/foo.txt'");
  });

  it('keeps spaces verbatim inside the single quotes', () => {
    assert.equal(
      quotePathForShell('/tmp/my dir/foo.txt', 'linux'),
      "'/tmp/my dir/foo.txt'"
    );
  });

  it("close-reopens on an embedded single quote", () => {
    assert.equal(quotePathForShell("foo'bar", 'linux'), "'foo'\\''bar'");
  });

  it("returns '' for an empty value", () => {
    assert.equal(quotePathForShell('', 'linux'), "''");
  });
});

describe('quotePathForShell — Windows cmd (double-quote)', () => {
  it('returns a path with no special chars unchanged', () => {
    assert.equal(quotePathForShell('C:\\foo.txt', 'win32'), 'C:\\foo.txt');
  });

  it('double-quotes a path containing a space', () => {
    assert.equal(
      quotePathForShell('C:\\my dir\\foo.txt', 'win32'),
      '"C:\\my dir\\foo.txt"'
    );
  });

  it('doubles an embedded double-quote', () => {
    assert.equal(quotePathForShell('C:\\a"b', 'win32'), '"C:\\a""b"');
  });

  it('returns "" for an empty value', () => {
    assert.equal(quotePathForShell('', 'win32'), '""');
  });
});
