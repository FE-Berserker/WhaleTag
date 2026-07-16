import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { foldPath, CASE_INSENSITIVE_FS } from './path-fold';

describe('foldPath', () => {
  it('lowercases when caseInsensitive is true', () => {
    assert.equal(foldPath('/Foo/Bar/File.TXT', true), '/foo/bar/file.txt');
  });

  it('returns the path unchanged when caseInsensitive is false', () => {
    assert.equal(foldPath('/Foo/Bar/File.TXT', false), '/Foo/Bar/File.TXT');
  });

  it('default follows the platform FS semantics', () => {
    // Windows/macOS fold; Linux/other are exact. Either way it must agree with
    // the exported constant — the security guards rely on this single source.
    const p = '/MiXeD/Path';
    if (CASE_INSENSITIVE_FS) {
      assert.equal(foldPath(p), p.toLowerCase());
    } else {
      assert.equal(foldPath(p), p);
    }
  });
});
