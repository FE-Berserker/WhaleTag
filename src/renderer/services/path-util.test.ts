import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  basename,
  joinPath,
  pathSegments,
  isSameOrDescendant,
  parentDir,
} from './path-util';

describe('renderer path-util', () => {
  describe('basename', () => {
    it('returns the final segment', () => {
      assert.equal(basename('/foo/bar/baz.txt'), 'baz.txt');
      assert.equal(basename('C:\\foo\\bar'), 'bar');
    });

    it('returns empty for empty or root paths', () => {
      assert.equal(basename(''), '');
      assert.equal(basename('/'), '');
    });
  });

  describe('joinPath', () => {
    it('joins POSIX paths', () => {
      assert.equal(joinPath('/foo', 'bar'), '/foo/bar');
      assert.equal(joinPath('/foo/', 'bar'), '/foo/bar');
      assert.equal(joinPath('/foo', '/bar'), '/foo/bar');
    });

    it('joins Windows paths', () => {
      assert.equal(joinPath('C:\\foo', 'bar'), 'C:\\foo\\bar');
      assert.equal(joinPath('C:\\foo\\', 'bar'), 'C:\\foo\\bar');
      assert.equal(joinPath('C:\\foo', '\\bar'), 'C:\\foo\\bar');
    });

    it('preserves the separator style of the base', () => {
      assert.equal(joinPath('C:\\foo', 'bar/baz'), 'C:\\foo\\bar\\baz');
      assert.equal(joinPath('/foo', 'bar\\baz'), '/foo/bar/baz');
    });
  });

  describe('pathSegments', () => {
    it('splits absolute paths', () => {
      assert.deepEqual(pathSegments('/foo/bar/baz'), ['foo', 'bar', 'baz']);
      assert.deepEqual(pathSegments('C:\\foo\\bar'), ['C:', 'foo', 'bar']);
    });

    it('drops empty segments', () => {
      assert.deepEqual(pathSegments('/foo//bar/'), ['foo', 'bar']);
    });
  });

  describe('isSameOrDescendant', () => {
    it('returns true for identical paths', () => {
      assert.ok(isSameOrDescendant('/foo/bar', '/foo/bar'));
      assert.ok(isSameOrDescendant('C:\\foo\\bar', 'C:\\foo\\bar'));
    });

    it('returns true for descendants', () => {
      assert.ok(isSameOrDescendant('/foo/bar', '/foo/bar/baz'));
      assert.ok(isSameOrDescendant('/foo/bar', '/foo/bar/baz/qux'));
    });

    it('returns false for siblings, parents, or unrelated paths', () => {
      assert.ok(!isSameOrDescendant('/foo/bar', '/foo/baz'));
      assert.ok(!isSameOrDescendant('/foo/bar', '/foo'));
      assert.ok(!isSameOrDescendant('/foo/bar', '/'));
      assert.ok(!isSameOrDescendant('/foo/bar', '/qux/bar'));
    });

    it('does not match partial segment names', () => {
      assert.ok(!isSameOrDescendant('/foo/bar', '/foo/bartender'));
    });

    it('handles mixed separators', () => {
      assert.ok(isSameOrDescendant('C:/foo/bar', 'C:\\foo\\bar\\baz'));
      assert.ok(isSameOrDescendant('/foo/bar', '\\foo\\bar\\baz'));
    });

    it('is case-insensitive', () => {
      assert.ok(isSameOrDescendant('/Foo/Bar', '/foo/bar/baz'));
      assert.ok(
        isSameOrDescendant('C:\\Users\\Name', 'c:\\users\\name\\file.txt')
      );
      assert.ok(!isSameOrDescendant('/Foo/Bar', '/foo/bartender'));
    });
  });

  describe('parentDir', () => {
    it('returns the parent directory preserving separators', () => {
      assert.equal(parentDir('/foo/bar/baz.txt'), '/foo/bar');
      assert.equal(parentDir('C:\\foo\\bar\\baz.txt'), 'C:\\foo\\bar');
    });

    it('returns empty for roots or single-segment paths', () => {
      assert.equal(parentDir('/foo'), '/');
      assert.equal(parentDir('C:\\foo'), 'C:\\');
      assert.equal(parentDir('/'), '');
      assert.equal(parentDir(''), '');
    });

    it('handles trailing separators', () => {
      assert.equal(parentDir('/foo/bar/'), '/foo');
      assert.equal(parentDir('C:\\foo\\bar\\'), 'C:\\foo');
    });
  });
});
