import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
  migrateSidecarTags,
  runMigration,
  triggerStartupMigration,
  resetStartupMigrationForTests,
} from './migrate-date-tags';
import { atomicWriteJson } from './atomic-write';
import { META_DIR, FOLDER_SIDECAR_FILE, FOLDER_META_FILE } from '../shared/whale-meta';

describe('migrateSidecarTags — pure transform', () => {
  it('strips legacy 7 prefixes (one of each)', () => {
    const cases: Array<[string, string]> = [
      ['today-20260704', '20260704'],
      ['yesterday-20260703', '20260703'],
      ['tomorrow-20260705', '20260705'],
      ['now-20260704T1430', '20260704T1430'],
      ['week-20260706', '20260706'],
      ['month-202607', '202607'],
      ['year-2026', '2026'],
    ];
    for (const [input, expected] of cases) {
      const r = migrateSidecarTags([input]);
      assert.deepEqual(r.tags, [expected], `input=${input}`);
      assert.equal(r.changed, true);
    }
  });

  it('passes through non-date tags unchanged', () => {
    const tags = ['idea', '3star', 'in-progress', 'urgent-important', 'geo:36.1,117.8'];
    const r = migrateSidecarTags(tags);
    assert.deepEqual(r.tags, tags);
    assert.equal(r.changed, false);
  });

  it('collapses multiple bare date tags to the last (互斥 applies to new format too)', () => {
    // Once the互斥 family rule is in effect, it applies regardless of whether
    // the data is in old-prefix or new-bare form. The migration re-runs the
    //互斥 on already-migrated files, which is fine because the result is
    // idempotent (the LAST date tag stays as-is, everything else dropped).
    const r = migrateSidecarTags(['20260704', '202607', '2026', '20260704T1430']);
    assert.deepEqual(r.tags, ['20260704T1430']);
    assert.equal(r.changed, true);
  });

  it('single bare date tag is no-op (last wins is itself)', () => {
    const r = migrateSidecarTags(['20260704']);
    assert.deepEqual(r.tags, ['20260704']);
    assert.equal(r.changed, false);
  });

  it('collapses multiple period tags to the last (period family互斥)', () => {
    // Period family互斥 is also enforced as part of the migration.
    const r = migrateSidecarTags(['20260701-20260703', '20260710-20260701']);
    assert.deepEqual(r.tags, ['20260710-20260701']);
    assert.equal(r.changed, true);
  });

  it('single period tag is no-op', () => {
    const r = migrateSidecarTags(['20260701-20260703']);
    assert.deepEqual(r.tags, ['20260701-20260703']);
    assert.equal(r.changed, false);
  });

  it('collapses multiple date-shaped tags to the last (user spec: 保留其中一个就行)', () => {
    // Two legacy date tags → after prefix-strip both are date-shaped → keep last
    const r = migrateSidecarTags(['today-20260701', 'month-202606']);
    assert.deepEqual(r.tags, ['202606']);
    assert.equal(r.changed, true);
  });

  it('collapses mixed prefix + bare date tags too', () => {
    // today-20251223 (stale) + bare 202607 (also stale on 2026-07-04):
    // both are date-shape; keep last
    const r = migrateSidecarTags(['today-20251223', '202607']);
    assert.deepEqual(r.tags, ['202607']);
  });

  it('cross-family isolation: date + period kept independent', () => {
    // Date and period互斥 families are independent — one of each is allowed.
    const r = migrateSidecarTags(['today-20260704', '20260701-20260703']);
    assert.deepEqual(r.tags, ['20260704', '20260701-20260703']);
  });

  it('period family互斥 within itself (last wins)', () => {
    const r = migrateSidecarTags(['20260701-20260703', '20260710-20260720']);
    assert.deepEqual(r.tags, ['20260710-20260720']);
  });

  it('rejects non-array input gracefully', () => {
    // TS doesn't strictly forbid passing `null` / `undefined` here — the
    // `Array.isArray` runtime guard handles both. Cast through `unknown`
    // so the test can exercise the defensive path without a type error.
    const r1 = migrateSidecarTags(null as unknown as string[]);
    assert.equal(r1.changed, false);
    const r2 = migrateSidecarTags(undefined as unknown as string[]);
    assert.equal(r2.changed, false);
  });

  it('regression: deeply equal input is reported as no-op', () => {
    const tags = ['idea', '3star'];
    const r = migrateSidecarTags(tags);
    assert.equal(r.changed, false);
  });
});

describe('migrateSidecarTags — end-to-end over the existing fixture data', () => {
  it('rewrites Test/大文件测试/.whale/wsd.json if any legacy prefix is present', async () => {
    // Sanity check using the real fixture shipped in the repo.
    const fixturePath = path.resolve(
      __dirname,
      '..',
      '..',
      'Test',
      '大文件测试',
      META_DIR,
      FOLDER_SIDECAR_FILE
    );
    try {
      await fsp.access(fixturePath);
    } catch {
      // Fixture not present (running on a different checkout); skip.
      return;
    }
    const raw = await fsp.readFile(fixturePath, 'utf-8');
    const original = JSON.parse(raw);
    // Read tags per entry, then run the pure function per entry; verify
    // output is either the original (no legacy prefix anywhere) or a
    // stripped form. Per-entry (not flattened): the互斥 collapse is a
    // per-file rule, so flattening every file's tags into one array would
    // falsely collapse unrelated period/date tags across files.
    const entries = Object.values(original.files ?? {}) as Array<{
      tags?: string[];
    }>;
    const perEntry = entries
      .filter((f) => Array.isArray(f?.tags))
      .map((f) => migrateSidecarTags(f.tags as string[]));
    const sampleTags: string[] = entries.flatMap((f) =>
      Array.isArray(f?.tags) ? (f.tags as string[]) : []
    );
    const r = {
      changed: perEntry.some((x) => x.changed),
      tags: perEntry.flatMap((x) => x.tags),
    };
    if (sampleTags.length === 0) {
      assert.equal(r.changed, false);
      return;
    }
    // No-op when there are no legacy prefixes
    if (
      !sampleTags.some((t) =>
        /^(?:today|yesterday|tomorrow|now|week|month|year)-/.test(t)
      )
    ) {
      assert.equal(r.changed, false);
      assert.deepEqual(r.tags, sampleTags);
    }
    // Sanity: file content unchanged after the pure call (no I/O).
    // Note: the on-disk JSON is pretty-printed by atomicWriteJson, so we
    // compare objects (parse-parse-equal), not raw strings.
    const after = JSON.parse(await fsp.readFile(fixturePath, 'utf-8'));
    assert.deepEqual(after, original);
  });
});

describe('runMigration — integration over a tmp directory', () => {
  let root: string;
  before(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'migrate-test-'));
  });
  after(async () => {
    if (root) {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('rewrites wsd.json + creates .bak-dateprefix on first run', async () => {
    const dir = path.join(root, 'docs');
    await fsp.mkdir(path.join(dir, META_DIR), { recursive: true });
    const wsdPath = path.join(dir, META_DIR, FOLDER_SIDECAR_FILE);
    const data = {
      version: 1,
      files: {
        'a.txt': { tags: ['today-20260704', 'idea'] },
        'b.txt': { tags: ['month-202606', 'work', 'today-20251223'] },
        'c.txt': { tags: ['plain', '3star'] },
      },
    };
    await atomicWriteJson(wsdPath, data);

    const r = await runMigration([root]);
    assert.equal(r.totalErrors, 0, JSON.stringify(r.errors));
    // a.txt: 1 entry scanned, 1 entry migrated (stripped today-)
    // b.txt: 1 entry scanned, 1 entry migrated (multiple → keep last)
    // c.txt: 1 entry scanned, 0 migrated (no date tags)
    assert.equal(r.totalScanned, 3);
    assert.ok(r.totalMigrated >= 1);

    // Verify on-disk result
    const after = JSON.parse(await fsp.readFile(wsdPath, 'utf-8'));
    assert.deepEqual(after.files['a.txt'].tags, ['20260704', 'idea']);
    // b.txt: had [month-202606, work, today-20251223] → after strip
    //   [202606, work, 20251223] → date互斥: keep last date tag
    //   (`20251223`), drop `202606`
    assert.deepEqual(after.files['b.txt'].tags, ['work', '20251223']);
    // c.txt unchanged
    assert.deepEqual(after.files['c.txt'].tags, ['plain', '3star']);

    // Backup created
    const backupPath = `${wsdPath}.bak-dateprefix`;
    const backupExists = await fsp
      .access(backupPath)
      .then(() => true)
      .catch(() => false);
    assert.equal(backupExists, true, 'first run should create .bak-dateprefix');
    const backupContent = JSON.parse(await fsp.readFile(backupPath, 'utf-8'));
    assert.deepEqual(backupContent, data);

    // Migration state flag set
    const statePath = path.join(root, META_DIR, '_migration-state.json');
    const state = JSON.parse(await fsp.readFile(statePath, 'utf-8'));
    assert.equal(state['date-prefix-v1'], true);
  });

  it('is idempotent on second run (no rewrite, no second backup)', async () => {
    // Re-run on the same root; nothing should change.
    const before = await fsp.readdir(path.join(root, 'docs', META_DIR));
    const r = await runMigration([root]);
    assert.equal(r.totalErrors, 0, JSON.stringify(r.errors));
    assert.equal(r.totalMigrated, 0, 'no tags need migration on second pass');
    // No new backup file (still only the original one).
    const after = await fsp.readdir(path.join(root, 'docs', META_DIR));
    assert.deepEqual(after, before);
  });

  it('migrates wsm.json (folder metadata) the same way', async () => {
    const subRoot = path.join(root, 'folder-meta');
    await fsp.mkdir(path.join(subRoot, META_DIR), { recursive: true });
    const wsmPath = path.join(subRoot, META_DIR, FOLDER_META_FILE);
    await atomicWriteJson(wsmPath, {
      title: 'My Folder',
      tags: ['today-20260704', 'idea', 'in-progress'],
    });
    const r = await runMigration([root]);
    assert.equal(r.totalErrors, 0, JSON.stringify(r.errors));
    const after = JSON.parse(await fsp.readFile(wsmPath, 'utf-8'));
    assert.deepEqual(after.tags, ['20260704', 'idea', 'in-progress']);
  });

  it('handles missing / corrupt JSON gracefully (no overwrite)', async () => {
    const subRoot = path.join(root, 'corrupt');
    await fsp.mkdir(path.join(subRoot, META_DIR), { recursive: true });
    const wsdPath = path.join(subRoot, META_DIR, FOLDER_SIDECAR_FILE);
    await fsp.writeFile(wsdPath, '{ this is not json', 'utf-8');
    const r = await runMigration([root]);
    // No fatal throw; reported in errors
    assert.ok(r.totalErrors >= 1, 'corrupt JSON should be reported as an error');
    // File untouched
    const content = await fsp.readFile(wsdPath, 'utf-8');
    assert.equal(content, '{ this is not json');
  });

  it('handles empty allowedRoots', async () => {
    const r = await runMigration([]);
    assert.equal(r.totalScanned, 0);
    assert.equal(r.totalMigrated, 0);
  });
});

describe('triggerStartupMigration — startup trigger once-guard', () => {
  let root: string;
  before(async () => {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'migrate-trigger-'));
  });
  after(async () => {
    if (root) {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('returns null on empty roots without consuming the once-guard', async () => {
    resetStartupMigrationForTests();
    assert.equal(triggerStartupMigration([]), null);
    // A later non-empty push must still run (the renderer can push [] before
    // rehydration and the real locations right after).
    const dir = path.join(root, 'late');
    await fsp.mkdir(path.join(dir, META_DIR), { recursive: true });
    const wsdPath = path.join(dir, META_DIR, FOLDER_SIDECAR_FILE);
    await atomicWriteJson(wsdPath, {
      version: 1,
      files: { 'x.txt': { tags: ['today-20260704'] } },
    });
    const p = triggerStartupMigration([root]);
    assert.ok(p, 'non-empty roots should start the migration');
    await p;
    const migrated = JSON.parse(await fsp.readFile(wsdPath, 'utf-8'));
    assert.deepEqual(migrated.files['x.txt'].tags, ['20260704']);
  });

  it('runs at most once per process', async () => {
    resetStartupMigrationForTests();
    const first = triggerStartupMigration([root]);
    assert.ok(first, 'first trigger starts the migration');
    await first;
    assert.equal(
      triggerStartupMigration([root]),
      null,
      'second trigger is a no-op (once-guard)'
    );
  });
});
