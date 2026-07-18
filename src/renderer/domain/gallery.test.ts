import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mediaPlaylist, wrapIndex, isMediaEntry } from './gallery';
import type { DirEntry } from '../../shared/ipc-types';

/** Minimal DirEntry factory for the gallery filtering tests. */
function entry(name: string, isDirectory = false): DirEntry {
  const dot = name.lastIndexOf('.');
  return {
    name,
    path: `/root/${name}`,
    isFile: !isDirectory,
    isDirectory,
    size: 0,
    modified: '1970-01-01T00:00:00.000Z',
    extension: dot >= 0 ? name.slice(dot + 1).toLowerCase() : '',
  };
}

describe('gallery playlist building', () => {
  it('keeps only image/video files, dropping folders and other files', () => {
    const entries = [
      entry('photos', true),
      entry('a.jpg'),
      entry('notes.txt'),
      entry('clip.mp4'),
      entry('b.PNG'),
      entry('archive.zip'),
    ];
    const playlist = mediaPlaylist(entries);
    assert.deepEqual(
      playlist.map((e) => e.name),
      ['a.jpg', 'clip.mp4', 'b.PNG']
    );
  });

  it('preserves the incoming (sorted) order', () => {
    const entries = [entry('c.gif'), entry('a.webp'), entry('b.mov')];
    assert.deepEqual(
      mediaPlaylist(entries).map((e) => e.name),
      ['c.gif', 'a.webp', 'b.mov']
    );
  });

  it('returns empty for a folder with no media', () => {
    assert.deepEqual(mediaPlaylist([entry('readme.md'), entry('sub', true)]), []);
  });

  it('rejects a directory that happens to be named like an image', () => {
    assert.equal(isMediaEntry(entry('weird.jpg', true)), false);
    assert.equal(isMediaEntry(entry('weird.jpg')), true);
  });
});

describe('gallery circular navigation (wrapIndex)', () => {
  it('wraps past the end back to the start', () => {
    assert.equal(wrapIndex(3, 3), 0);
    assert.equal(wrapIndex(4, 3), 1);
  });

  it('wraps before the start to the end (negative)', () => {
    assert.equal(wrapIndex(-1, 3), 2);
    assert.equal(wrapIndex(-3, 3), 0);
    assert.equal(wrapIndex(-4, 3), 2);
  });

  it('is identity within range', () => {
    assert.equal(wrapIndex(0, 5), 0);
    assert.equal(wrapIndex(2, 5), 2);
    assert.equal(wrapIndex(4, 5), 4);
  });

  it('returns 0 for an empty playlist', () => {
    assert.equal(wrapIndex(0, 0), 0);
    assert.equal(wrapIndex(5, 0), 0);
    assert.equal(wrapIndex(-1, 0), 0);
  });

  it('completes a full forward loop over a 3-item playlist', () => {
    const len = 3;
    let i = 0;
    const seen: number[] = [];
    for (let step = 0; step < 5; step += 1) {
      seen.push(i);
      i = wrapIndex(i + 1, len);
    }
    assert.deepEqual(seen, [0, 1, 2, 0, 1]);
  });
});
