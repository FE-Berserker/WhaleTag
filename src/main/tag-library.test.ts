import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fsp, existsSync } from 'fs';
import {
  clearTagLibraryDescription,
  readTagLibrary,
  setTagLibraryDescription,
} from './tag-library';
import { META_DIR } from '../shared/whale-meta';

async function tmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'whale-taglib-'));
}

const libPath = (dir: string) => path.join(dir, META_DIR, 'wtaglib.json');

describe('location tag library (wtaglib.json)', () => {
  it('round-trips descriptions and removes empty files', async () => {
    const dir = await tmpDir();
    try {
      await setTagLibraryDescription(dir, 'urgent', 'ship today');
      await setTagLibraryDescription(dir, 'later', 'backlog');
      assert.deepEqual(await readTagLibrary(dir), {
        urgent: 'ship today',
        later: 'backlog',
      });
      await clearTagLibraryDescription(dir, 'urgent');
      assert.deepEqual(await readTagLibrary(dir), { later: 'backlog' });
      await setTagLibraryDescription(dir, 'later', '   ');
      assert.ok(!existsSync(libPath(dir)), 'sparse: file removed when empty');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('merges a new description without dropping the others', async () => {
    const dir = await tmpDir();
    try {
      await fsp.mkdir(path.join(dir, META_DIR), { recursive: true });
      await fsp.writeFile(
        libPath(dir),
        JSON.stringify({
          version: 1,
          descriptions: { a: 'first', b: 'second' },
        })
      );
      await setTagLibraryDescription(dir, 'c', 'third');
      assert.deepEqual(await readTagLibrary(dir), {
        a: 'first',
        b: 'second',
        c: 'third',
      });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('reads an absent library as empty without creating anything', async () => {
    const dir = await tmpDir();
    try {
      assert.deepEqual(await readTagLibrary(dir), {});
      assert.ok(!existsSync(libPath(dir)), 'no wtaglib.json is created by reading');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('surfaces a corrupt library instead of reporting "no descriptions"', async () => {
    const dir = await tmpDir();
    try {
      await fsp.mkdir(path.join(dir, META_DIR), { recursive: true });
      await fsp.writeFile(libPath(dir), '{ "descriptions": ');
      await assert.rejects(readTagLibrary(dir), (error: Error) => {
        assert.match(error.message, /Malformed tag library at/);
        assert.ok(error.message.includes(libPath(dir)), 'error must name the file');
        return true;
      });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('surfaces a well-formed JSON that is not a tag library', async () => {
    const dir = await tmpDir();
    try {
      await fsp.mkdir(path.join(dir, META_DIR), { recursive: true });
      await fsp.writeFile(
        libPath(dir),
        JSON.stringify({ version: 1, descriptions: ['not', 'a', 'map'] })
      );
      await assert.rejects(readTagLibrary(dir), (error: Error) => {
        assert.match(error.message, /Malformed tag library at/);
        assert.match(error.message, /"descriptions"/);
        return true;
      });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('surfaces an unreadable library (ENOENT is the only silent case)', async () => {
    const dir = await tmpDir();
    try {
      await fsp.mkdir(path.join(dir, META_DIR), { recursive: true });
      // A directory at the file's path makes readFile fail with a non-ENOENT
      // error (EISDIR/EPERM depending on platform).
      await fsp.mkdir(libPath(dir));
      await assert.rejects(readTagLibrary(dir), (error: Error) => {
        assert.match(error.message, /Failed to read the tag library at/);
        assert.ok(error.message.includes(libPath(dir)), 'error must name the file');
        return true;
      });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('quarantines a corrupt library instead of rewriting it from {}', async () => {
    const dir = await tmpDir();
    try {
      await fsp.mkdir(path.join(dir, META_DIR), { recursive: true });
      await fsp.writeFile(libPath(dir), '{ "descriptions": ');
      // The display reader surfaces the problem instead of hiding it…
      await assert.rejects(readTagLibrary(dir), /Malformed tag library at/);
      // …the setter must not let one edit clobber the unreadable file.
      await setTagLibraryDescription(dir, 'x', 'y');
      assert.deepEqual(await readTagLibrary(dir), { x: 'y' });
      const backups = (await fsp.readdir(path.join(dir, META_DIR))).filter((n) =>
        n.startsWith('wtaglib.json.corrupt-')
      );
      assert.equal(backups.length, 1);
      assert.equal(
        await fsp.readFile(path.join(dir, META_DIR, backups[0]), 'utf8'),
        '{ "descriptions": '
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
