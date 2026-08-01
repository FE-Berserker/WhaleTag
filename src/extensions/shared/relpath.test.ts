import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  dirname,
  fileUrlToPath,
  isAbsoluteishPath,
  isExternalUrl,
  resolveRelative,
  toRelative,
} from './relpath';

describe('relpath.toRelative', () => {
  it('produces a ./ relative when the target is under the base (POSIX)', () => {
    assert.equal(
      toRelative('/a/b/sub/foo.png', '/a/b'),
      './sub/foo.png'
    );
  });

  it('produces a ./ relative when the target is directly in the base dir', () => {
    assert.equal(toRelative('/a/b/foo.png', '/a/b'), './foo.png');
  });

  it('handles Windows backslash paths and drive letters', () => {
    assert.equal(
      toRelative('C:\\Users\\me\\docs\\sub\\foo.png', 'C:\\Users\\me\\docs'),
      './sub/foo.png'
    );
  });

  it('normalizes mixed separators', () => {
    assert.equal(
      toRelative('C:/Users/me/docs\\sub/foo.png', 'C:\\Users/me\\docs'),
      './sub/foo.png'
    );
  });

  it('compares drive letters case-insensitively (Windows FS)', () => {
    // base on `c:` target on `C:` — same drive on a case-insensitive FS.
    assert.equal(
      toRelative('c:\\docs\\sub\\x', 'C:\\docs'),
      './sub/x'
    );
  });

  it('compares shared path segments case-insensitively on Windows', () => {
    // The P0-2 lesson: md writes ./Assets/x.png, disk has assets/x.png.
    assert.equal(
      toRelative('C:\\Docs\\Assets\\x.png', 'c:\\docs\\assets'),
      './x.png'
    );
  });

  it('compares POSIX segments case-sensitively (Linux FS)', () => {
    // On Linux `/Docs` ≠ `/docs` — a casing difference means a different dir,
    // so the target is NOT under the base → keep absolute (null).
    assert.equal(toRelative('/Docs/x.png', '/docs'), null);
  });

  it('returns null for a sibling/cousin target (would need ..)', () => {
    assert.equal(toRelative('/a/sibling/foo.png', '/a/b'), null);
    assert.equal(toRelative('/x/y', '/a/b'), null);
  });

  it('returns null across different roots (drives / POSIX vs UNC)', () => {
    assert.equal(toRelative('D:\\x', 'C:\\'), null);
    assert.equal(toRelative('//host/share/x', 'C:\\'), null);
    assert.equal(toRelative('/a/x', 'C:\\a'), null);
  });

  it('returns null for a UNC target under a different share', () => {
    assert.equal(
      toRelative('\\\\host\\share2\\x', '\\\\host\\share1'),
      null
    );
  });

  it('relativizes a UNC target under the same share', () => {
    assert.equal(
      toRelative('\\\\host\\share\\sub\\x', '\\\\host\\share'),
      './sub/x'
    );
  });

  it('handles CJK / non-ASCII path segments', () => {
    assert.equal(
      toRelative('C:\\项目\\素材\\鲸鱼.png', 'C:\\项目'),
      './素材/鲸鱼.png'
    );
  });

  it('tolerates a trailing separator on the base dir', () => {
    assert.equal(toRelative('/a/b/x', '/a/b/'), './x');
  });

  it('returns ./ when the target equals the base dir', () => {
    assert.equal(toRelative('/a/b', '/a/b'), './');
  });
});

describe('relpath.resolveRelative', () => {
  it('resolves a ./ relative against the base (POSIX)', () => {
    assert.equal(resolveRelative('./sub/foo.png', '/a/b'), '/a/b/sub/foo.png');
  });

  it('resolves a bare relative (no ./ prefix)', () => {
    assert.equal(resolveRelative('sub/foo.png', '/a/b'), '/a/b/sub/foo.png');
  });

  it('resolves a Windows relative against a backslash base', () => {
    assert.equal(
      resolveRelative('./sub/foo.png', 'C:\\Users\\me\\docs'),
      'C:/Users/me/docs/sub/foo.png'
    );
  });

  it('round-trips toRelative -> resolveRelative (POSIX)', () => {
    const rel = toRelative('/a/b/sub/deep/x.png', '/a/b');
    assert.equal(rel, './sub/deep/x.png');
    assert.equal(resolveRelative(rel!, '/a/b'), '/a/b/sub/deep/x.png');
  });

  it('round-trips toRelative -> resolveRelative (Windows, cross-case)', () => {
    const rel = toRelative('C:\\Docs\\Sub\\x.png', 'c:\\docs');
    assert.equal(resolveRelative(rel!, 'C:\\Docs'), 'C:/Docs/Sub/x.png');
  });

  it('returns an already-absolute path normalized to forward slashes', () => {
    assert.equal(resolveRelative('C:\\abs\\path', '/whatever'), 'C:/abs/path');
    assert.equal(resolveRelative('/abs/path', '/whatever'), '/abs/path');
  });

  it('passes external URLs through untouched', () => {
    assert.equal(
      resolveRelative('https://example.com/x', '/a/b'),
      'https://example.com/x'
    );
    assert.equal(resolveRelative('mailto:a@b.com', '/a/b'), 'mailto:a@b.com');
  });

  it('resolves CJK relative segments', () => {
    assert.equal(
      resolveRelative('./素材/鲸鱼.png', 'C:\\项目'),
      'C:/项目/素材/鲸鱼.png'
    );
  });
});

describe('relpath.isAbsoluteishPath / isExternalUrl', () => {
  it('flags drive, POSIX-root, and UNC as absolute', () => {
    assert.ok(isAbsoluteishPath('C:\\x'));
    assert.ok(isAbsoluteishPath('C:/x'));
    assert.ok(isAbsoluteishPath('/x'));
    assert.ok(isAbsoluteishPath('\\\\host\\share\\x'));
    assert.ok(isAbsoluteishPath('//host/share/x'));
  });

  it('does not flag relative segments as absolute', () => {
    assert.ok(!isAbsoluteishPath('sub/x'));
    assert.ok(!isAbsoluteishPath('./x'));
    assert.ok(!isAbsoluteishPath('../x'));
  });

  it('treats http/https/ftp/mailto as external but file: as ours', () => {
    assert.ok(isExternalUrl('https://x'));
    assert.ok(isExternalUrl('http://x'));
    assert.ok(isExternalUrl('ftp://x'));
    assert.ok(isExternalUrl('mailto:a@b'));
    assert.ok(!isExternalUrl('file:///C:/x'));
    assert.ok(!isExternalUrl('./sub/x'));
    assert.ok(!isExternalUrl('C:\\abs'));
  });
});

describe('relpath.dirname', () => {
  it('returns the directory of a nested path', () => {
    assert.equal(dirname('/a/b/c.drawio'), '/a/b');
    assert.equal(dirname('C:\\Users\\me\\d.drawio'), 'C:/Users/me');
  });

  it('returns the drive root for a file directly under it', () => {
    assert.equal(dirname('C:\\d.drawio'), 'C:/');
  });

  it('returns POSIX root for a top-level file', () => {
    assert.equal(dirname('/d.drawio'), '/');
  });

  it('returns . for a bare filename', () => {
    assert.equal(dirname('d.drawio'), '.');
  });

  it('drops trailing separators before computing', () => {
    assert.equal(dirname('/a/b/'), '/a');
  });
});

describe('relpath.fileUrlToPath', () => {
  it('decodes a POSIX file:// URL back to an absolute path', () => {
    assert.equal(fileUrlToPath('file:///Users/me/x.png'), '/Users/me/x.png');
  });

  it('decodes a Windows file:// URL and keeps the drive letter', () => {
    assert.equal(
      fileUrlToPath('file:///C:/Users/me/x.drawio'),
      'C:/Users/me/x.drawio'
    );
  });

  it('decodes percent-encoded segments (spaces, CJK)', () => {
    assert.equal(
      fileUrlToPath('file:///C:/foo%20bar/%E9%B2%B8%E9%B1%BC.png'),
      'C:/foo bar/鲸鱼.png'
    );
  });

  it('round-trips toFileUrl (POSIX) -> fileUrlToPath', () => {
    // Inline copy of toFileUrl's contract to avoid importing drop-xml (which
    // needs DOM globals). Mirrors drop-xml.toFileUrl exactly.
    const toFileUrl = (absolutePath: string): string => {
      const segments = absolutePath.split(/[\\/]/).map(encodeURIComponent);
      if (segments[0] === '') segments.shift();
      const joined = segments.join('/');
      return `file:///${joined.replace(/^(\w)%3A/, '$1:')}`;
    };
    const posix = '/Users/me/report.pdf';
    assert.equal(fileUrlToPath(toFileUrl(posix)), posix);
    const win = 'C:\\foo bar\\baz.pdf';
    assert.equal(fileUrlToPath(toFileUrl(win)), 'C:/foo bar/baz.pdf');
  });

  it('returns the input unchanged when it is not a file: URL', () => {
    assert.equal(fileUrlToPath('./sub/x.png'), './sub/x.png');
    assert.equal(fileUrlToPath('https://x'), 'https://x');
  });
});
