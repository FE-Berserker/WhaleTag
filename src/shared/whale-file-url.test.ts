import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeWhaleFileUrl,
  decodeWhaleFileUrl,
  encodeWhaleAudioUrl,
  decodeWhaleAudioUrl,
} from './whale-file-url';

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

  it('encodes a UNC share (\\\\server\\share\\...) as host + path', () => {
    // WHATWG file:// UNC semantics: the server becomes the URL host. The old
    // four-slash `whale-file:////server/...` form was mangled by Chromium's
    // GURL (server folded into a lowercased host) and the server was lost on
    // decode, producing a 403.
    assert.equal(
      encodeWhaleFileUrl('\\\\server\\share\\file.flac'),
      'whale-file://server/share/file.flac'
    );
  });

  it('lowercases the UNC server (URL host semantics)', () => {
    assert.equal(
      encodeWhaleFileUrl('\\\\FE-cat\\share\\file.flac'),
      'whale-file://fe-cat/share/file.flac'
    );
  });

  it('percent-encodes UNC share/path segments (CJK, spaces)', () => {
    assert.equal(
      encodeWhaleFileUrl('\\\\FE-cat\\003_文档\\久石让\\The Best Collection.flac'),
      'whale-file://fe-cat/003_%E6%96%87%E6%A1%A3/%E4%B9%85%E7%9F%B3%E8%AE%A9/The%20Best%20Collection.flac'
    );
  });

  it('returns null for a UNC share with a non-ASCII server', () => {
    // A CJK server would be Punycode-mangled by Chromium's host parser into
    // a name SMB can't reach. Reject explicitly so the caller shows
    // 'streaming URL unavailable' instead of a silent bad URL.
    assert.equal(encodeWhaleFileUrl('\\\\服务器\\share\\file.flac'), null);
  });

  it('returns null for a bare UNC server with no share', () => {
    assert.equal(encodeWhaleFileUrl('\\\\server'), null);
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

  it('decodes a Chromium-normalized drive-letter URL (whale-file://c/...) back to C:/...', () => {
    // Chromium normalizes `whale-file:///C:/path` (a standard scheme) to
    // `whale-file://c/path` — it treats the Windows drive letter as the URL
    // host (lowercased). The decoder MUST recognize a single-letter host as a
    // drive (not an SMB server), or it rebuilds UNC `//c/...` → lstat `\\c\`
    // → 403/404. This is the exact regression that broke md-editor pasted
    // images (img src whale-file:///C:/... → request whale-file://c/...).
    assert.equal(
      decodeWhaleFileUrl('whale-file://c/WhaleTag/Test/image.png'),
      'C:/WhaleTag/Test/image.png'
    );
  });

  it('decodes a UNC URL back to //server/share (recovers the host)', () => {
    // Chromium normalizes the host to lowercase. The decoder MUST read
    // `url.hostname` (not just `pathname`) or the server is lost — the exact
    // regression that caused 403 on UNC shares.
    assert.equal(
      decodeWhaleFileUrl('whale-file://fe-cat/003_%E6%96%87%E6%A1%A3/file.flac'),
      '//fe-cat/003_文档/file.flac'
    );
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

  // UNC shares (\\server\share\...). The URL host parser lowercases the
  // server (Windows SMB is case-insensitive), so the round-trip lowercases
  // the whole path for the assertion; share/path segment content is preserved.
  const uncCases: Array<{ name: string; path: string }> = [
    { name: 'simple UNC share', path: '\\\\server\\share\\file.flac' },
    { name: 'UNC with uppercase server', path: '\\\\FE-cat\\share\\file.flac' },
    {
      name: 'UNC with CJK share/path',
      path: '\\\\FE-cat\\003_文档\\久石让\\track.flac',
    },
    { name: 'UNC with spaces', path: '\\\\server\\my share\\foo bar.flac' },
    { name: 'UNC with literal percent', path: '\\\\server\\share\\100%file.flac' },
    {
      name: 'UNC deep nesting',
      path: '\\\\server\\share\\a\\b\\c\\d\\file.flac',
    },
  ];

  for (const tc of uncCases) {
    it(`round-trips: ${tc.name}`, () => {
      const encoded = encodeWhaleFileUrl(tc.path);
      assert.ok(encoded, `encoder must accept ${tc.path}`);
      const decoded = decodeWhaleFileUrl(encoded);
      const expected = tc.path.replace(/\\/g, '/').toLowerCase();
      assert.equal(decoded, expected);
    });
  }
});

/**
 * `whale-audio://` uses the SAME byte format as `whale-file://` — only the
 * scheme prefix differs — so the host dispatches to the live-Opus-transcode
 * handler. These tests pin that the two schemes share format but stay
 * isolated (a whale-file URL must NOT decode as whale-audio and vice versa,
 * else a transcode stream could be served for a plain file request).
 */
describe('encodeWhaleAudioUrl', () => {
  it('uses the whale-audio scheme', () => {
    assert.equal(
      encodeWhaleAudioUrl('/home/foo/track.ape'),
      'whale-audio:///home/foo/track.ape'
    );
    assert.equal(
      encodeWhaleAudioUrl('C:\\Users\\foo\\track.ape'),
      'whale-audio:///C:/Users/foo/track.ape'
    );
  });

  it('returns null for relative / empty input', () => {
    assert.equal(encodeWhaleAudioUrl(''), null);
    assert.equal(encodeWhaleAudioUrl('track.ape'), null);
  });
});

describe('decodeWhaleAudioUrl', () => {
  it('round-trips POSIX + Windows paths', () => {
    assert.equal(
      decodeWhaleAudioUrl('whale-audio:///home/foo/track.ape'),
      '/home/foo/track.ape'
    );
    assert.equal(
      decodeWhaleAudioUrl('whale-audio:///C:/Users/foo/track.ape'),
      'C:/Users/foo/track.ape'
    );
  });

  it('rejects whale-file URLs (cross-scheme isolation)', () => {
    assert.equal(
      decodeWhaleAudioUrl('whale-file:///home/foo/track.ape'),
      null
    );
  });

  it('rejects non-whale-audio URLs', () => {
    assert.equal(decodeWhaleAudioUrl('http://example.com/track.ape'), null);
    assert.equal(decodeWhaleAudioUrl('not a url'), null);
  });
});

describe('whale-file vs whale-audio scheme isolation', () => {
  it('decodeWhaleFileUrl rejects whale-audio URLs', () => {
    assert.equal(
      decodeWhaleFileUrl('whale-audio:///home/foo/track.ape'),
      null
    );
  });

  it('both schemes round-trip the same path bytes', () => {
    const p = '/home/foo/中文 track.ape';
    assert.equal(decodeWhaleAudioUrl(encodeWhaleAudioUrl(p)), p);
    assert.equal(decodeWhaleFileUrl(encodeWhaleFileUrl(p)), p);
  });

  it('both schemes round-trip a UNC path', () => {
    const p = '\\\\FE-cat\\share\\中文 track.ape';
    const expected = p.replace(/\\/g, '/').toLowerCase();
    assert.equal(decodeWhaleFileUrl(encodeWhaleFileUrl(p)), expected);
    assert.equal(decodeWhaleAudioUrl(encodeWhaleAudioUrl(p)), expected);
  });

  it('decodeWhaleAudioUrl rejects whale-file UNC URLs (and vice versa)', () => {
    assert.equal(
      decodeWhaleAudioUrl('whale-file://server/share/track.ape'),
      null
    );
    assert.equal(
      decodeWhaleFileUrl('whale-audio://server/share/track.ape'),
      null
    );
  });
});