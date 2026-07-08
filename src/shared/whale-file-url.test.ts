import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWhaleFileUrl, decodeWhaleFileUrl } from './whale-file-url';

/**
 * Round-trip tests for the `whale-file://` URL format shared between the
 * renderer (encoder in MediaLightbox) and the main process (decoder in
 * `registerWhaleFileProtocol`). A single mismatch between the two ends means
 * a video fails to load — these tests pin the format down so a future
 * refactor of either side breaks loudly in CI rather than at runtime.
 *
 * The format mirrors WHATWG file URL semantics:
 *   C:\Users\foo\bar.mp4 -> whale-file:///C:/Users/foo/bar.mp4
 *   /home/foo/bar.mp4    -> whale-file:///home/foo/bar.mp4
 */

describe('encodeWhaleFileUrl', () => {
  it('returns null for empty input', () => {
    assert.equal(encodeWhaleFileUrl(''), null);
  });

  it('returns null for relative paths', () => {
    // Without a leading `/` or drive letter, the encoder can't tell whether
    // the input is a path or a hostname.
    assert.equal(encodeWhaleFileUrl('foo/bar.mp4'), null);
    assert.equal(encodeWhaleFileUrl('./relative.mp4'), null);
  });

  it('encodes a POSIX absolute path', () => {
    assert.equal(
      encodeWhaleFileUrl('/home/foo/bar.mp4'),
      'whale-file:///home/foo/bar.mp4'
    );
  });

  it('normalizes Windows backslashes to forward slashes', () => {
    assert.equal(
      encodeWhaleFileUrl('C:\\Users\\foo\\bar.mp4'),
      'whale-file:///C:/Users/foo/bar.mp4'
    );
  });

  it('keeps the drive-letter colon literal (not %3A)', () => {
    // `encodeURIComponent('C:')` would emit `C%3A`, which is unreadable and
    // confuses Chromium's URL parser. The encoder undoes that escape on
    // the drive segment specifically.
    const encoded = encodeWhaleFileUrl('C:\\Users\\foo\\bar.mp4');
    assert.ok(encoded);
    assert.ok(encoded.includes('C:/'), 'drive segment should keep the colon');
    assert.ok(!encoded.includes('C%3A'), 'drive segment must not be %3A-encoded');
  });

  it('percent-encodes spaces, non-ASCII, and other reserved chars', () => {
    assert.equal(
      encodeWhaleFileUrl('/home/foo/bar baz.mp4'),
      'whale-file:///home/foo/bar%20baz.mp4'
    );
    assert.equal(
      encodeWhaleFileUrl('/home/foo/中文.mp4'),
      'whale-file:///home/foo/%E4%B8%AD%E6%96%87.mp4'
    );
    assert.equal(
      encodeWhaleFileUrl('/home/foo/100%25.mp4'),
      'whale-file:///home/foo/100%2525.mp4'
    );
  });
});

describe('decodeWhaleFileUrl', () => {
  it('returns null for non-whale-file URLs', () => {
    assert.equal(decodeWhaleFileUrl('http://example.com/foo'), null);
    assert.equal(decodeWhaleFileUrl('file:///etc/passwd'), null);
  });

  it('returns null for malformed input', () => {
    assert.equal(decodeWhaleFileUrl('not a url'), null);
  });

  it('decodes a POSIX URL back to a POSIX path', () => {
    assert.equal(
      decodeWhaleFileUrl('whale-file:///home/foo/bar.mp4'),
      '/home/foo/bar.mp4'
    );
  });

  it('decodes a Windows URL back to a Windows path (with forward slashes)', () => {
    // Decoder returns forward slashes — Node's fs accepts those on Windows.
    assert.equal(
      decodeWhaleFileUrl('whale-file:///C:/Users/foo/bar.mp4'),
      'C:/Users/foo/bar.mp4'
    );
  });

  it('decodes percent-encoded segments symmetrically', () => {
    assert.equal(
      decodeWhaleFileUrl('whale-file:///home/foo/bar%20baz.mp4'),
      '/home/foo/bar baz.mp4'
    );
    assert.equal(
      decodeWhaleFileUrl('whale-file:///home/foo/%E4%B8%AD%E6%96%87.mp4'),
      '/home/foo/中文.mp4'
    );
  });

  it('survives malformed percent escapes (returns segment as-is)', () => {
    // `decodeURIComponent('%ZZ')` throws; we must not propagate that to the
    // main-process handler or it would 500. Decoded form keeps the raw `%ZZ`
    // and the path resolution / allowed-roots check fails naturally with 404.
    const result = decodeWhaleFileUrl('whale-file:///home/foo/%ZZ.mp4');
    assert.equal(result, '/home/foo/%ZZ.mp4');
  });
});

describe('encode/decode round-trip', () => {
  // Each entry is a path that should survive a full round-trip through both
  // functions without losing data. The platform-agnostic cases run on every
  // OS; the Windows cases are skipped on POSIX hosts because the decoder
  // always returns the literal `C:` drive segment on any platform, but
  // checking the round-trip is still meaningful.
  const cases: Array<{ name: string; path: string }> = [
    { name: 'simple POSIX path', path: '/home/foo/bar.mp4' },
    { name: 'POSIX with spaces', path: '/home/foo/bar baz.mp4' },
    { name: 'POSIX with non-ASCII', path: '/home/foo/中文.mp4' },
    { name: 'POSIX with literal percent', path: '/home/foo/100%complete.mp4' },
    { name: 'POSIX with emoji', path: '/home/foo/🎬.mp4' },
    { name: 'POSIX with question mark', path: '/home/foo/what?.mp4' },
    { name: 'POSIX with hash', path: '/home/foo/sig#.mp4' },
    { name: 'POSIX deep nesting', path: '/a/b/c/d/e/f/g/file.mp4' },
  ];

  for (const tc of cases) {
    it(`round-trips: ${tc.name}`, () => {
      const encoded = encodeWhaleFileUrl(tc.path);
      assert.ok(encoded, `encoder must accept ${tc.path}`);
      const decoded = decodeWhaleFileUrl(encoded);
      assert.equal(decoded, tc.path);
    });
  }

  // Windows cases — round-trip works on any host because both encoder and
  // decoder normalize backslashes to forward slashes and strip the synthetic
  // leading slash on the decoded side.
  const windowsCases: Array<{ name: string; path: string }> = [
    { name: 'simple Windows path', path: 'C:\\Users\\foo\\bar.mp4' },
    { name: 'Windows with spaces', path: 'D:\\My Videos\\clip 1.mp4' },
    { name: 'Windows with non-ASCII', path: 'C:\\用户\\测试.mp4' },
  ];

  for (const tc of windowsCases) {
    it(`round-trips: ${tc.name}`, () => {
      const encoded = encodeWhaleFileUrl(tc.path);
      assert.ok(encoded, `encoder must accept ${tc.path}`);
      // After round-trip the path uses forward slashes (Node's fs accepts
      // those on Windows), but the segment content is preserved.
      const decoded = decodeWhaleFileUrl(encoded);
      const expected = tc.path.replace(/\\/g, '/');
      assert.equal(decoded, expected);
    });
  }
});