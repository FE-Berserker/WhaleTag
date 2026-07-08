import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fsp, existsSync } from 'fs';
import {
  backupRevision,
  listRevisions,
  restoreRevision,
  deleteRevision,
  cleanupRevisionsForLocation,
} from './revisions';
import { META_DIR } from '../shared/whale-meta';

async function tmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'whale-rev-'));
}

function touchMtime(filePath: string, mtime: Date): Promise<void> {
  return fsp.utimes(filePath, mtime, mtime);
}

describe('revision history', () => {
  it('backs up a file before modification', async () => {
    const dir = await tmpDir();
    try {
      const filePath = path.join(dir, 'doc.txt');
      await fsp.writeFile(filePath, 'version 1', 'utf8');
      await backupRevision(filePath);
      await fsp.writeFile(filePath, 'version 2', 'utf8');

      const revs = await listRevisions(filePath);
      assert.equal(revs.length, 1);
      assert.ok(revs[0].path.endsWith('.txt'));

      const content = await fsp.readFile(revs[0].path, 'utf8');
      assert.equal(content, 'version 1');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('lists revisions newest first', async () => {
    const dir = await tmpDir();
    try {
      const filePath = path.join(dir, 'doc.txt');
      await fsp.writeFile(filePath, 'v1', 'utf8');
      await backupRevision(filePath);
      await new Promise((r) => setTimeout(r, 50));
      await fsp.writeFile(filePath, 'v2', 'utf8');
      await backupRevision(filePath);

      const revs = await listRevisions(filePath);
      assert.equal(revs.length, 2);
      const [first, second] = revs;
      assert.ok(first.timestamp >= second.timestamp);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('restores a revision', async () => {
    const dir = await tmpDir();
    try {
      const filePath = path.join(dir, 'doc.txt');
      await fsp.writeFile(filePath, 'v1', 'utf8');
      await backupRevision(filePath);
      await fsp.writeFile(filePath, 'v2', 'utf8');

      const revs = await listRevisions(filePath);
      await restoreRevision(filePath, revs[0].path);
      const restored = await fsp.readFile(filePath, 'utf8');
      assert.equal(restored, 'v1');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects restore of revision outside file revisions dir', async () => {
    const dir = await tmpDir();
    try {
      const filePath = path.join(dir, 'doc.txt');
      const otherFile = path.join(dir, 'other.txt');
      await fsp.writeFile(filePath, 'v1', 'utf8');
      await fsp.writeFile(otherFile, 'x', 'utf8');

      await assert.rejects(
        restoreRevision(filePath, otherFile),
        /Invalid revision path/
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('cleans up revisions older than max age', async () => {
    const dir = await tmpDir();
    try {
      const filePath = path.join(dir, 'doc.txt');
      await fsp.writeFile(filePath, 'old', 'utf8');
      await backupRevision(filePath);
      const revs = await listRevisions(filePath);
      assert.equal(revs.length, 1);

      const oldMtime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await touchMtime(revs[0].path, oldMtime);

      await cleanupRevisionsForLocation(dir, 30);
      const after = await listRevisions(filePath);
      assert.equal(after.length, 0);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps recent revisions during cleanup', async () => {
    const dir = await tmpDir();
    try {
      const filePath = path.join(dir, 'doc.txt');
      await fsp.writeFile(filePath, 'recent', 'utf8');
      await backupRevision(filePath);

      await cleanupRevisionsForLocation(dir, 30);
      const after = await listRevisions(filePath);
      assert.equal(after.length, 1);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('deleteRevision removes a single revision', async () => {
    const dir = await tmpDir();
    try {
      const filePath = path.join(dir, 'doc.txt');
      await fsp.writeFile(filePath, 'v1', 'utf8');
      await backupRevision(filePath);
      const revs = await listRevisions(filePath);
      assert.equal(revs.length, 1);

      await deleteRevision(revs[0].path);
      const after = await listRevisions(filePath);
      assert.equal(after.length, 0);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('backupRevision is a no-op for non-existent files', async () => {
    const dir = await tmpDir();
    try {
      const filePath = path.join(dir, 'missing.txt');
      await backupRevision(filePath);
      const revDir = path.join(dir, META_DIR, 'revisions', 'missing.txt');
      assert.equal(existsSync(revDir), false);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
