import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BINARY_EXT,
  DRAWIO_EXT,
  isAudioFile,
  isBinaryExtension,
  isDrawioFile,
} from './whale-meta';

/**
 * Regression guard for H.17 bug #1.
 *
 * Symptom: opening any `.drawio` / `.dio` file in Whale surfaced drawio's
 * "非绘图文件" / "Not a drawing file" panel with a raw DOMParser error:
 *   "error on line 1 at column 1: Start tag expected, '<' not found"
 *
 * Root cause: `BINARY_EXT` in `whale-meta.ts` mistakenly included
 * `DRAWIO_EXT`. The host (`ExtensionContextProvider.readFileContent`) saw
 * the drawio extension, walked `isBinaryExtension('drawio') === true`, read
 * the file as ArrayBuffer and pushed the bytes as base64 to the extension.
 * `useWhaleBridge` stored `file.content` (the base64 string) verbatim, and
 * `app.tsx` handed it straight to `bridge.loadXml(...)`. drawio's embed
 * tried to parse `PD94bWwgdmVy...` as XML and threw on the first character.
 *
 * Fix (this test + the corresponding edit in `whale-meta.ts`): keep drawio
 * OUT of `BINARY_EXT` so the host reads it as UTF-8 text via
 * `ipcApi.readTextFile`. Tests below lock the invariant so future refactors
 * (e.g. re-grouping EXT sets, adding helper builders) can't silently put
 * `DRAWIO_EXT` back into `BINARY_EXT`.
 */
describe('BINARY_EXT excludes text formats consumed as raw strings', () => {
  it('does not include drawio / dio (mxfile is UTF-8 XML)', () => {
    // H.17 bug #1: must remain out of BINARY_EXT for drawio to open at all.
    assert.equal(
      BINARY_EXT.has('drawio'),
      false,
      'drawio must NOT be in BINARY_EXT — host would push base64, loadXml fails'
    );
    assert.equal(
      BINARY_EXT.has('dio'),
      false,
      'dio must NOT be in BINARY_EXT — same path as drawio'
    );
  });

  it('isBinaryExtension returns false for drawio / dio', () => {
    // Belt-and-suspenders: even if someone introduces an alias or wrapper,
    // the public predicate must agree.
    assert.equal(isBinaryExtension('drawio'), false);
    assert.equal(isBinaryExtension('dio'), false);
    assert.equal(isBinaryExtension('DRAWIO'), false, 'case-insensitive');
    assert.equal(isBinaryExtension('DIO'), false, 'case-insensitive');
  });

  it('isDrawioFile still recognises drawio / dio', () => {
    // Sanity: removing from BINARY_EXT must not break the drawio dispatch.
    assert.equal(isDrawioFile('Diagram.drawio'), true);
    assert.equal(isDrawioFile('Diagram.dio'), true);
    assert.equal(DRAWIO_EXT.has('drawio'), true);
    assert.equal(DRAWIO_EXT.has('dio'), true);
  });

  it('does not include other text formats extensions consume raw', () => {
    // Same shape of bug as drawio: if any of these end up in BINARY_EXT the
    // matching extension will receive base64 and break in the same way.
    assert.equal(BINARY_EXT.has('excalidraw'), false, 'excalidraw JSON');
    assert.equal(BINARY_EXT.has('md'), false, 'markdown');
    assert.equal(BINARY_EXT.has('html'), false, 'html');
    assert.equal(BINARY_EXT.has('htm'), false, 'htm alias');
    assert.equal(BINARY_EXT.has('txt'), false, 'plain text');
    assert.equal(BINARY_EXT.has('json'), false, 'json');
    assert.equal(BINARY_EXT.has('xml'), false, 'xml');
    assert.equal(BINARY_EXT.has('csv'), false, 'csv');
  });

  it('still includes the genuinely-binary sets it always did', () => {
    // Negative coverage: removing DRAWIO_EXT shouldn't accidentally remove
    // anything else. If any of these flip to false the diff is too broad.
    const mustStayBinary = [
      'jpg', 'png', 'svg',           // IMAGE_EXT
      'mp4', 'mov',                  // VIDEO_EXT
      'pdf',                         // PDF_EXT
      'docx', 'xlsx', 'pptx',        // OFFICE_EXT
      'epub', 'mobi',                // EBOOK_EXT
      'zip', 'tar', 'tgz', 'gz', '7z', // ARCHIVE_EXT
      'stl', 'obj', 'glb', 'dxf', 'step', 'dwg', // CAD_EXT
      'mp3', 'wav', 'flac',          // audio literals
    ];
    for (const ext of mustStayBinary) {
      assert.equal(
        BINARY_EXT.has(ext),
        true,
        `${ext} must remain in BINARY_EXT — binary content, base64 transport`
      );
    }
  });
});

describe('isAudioFile', () => {
  // Used by EntryContextMenu / DirectoryTree to decide whether to surface the
  // "Play in background" / "Play this folder" right-click items. Anything
  // media-player can decode (native OR after ffmpeg transcode) counts.

  it('returns true for native-playable audio', () => {
    assert.equal(isAudioFile('track.mp3'), true);
    assert.equal(isAudioFile('track.ogg'), true);
    assert.equal(isAudioFile('track.wav'), true);
    assert.equal(isAudioFile('track.flac'), true);
    assert.equal(isAudioFile('track.aac'), true);
    assert.equal(isAudioFile('track.m4a'), true);
    assert.equal(isAudioFile('track.opus'), true);
  });

  it('returns true for transcode-only audio', () => {
    // APE / WMA / AIFF / etc. — needs ffmpeg. The dock ffmpeg-transcodes
    // these on demand (transcode-cache.ts), so they're still audio as far
    // as the dock / right-click menu is concerned.
    assert.equal(isAudioFile('lossless.ape'), true);
    assert.equal(isAudioFile('legacy.wma'), true);
    assert.equal(isAudioFile('cd.aiff'), true);
    assert.equal(isAudioFile('voicemail.amr'), true);
    assert.equal(isAudioFile('surround.ac3'), true);
    assert.equal(isAudioFile('surround.dts'), true);
    assert.equal(isAudioFile('tracker.mpc'), true);
    assert.equal(isAudioFile('archive.wv'), true);
    assert.equal(isAudioFile('dsd.dsf'), true);
  });

  it('is case-insensitive on the extension', () => {
    assert.equal(isAudioFile('track.MP3'), true);
    assert.equal(isAudioFile('track.FlAc'), true);
    assert.equal(isAudioFile('lossless.APE'), true);
  });

  it('returns false for video / image / document / text', () => {
    assert.equal(isAudioFile('movie.mp4'), false);
    assert.equal(isAudioFile('movie.mkv'), false);
    assert.equal(isAudioFile('photo.jpg'), false);
    assert.equal(isAudioFile('doc.pdf'), false);
    assert.equal(isAudioFile('notes.txt'), false);
    assert.equal(isAudioFile('archive.zip'), false);
  });

  it('returns false for files without an extension', () => {
    assert.equal(isAudioFile('README'), false);
    assert.equal(isAudioFile(''), false);
  });
});