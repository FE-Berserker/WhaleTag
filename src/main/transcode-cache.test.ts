import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  isTranscodeCached,
  transcodePathFor,
} from './transcode-cache';
import { META_DIR, TRANSCODES_DIR } from '../shared/whale-meta';

/**
 * `isTranscodeCached` decides whether the `whale-audio://` handler serves the
 * cached `.opus` (Range/206, instant + seekable) or spawns a fresh ffmpeg live
 * transcode. A wrong answer either serves a stale transcode (wrong audio after
 * the source was edited) or needlessly re-transcodes a huge file. These tests
 * pin the mtime-based freshness rule extracted from the old `doLoadTranscode`.
 */
describe('transcodePathFor', () => {
  it('places the cache under <dir>/.whale/transcodes/<basename>.opus', () => {
    const p = transcodePathFor('/home/foo/track.ape');
    assert.ok(p.endsWith(join(META_DIR, TRANSCODES_DIR, 'track.ape.opus')), p);
    assert.ok(dirname(p).endsWith(join(META_DIR, TRANSCODES_DIR)));
  });
});

describe('isTranscodeCached', () => {
  let dir: string;
  let src: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'whale-tc-'));
    src = join(dir, 'track.ape');
    writeFileSync(src, 'source-bytes');
  });
  after(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  function writeCache(): string {
    const cachePath = transcodePathFor(src);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, 'opus-bytes');
    return cachePath;
  }

  it('reports not fresh when no cache exists', async () => {
    const res = await isTranscodeCached(src);
    assert.equal(res.fresh, false);
    assert.equal(res.path, transcodePathFor(src));
  });

  it('reports fresh when cache mtime >= source mtime', async () => {
    const cachePath = writeCache();
    // source: mtime = 1000s; cache: mtime = 2000s → cache newer → fresh.
    utimesSync(src, 1000, 1000);
    utimesSync(cachePath, 2000, 2000);
    const res = await isTranscodeCached(src);
    assert.equal(res.fresh, true);
  });

  it('reports not fresh when cache is older than the source', async () => {
    const cachePath = writeCache();
    // source edited AFTER the cache was written → cache stale.
    utimesSync(cachePath, 1000, 1000);
    utimesSync(src, 2000, 2000);
    const res = await isTranscodeCached(src);
    assert.equal(res.fresh, false);
  });

  it('reports not fresh when the source is gone', async () => {
    const gone = join(dir, 'missing.ape');
    const res = await isTranscodeCached(gone);
    assert.equal(res.fresh, false);
  });
});
