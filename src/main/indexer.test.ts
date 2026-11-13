import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';
import { buildIndex, buildIndexReport } from './indexer';
import { META_DIR } from '../shared/whale-meta';

describe('buildIndex sidecar degradation', () => {
  it('keeps indexing healthy directories when another wsd.json is malformed', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-indexer-'));
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    try {
      const goodDir = path.join(root, 'good');
      const badDir = path.join(root, 'bad');
      await Promise.all([
        fsp.mkdir(path.join(goodDir, META_DIR), { recursive: true }),
        fsp.mkdir(path.join(badDir, META_DIR), { recursive: true }),
      ]);
      await Promise.all([
        fsp.writeFile(path.join(goodDir, 'plain.txt'), 'good'),
        fsp.writeFile(path.join(badDir, 'plain.txt'), 'bad'),
        fsp.writeFile(
          path.join(goodDir, META_DIR, 'wsd.json'),
          JSON.stringify({ version: 1, files: { 'plain.txt': { tags: ['keep'] } } })
        ),
        fsp.writeFile(path.join(badDir, META_DIR, 'wsd.json'), '{malformed'),
      ]);

      const entries = await buildIndex(root);
      const good = entries.find((entry) => entry.path === 'good/plain.txt');
      const bad = entries.find((entry) => entry.path === 'bad/plain.txt');
      assert.deepEqual(good?.tags, ['keep']);
      assert.equal(good?.tagsUnreadable, undefined, 'a readable sidecar is authoritative');
      assert.deepEqual(bad?.tags, []);
      assert.equal(
        bad?.tagsUnreadable,
        true,
        'the ingester must keep the stored tags for this row'
      );
      assert.equal(warnings.length, 1, 'the degraded directory is surfaced');
    } finally {
      console.warn = originalWarn;
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('reports a complete walk when every directory is readable', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-indexer-'));
    try {
      await fsp.mkdir(path.join(root, 'nested'), { recursive: true });
      await fsp.writeFile(path.join(root, 'nested', 'file.txt'), 'x');

      const report = await buildIndexReport(root);
      assert.equal(report.complete, true);
      assert.deepEqual(report.unreadable, []);
      assert.ok(report.entries.some((entry) => entry.path === 'nested/file.txt'));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
