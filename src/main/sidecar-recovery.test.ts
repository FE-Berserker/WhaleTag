import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { promises as fsp } from 'fs';
import {
  readSidecarsDetailed,
  readSidecardsForPaths,
  readSidecardsForPathsDetailed,
  recoverCorruptSidecar,
  writeSidecar,
} from './sidecar';
import { setAllowedRoots } from './allowed-roots';
import { META_DIR, SIDECAR_VERSION } from '../shared/whale-meta';

const testRequire = createRequire(__filename);
const syncFs = testRequire('fs') as typeof import('fs');
const wsd = (dir: string) => path.join(dir, META_DIR, 'wsd.json');
const malformed = '{"version":1,"files":';
const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes.toString('latin1'), 'latin1').digest('hex');

async function tmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'whale-sidecar-recovery-'));
}

async function seedCorrupt(dir: string, bytes = malformed): Promise<Buffer> {
  await fsp.mkdir(path.dirname(wsd(dir)), { recursive: true });
  const original = Buffer.from(bytes, 'utf8');
  await fsp.writeFile(wsd(dir), original.toString('utf8'), 'utf8');
  return original;
}

async function backups(dir: string): Promise<string[]> {
  return (await fsp.readdir(path.join(dir, META_DIR)))
    .filter((name) => name.startsWith('wsd.json.corrupt-') && name.endsWith('.bak'))
    .sort();
}

describe('detailed sidecar reads and confirmed corrupt recovery', () => {
  it('reports malformed/wrong-shape directories while retaining healthy bulk data', async () => {
    const root = await tmpDir();
    const badJson = path.join(root, 'bad-json');
    const badShape = path.join(root, 'bad-shape');
    const healthy = path.join(root, 'healthy');
    try {
      await fsp.mkdir(badShape, { recursive: true });
      await fsp.mkdir(healthy, { recursive: true });
      const badBytes = await seedCorrupt(badJson);
      const shapeBytes = await seedCorrupt(
        badShape,
        '{"version":1,"files":null}'
      );
      await writeSidecar(path.join(healthy, 'good.txt'), { tags: ['keep'] });
      const paths = [badJson, badShape, healthy].map((dir) =>
        path.join(dir, 'good.txt')
      );
      const result = await readSidecardsForPathsDetailed(paths);
      assert.deepEqual(result.sidecars[path.join(healthy, 'good.txt')]?.tags, [
        'keep',
      ]);
      assert.equal(result.issues.length, 2);
      const byDir = new Map(result.issues.map((issue) => [issue.dirPath, issue]));
      const jsonIssue = byDir.get(badJson);
      const shapeIssue = byDir.get(badShape);
      assert.equal(jsonIssue?.kind, 'corrupt');
      assert.equal(jsonIssue?.reason, 'invalid-json');
      assert.equal(shapeIssue?.kind, 'corrupt');
      assert.equal(shapeIssue?.reason, 'invalid-shape');
      assert.equal(jsonIssue?.sha256, sha256(badBytes));
      assert.equal(jsonIssue?.size, badBytes.length);
      assert.equal(shapeIssue?.sha256, sha256(shapeBytes));
      assert.equal(shapeIssue?.size, shapeBytes.length);
      // The legacy wrapper still returns the original path-keyed map for MCP.
      const compat = await readSidecardsForPaths(paths);
      assert.deepEqual(compat, result.sidecars);
      assert.equal('issues' in compat, false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('returns not-corrupt without writes for valid, blank, and missing wsd', async () => {
    const root = await tmpDir();
    try {
      setAllowedRoots([root]);
      for (const kind of ['valid', 'blank', 'missing']) {
        const dir = path.join(root, kind);
        await fsp.mkdir(dir, { recursive: true });
        let before: Buffer | null = null;
        if (kind === 'valid') {
          before = Buffer.from(
            JSON.stringify({ version: SIDECAR_VERSION, files: {} }),
            'utf8'
          );
          await fsp.mkdir(path.dirname(wsd(dir)), { recursive: true });
          await fsp.writeFile(wsd(dir), before.toString('utf8'), 'utf8');
        } else if (kind === 'blank') {
          before = Buffer.from('  \n', 'utf8');
          await fsp.mkdir(path.dirname(wsd(dir)), { recursive: true });
          await fsp.writeFile(wsd(dir), before.toString('utf8'), 'utf8');
        }
        const result = await recoverCorruptSidecar({
          dirPath: dir,
          expectedSha256: '0'.repeat(64),
        });
        assert.deepEqual(result, { status: 'not-corrupt' });
        if (before) {
          assert.deepEqual(await fsp.readFile(wsd(dir)), before);
          assert.deepEqual(await backups(dir), []);
        } else {
          await assert.rejects(fsp.stat(wsd(dir)), { code: 'ENOENT' });
        }
      }
    } finally {
      setAllowedRoots([]);
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a stale hash as conflict with zero writes', async () => {
    const dir = await tmpDir();
    try {
      setAllowedRoots([dir]);
      const original = await seedCorrupt(dir);
      const result = await recoverCorruptSidecar({
        dirPath: dir,
        expectedSha256: 'f'.repeat(64),
      });
      assert.deepEqual(result, { status: 'conflict' });
      assert.deepEqual(await fsp.readFile(wsd(dir)), original);
      assert.deepEqual(await backups(dir), []);
    } finally {
      setAllowedRoots([]);
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('recovers an invalid aggregate shape only after matching its fingerprint', async () => {
    const dir = await tmpDir();
    try {
      setAllowedRoots([dir]);
      const original = await seedCorrupt(dir, '{"version":1,"files":null}');
      const detailed = await readSidecarsDetailed(dir, ['a.txt']);
      assert.equal(detailed.issues[0]?.kind, 'corrupt');
      assert.equal(detailed.issues[0]?.reason, 'invalid-shape');
      const expected = detailed.issues[0]?.sha256;
      assert.ok(expected);
      const conflict = await recoverCorruptSidecar({
        dirPath: dir,
        expectedSha256: '0'.repeat(64),
      });
      assert.deepEqual(conflict, { status: 'conflict' });
      assert.deepEqual(await fsp.readFile(wsd(dir)), original);
      assert.deepEqual(await backups(dir), []);
      const result = await recoverCorruptSidecar({
        dirPath: dir,
        expectedSha256: expected,
      });
      assert.equal(result.status, 'recovered');
      if (result.status !== 'recovered') return;
      assert.deepEqual(await fsp.readFile(result.backupPath), original);
      assert.deepEqual(JSON.parse(await fsp.readFile(wsd(dir), 'utf8')), {
        version: SIDECAR_VERSION,
        files: {},
      });
    } finally {
      setAllowedRoots([]);
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('backs up exact bytes and keeps readable legacy metadata visible', async () => {
    const dir = await tmpDir();
    try {
      setAllowedRoots([dir]);
      const original = await seedCorrupt(dir);
      const legacyPath = path.join(dir, META_DIR, 'old.txt.json');
      const legacy = '{"tags":["legacy"]}';
      await fsp.writeFile(legacyPath, legacy, 'utf8');
      const detailed = await readSidecarsDetailed(dir, ['a.txt']);
      assert.equal(detailed.issues[0]?.kind, 'corrupt');
      const expected = detailed.issues[0]?.sha256;
      assert.ok(expected);
      const result = await recoverCorruptSidecar({
        dirPath: dir,
        expectedSha256: expected,
      });
      assert.equal(result.status, 'recovered');
      if (result.status !== 'recovered') return;
      const backupBytes = await fsp.readFile(result.backupPath);
      assert.equal(sha256(backupBytes), expected);
      assert.deepEqual(backupBytes, original);
      assert.deepEqual(JSON.parse(await fsp.readFile(wsd(dir), 'utf8')), {
        version: SIDECAR_VERSION,
        files: { 'old.txt': { tags: ['legacy'] } },
      });
      const recovered = await readSidecarsDetailed(dir, ['old.txt']);
      assert.deepEqual(recovered.sidecars['old.txt']?.tags, ['legacy']);
      assert.deepEqual(recovered.issues, []);
      // Import readable legacy metadata without deleting/mutating its source.
      assert.equal(await fsp.readFile(legacyPath, 'utf8'), legacy);
      await writeSidecar(path.join(dir, 'old.txt'), {});
      assert.equal(await fsp.readFile(legacyPath, 'utf8'), legacy);
      assert.deepEqual(JSON.parse(await fsp.readFile(wsd(dir), 'utf8')), {
        version: SIDECAR_VERSION,
        files: {},
      });
      const afterLastTagRemoval = await readSidecarsDetailed(dir, ['old.txt']);
      assert.equal(afterLastTagRemoval.sidecars['old.txt'], undefined);
      assert.deepEqual(afterLastTagRemoval.issues, []);
    } finally {
      setAllowedRoots([]);
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('uses a non-overwriting suffix when the backup name already exists', async () => {
    const dir = await tmpDir();
    const realNow = Date.now;
    try {
      setAllowedRoots([dir]);
      const original = await seedCorrupt(dir);
      const hash = sha256(original);
      const fixed = 1760000000000;
      Date.now = () => fixed;
      const first = await recoverCorruptSidecar({
        dirPath: dir,
        expectedSha256: hash,
      });
      await seedCorrupt(dir);
      const second = await recoverCorruptSidecar({
        dirPath: dir,
        expectedSha256: hash,
      });
      assert.equal(first.status, 'recovered');
      assert.equal(second.status, 'recovered');
      if (first.status !== 'recovered' || second.status !== 'recovered') return;
      assert.notEqual(first.backupPath, second.backupPath);
      assert.equal(
        path.basename(first.backupPath),
        `wsd.json.corrupt-${fixed}-${hash.slice(0, 12)}.bak`
      );
      assert.equal(
        path.basename(second.backupPath),
        `wsd.json.corrupt-${fixed}-${hash.slice(0, 12)}-1.bak`
      );
      assert.deepEqual(await fsp.readFile(first.backupPath), original);
      assert.deepEqual(await fsp.readFile(second.backupPath), original);
    } finally {
      Date.now = realNow;
      setAllowedRoots([]);
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('retains original bytes and the backup when the final rename fails', async () => {
    const dir = await tmpDir();
    const realRename = syncFs.promises.rename;
    try {
      setAllowedRoots([dir]);
      const original = await seedCorrupt(dir);
      const hash = sha256(original);
      syncFs.promises.rename = async () => {
        throw Object.assign(new Error('simulated rename failure'), {
          code: 'EACCES',
        });
      };
      await assert.rejects(
        recoverCorruptSidecar({ dirPath: dir, expectedSha256: hash }),
        /simulated rename failure/
      );
      assert.deepEqual(await fsp.readFile(wsd(dir)), original);
      const names = await backups(dir);
      assert.equal(names.length, 1);
      assert.deepEqual(await fsp.readFile(path.join(dir, META_DIR, names[0])), original);
    } finally {
      syncFs.promises.rename = realRename;
      setAllowedRoots([]);
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed with empty roots and for outside directories', async () => {
    const root = await tmpDir();
    const outside = await tmpDir();
    try {
      const original = await seedCorrupt(outside);
      setAllowedRoots([]);
      await assert.rejects(
        recoverCorruptSidecar({
          dirPath: outside,
          expectedSha256: sha256(original),
        }),
        /no configured locations/
      );
      setAllowedRoots([root]);
      await assert.rejects(
        recoverCorruptSidecar({
          dirPath: outside,
          expectedSha256: sha256(original),
        }),
        /outside any configured location/
      );
      assert.deepEqual(await fsp.readFile(wsd(outside)), original);
      assert.deepEqual(await backups(outside), []);
    } finally {
      setAllowedRoots([]);
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it('classifies IO failures as unreadable and never offers recovery', async () => {
    const dir = await tmpDir();
    try {
      setAllowedRoots([dir]);
      await fsp.mkdir(wsd(dir), { recursive: true });
      const result = await readSidecarsDetailed(dir, ['a.txt']);
      assert.equal(result.issues.length, 1);
      assert.equal(result.issues[0]?.kind, 'unreadable');
      assert.equal(result.issues[0]?.reason, 'io');
      assert.equal('sha256' in result.issues[0], false);
      await assert.rejects(
        recoverCorruptSidecar({ dirPath: dir, expectedSha256: '0'.repeat(64) })
      );
      assert.equal((await fsp.stat(wsd(dir))).isDirectory(), true);
      assert.deepEqual(await fsp.readdir(path.join(dir, META_DIR)), ['wsd.json']);
    } finally {
      setAllowedRoots([]);
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes same-directory concurrent recovery into one write', async () => {
    const dir = await tmpDir();
    try {
      setAllowedRoots([dir]);
      const original = await seedCorrupt(dir);
      const request = { dirPath: dir, expectedSha256: sha256(original) };
      const results = await Promise.all([
        recoverCorruptSidecar(request),
        recoverCorruptSidecar(request),
      ]);
      assert.deepEqual(
        results.map((result) => result.status).sort(),
        ['not-corrupt', 'recovered']
      );
      const names = await backups(dir);
      assert.equal(names.length, 1);
      assert.deepEqual(await fsp.readFile(path.join(dir, META_DIR, names[0])), original);
      assert.deepEqual(JSON.parse(await fsp.readFile(wsd(dir), 'utf8')), {
        version: SIDECAR_VERSION,
        files: {},
      });
    } finally {
      setAllowedRoots([]);
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
