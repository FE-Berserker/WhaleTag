import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  annotationsPathFor,
  readEbookAnnotations,
  writeEbookAnnotations,
} from './ebook-annotations';
import { defaultEbookAnnotations, type EbookAnnotations } from '../shared/ebook-annotations';

function mkEbook(dir: string, name: string): string {
  const full = path.join(dir, name);
  writeFileSync(full, 'fake-bytes');
  return full;
}

describe('ebook-annotations', () => {
  let workDir: string;
  before(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'whale-ebook-anno-'));
  });
  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('round-trips non-default annotations', async () => {
    const ebook = mkEbook(workDir, 'book.epub');
    const sample: EbookAnnotations = {
      ...defaultEbookAnnotations(),
      prefs: {
        ...defaultEbookAnnotations().prefs,
        theme: 'sepia',
        fontSize: 22,
        scrollMode: 'continuous',
      },
      highlights: [
        {
          id: 'h1',
          chapterId: 'ch1',
          start: 10,
          end: 25,
          text: 'call me Ishmael',
          color: 'yellow',
          createdAt: '2026-07-02T10:00:00.000Z',
        },
      ],
      bookmarks: [
        {
          id: 'b1',
          chapterId: 'ch1',
          scrollRatio: 0.42,
          createdAt: '2026-07-02T10:01:00.000Z',
        },
      ],
      notes: [],
    };

    await writeEbookAnnotations(ebook, sample);
    const read = await readEbookAnnotations(ebook);
    assert.ok(read, 'should read back non-null');
    assert.equal(read.prefs.theme, 'sepia');
    assert.equal(read.prefs.fontSize, 22);
    assert.equal(read.prefs.scrollMode, 'continuous');
    assert.equal(read.highlights.length, 1);
    assert.equal(read.highlights[0].text, 'call me Ishmael');
    assert.equal(read.bookmarks.length, 1);
    assert.equal(read.bookmarks[0].scrollRatio, 0.42);
    assert.equal(read.version, 1);
    // updatedAt should be re-stamped by writeEbookAnnotations
    assert.notEqual(read.updatedAt, sample.updatedAt);
  });

  it('returns null when the file is missing', async () => {
    const ebook = mkEbook(workDir, 'no-anno.epub');
    const read = await readEbookAnnotations(ebook);
    assert.equal(read, null);
  });

  it('returns null when the file is malformed', async () => {
    const ebook = mkEbook(workDir, 'bad.epub');
    const target = annotationsPathFor(ebook);
    require('fs').mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, '{not json');
    const read = await readEbookAnnotations(ebook);
    assert.equal(read, null);
  });

  it('returns null when version is unsupported', async () => {
    const ebook = mkEbook(workDir, 'v2.epub');
    const target = annotationsPathFor(ebook);
    require('fs').mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ version: 99, prefs: {} }));
    const read = await readEbookAnnotations(ebook);
    assert.equal(read, null);
  });

  it('deletes the file when annotations are empty', async () => {
    const ebook = mkEbook(workDir, 'empty.epub');
    const target = annotationsPathFor(ebook);
    await writeEbookAnnotations(ebook, defaultEbookAnnotations());
    assert.equal(existsSync(target), false, 'default state should not be persisted');
  });

  it('annotationsPathFor puts the file under .whale/ebook-annotations/<basename>.json', () => {
    const target = annotationsPathFor('/x/y/foo.epub');
    assert.equal(target, path.join('/x/y', '.whale', 'ebook-annotations', 'foo.epub.json'));
  });

  it('serializes concurrent writes through the lock (last write wins)', async () => {
    const ebook = mkEbook(workDir, 'race.epub');
    const a: EbookAnnotations = {
      ...defaultEbookAnnotations(),
      bookmarks: [
        {
          id: 'bA',
          chapterId: 'ch1',
          scrollRatio: 0.1,
          createdAt: '2026-07-02T10:00:00.000Z',
        },
      ],
    };
    const b: EbookAnnotations = {
      ...defaultEbookAnnotations(),
      bookmarks: [
        {
          id: 'bB',
          chapterId: 'ch2',
          scrollRatio: 0.9,
          createdAt: '2026-07-02T10:00:01.000Z',
        },
      ],
    };
    // Fire both without awaiting — withLock should queue them.
    const p1 = writeEbookAnnotations(ebook, a);
    const p2 = writeEbookAnnotations(ebook, b);
    await Promise.all([p1, p2]);
    const read = await readEbookAnnotations(ebook);
    assert.ok(read);
    // Whichever finishes last should win; both are valid outcomes as long as
    // the file is internally consistent and not corrupted mid-write.
    assert.ok(['bA', 'bB'].includes(read.bookmarks[0].id));
    // Verify the file on disk is valid JSON (not partial).
    const target = annotationsPathFor(ebook);
    const raw = readFileSync(target, 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw));
  });
});