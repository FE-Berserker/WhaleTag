import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRelativeImageSrc } from './resolve-image-src';

// Windows paths are used throughout: the HTML file's dirPath comes from the
// host's path utilities, which are Windows-style on the primary target.
const DIR = 'C:\\Users\\me\\docs';

describe('resolveRelativeImageSrc', () => {
  it('resolves a document-relative image under dirPath to whale-file', () => {
    assert.equal(
      resolveRelativeImageSrc('./pic.png', DIR),
      'whale-file:///C:/Users/me/docs/pic.png'
    );
    assert.equal(
      resolveRelativeImageSrc('pic.png', DIR),
      'whale-file:///C:/Users/me/docs/pic.png'
    );
  });

  it('resolves nested and normalized relative paths', () => {
    assert.equal(
      resolveRelativeImageSrc('images/pic.png', DIR),
      'whale-file:///C:/Users/me/docs/images/pic.png'
    );
    assert.equal(
      resolveRelativeImageSrc('images/./pic.png', DIR),
      'whale-file:///C:/Users/me/docs/images/pic.png'
    );
    // Inner `..` stays inside dirPath, so it is legal and normalized away.
    assert.equal(
      resolveRelativeImageSrc('images/../pic.png', DIR),
      'whale-file:///C:/Users/me/docs/pic.png'
    );
  });

  it('encodes spaces, CJK and reserved characters per segment', () => {
    assert.equal(
      resolveRelativeImageSrc('my pic.png', DIR),
      'whale-file:///C:/Users/me/docs/my%20pic.png'
    );
    assert.equal(
      resolveRelativeImageSrc('图片/示例.png', DIR),
      'whale-file:///C:/Users/me/docs/%E5%9B%BE%E7%89%87/%E7%A4%BA%E4%BE%8B.png'
    );
    // A literal `#` would start a fragment, so it must arrive percent-encoded.
    assert.equal(
      resolveRelativeImageSrc('a%23b.png', DIR),
      'whale-file:///C:/Users/me/docs/a%23b.png'
    );
  });

  it('strips query strings and fragments from the rewritten src', () => {
    assert.equal(
      resolveRelativeImageSrc('pic.png?v=2', DIR),
      'whale-file:///C:/Users/me/docs/pic.png'
    );
    assert.equal(
      resolveRelativeImageSrc('pic.png#frag', DIR),
      'whale-file:///C:/Users/me/docs/pic.png'
    );
  });

  it('rejects path traversal above dirPath', () => {
    for (const src of [
      '../secret.png',
      '../../etc/passwd.png',
      './../secret.png',
      'images/../../secret.png',
      '..\\..\\secret.png',
      // Percent-encoded traversal must be rejected after decoding.
      '%2e%2e/secret.png',
      '..%2Fsecret.png',
      '%2E%2E%2Fsecret.png',
      'images/%2e%2e/%2e%2e/secret.png',
    ]) {
      assert.equal(
        resolveRelativeImageSrc(src, DIR),
        null,
        `must not resolve traversal: ${src}`
      );
    }
  });

  it('rejects absolute paths, URLs and protocol-relative references', () => {
    for (const src of [
      'C:/Windows/pic.png',
      'C:\\Windows\\pic.png',
      '\\\\server\\share\\pic.png',
      '//server/share/pic.png',
      '/etc/pic.png',
      '\\rooted\\pic.png',
      'https://example.com/pic.png',
      'http://example.com/pic.png',
      'file:///C:/secret.png',
      'data:image/png;base64,AAAA',
      'blob:whale-extension://html-viewer/x',
      'javascript:alert(1)',
    ]) {
      assert.equal(
        resolveRelativeImageSrc(src, DIR),
        null,
        `must not resolve absolute reference: ${src}`
      );
    }
  });

  it('returns null without a dirPath or without a usable path', () => {
    assert.equal(resolveRelativeImageSrc('pic.png', undefined), null);
    assert.equal(resolveRelativeImageSrc('pic.png', null), null);
    assert.equal(resolveRelativeImageSrc('pic.png', ''), null);
    assert.equal(resolveRelativeImageSrc('', DIR), null);
    assert.equal(resolveRelativeImageSrc(null, DIR), null);
    assert.equal(resolveRelativeImageSrc('.', DIR), null);
    assert.equal(resolveRelativeImageSrc('./', DIR), null);
    assert.equal(resolveRelativeImageSrc('?v=1', DIR), null);
  });

  it('accepts POSIX-style and trailing-separator dirPaths', () => {
    assert.equal(
      resolveRelativeImageSrc('./pic.png', '/home/me/docs/'),
      'whale-file:///home/me/docs/pic.png'
    );
    // A Windows drive root must not turn into a drive-relative URL.
    assert.equal(
      resolveRelativeImageSrc('pic.png', 'C:\\'),
      'whale-file:///C:/pic.png'
    );
  });
});
