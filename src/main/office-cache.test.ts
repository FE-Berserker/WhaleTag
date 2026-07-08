import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import os from 'os';
import { existsSync, promises as fsp } from 'fs';
import {
  loadOfficePdf,
  removeOfficePdf,
  moveOfficePdf,
  copyOfficePdf,
  officePdfPathFor,
} from './office-cache';
import { META_DIR, TRANSCODES_DIR } from '../shared/whale-meta';

/**
 * Creates a fake `soffice` script that mimics LibreOffice's CLI by writing a
 * PDF marker to `<outdir>/<basename(src)>.pdf`. Same pattern as
 * `office-convert.test.ts` (`makeFakeSoffice`) — kept inline here to avoid
 * cross-test imports in the main process test directory.
 *
 * Increments a counter file in cwd on every invocation so tests can assert
 * dedup behavior (e.g. "8 concurrent loads → counter shows 1").
 */
async function makeFakeSoffice(
  tmp: string,
  opts: { tag?: string } = {}
): Promise<string> {
  const isWin = process.platform === 'win32';
  const script = isWin ? 'soffice.cmd' : 'soffice';
  const scriptPath = path.join(tmp, script);
  const tag = opts.tag ?? 'default';

  const js = `
const fs = require('fs');
const args = process.argv.slice(2);
let outdir = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--outdir' && i + 1 < args.length) { outdir = args[i+1]; i++; }
}
const src = args[args.length - 1];
const counterPath = (process.env.WHALE_FAKE_COUNTER || '');
if (counterPath) { try { fs.appendFileSync(counterPath, 'x'); } catch {} }
if (outdir && src) {
  const base = src.split(/[\\\\/]/).pop().replace(/\\.[^.]+$/, '');
  const outPath = outdir + '/' + base + '.pdf';
  const payload = Buffer.concat([
    Buffer.from('%PDF-1.4\\n'),
    Buffer.from('whale-fake-soffice-${tag}\\n'),
    Buffer.from('outdir=' + outdir + '\\n'),
  ]);
  fs.writeFileSync(outPath, payload);
}
process.exit(0);
`;

  if (isWin) {
    await fsp.writeFile(scriptPath, `@node "%~dpn0.js" %*\n`);
    await fsp.writeFile(path.join(tmp, 'soffice.js'), js);
  } else {
    await fsp.writeFile(scriptPath, `#!/usr/bin/env node\n${js}`);
    await fsp.chmod(scriptPath, 0o755);
  }
  return scriptPath;
}

/** Pin source mtime to the past so the cache (newer) wins on the next load. */
async function pinMtimePast(filePath: string, iso = '2020-01-01T00:00:00Z') {
  const past = new Date(iso).getTime() / 1000;
  await fsp.utimes(filePath, past, past);
}

describe('officePdfPathFor', () => {
  it('builds the path under .whale/transcodes with .pdf suffix', () => {
    const p = officePdfPathFor('/some/dir/report.docx');
    assert.strictEqual(
      p,
      path.join('/some/dir', META_DIR, TRANSCODES_DIR, 'report.docx.pdf')
    );
  });
});

describe('office-cache (with fake soffice)', () => {
  let tmp: string;
  let fakeBin: string;
  let srcPath: string;
  let cachePath: string;
  let counterPath: string;

  before(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-office-cache-'));
    fakeBin = await makeFakeSoffice(tmp, { tag: 'cache-test' });
    counterPath = path.join(tmp, 'counter.txt');
    srcPath = path.join(tmp, 'report.docx');
    await fsp.writeFile(srcPath, 'fake docx payload');
    cachePath = officePdfPathFor(srcPath);
    // The fake shim reads the counter path from env; setting here makes
    // process.env visible to the spawned child (execFile inherits env by
    // default). Save/restore to avoid leaking into other test files.
    process.env.WHALE_FAKE_COUNTER = counterPath;
  });

  after(async () => {
    delete process.env.WHALE_FAKE_COUNTER;
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  });

  it('on cache miss, writes .whale/transcodes/<basename>.pdf and returns its bytes', async () => {
    // Ensure clean state.
    await fsp.rm(cachePath, { force: true });
    await fsp.writeFile(counterPath, '');

    const buf = await loadOfficePdf(srcPath, { sofficePath: fakeBin });
    assert.ok(buf.length > 0);
    assert.strictEqual(buf.toString('utf8', 0, 5), '%PDF-');
    assert.match(buf.toString('utf8'), /whale-fake-soffice-cache-test/);
    assert.ok(existsSync(cachePath), 'cache file should exist on disk');
    const counterBytes = await fsp.readFile(counterPath);
    assert.strictEqual(counterBytes.length, 1, 'fake soffice ran exactly once');
  });

  it('on second call (cache hit), does not re-invoke soffice', async () => {
    // Cache is now populated from the previous test.
    const before = (await fsp.readFile(counterPath)).length;
    const buf = await loadOfficePdf(srcPath, { sofficePath: fakeBin });
    const after = (await fsp.readFile(counterPath)).length;
    assert.strictEqual(after, before, 'fake soffice not invoked on cache hit');
    assert.strictEqual(buf.toString('utf8', 0, 5), '%PDF-');
  });

  it('regenerates when source mtime moves past the cache mtime', async () => {
    // Pin src mtime to far past so cache mtime (now-ish) is greater.
    await pinMtimePast(srcPath, '2010-01-01T00:00:00Z');
    // First load: cache hit (we wrote the cache in the first test with a
    // newer-atime, and we haven't bumped src past it).
    let counter = (await fsp.readFile(counterPath)).length;
    await loadOfficePdf(srcPath, { sofficePath: fakeBin });
    assert.strictEqual(
      (await fsp.readFile(counterPath)).length,
      counter,
      'cache hit when src is older than cache'
    );

    // Now bump src to far future — cache should be regenerated.
    await pinMtimePast(srcPath, '2099-01-01T00:00:00Z');
    counter = (await fsp.readFile(counterPath)).length;
    await loadOfficePdf(srcPath, { sofficePath: fakeBin });
    assert.strictEqual(
      (await fsp.readFile(counterPath)).length,
      counter + 1,
      'cache miss after src mtime bumped past cache'
    );
  });

  it('dedupes 8 concurrent loadOfficePdf calls to a single soffice invocation', async () => {
    // Pin src to past so we hit cache-miss, then run 8 concurrent loads.
    await pinMtimePast(srcPath, '2010-01-01T00:00:00Z');
    await fsp.rm(cachePath, { force: true });
    await fsp.writeFile(counterPath, '');

    const promises = Array.from({ length: 8 }, () =>
      loadOfficePdf(srcPath, { sofficePath: fakeBin })
    );
    const results = await Promise.all(promises);
    assert.strictEqual(results.length, 8);
    const counterBytes = await fsp.readFile(counterPath);
    assert.strictEqual(
      counterBytes.length,
      1,
      'inflight dedup: 8 concurrent loads → 1 fake soffice run'
    );
    // All callers received the same buffer (same in-flight Promise).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.ok(results.every((b) => (b as any).compare(results[0] as any) === 0));
  });

  it('passes options.sofficePath through to convertOfficeToPdf (override honored)', async () => {
    const altBin = await makeFakeSoffice(tmp, { tag: 'override-test' });
    await pinMtimePast(srcPath, '2010-01-01T00:00:00Z');
    await fsp.rm(cachePath, { force: true });
    const buf = await loadOfficePdf(srcPath, { sofficePath: altBin });
    assert.match(buf.toString('utf8'), /whale-fake-soffice-override-test/);
  });

  it("removeOfficePdf deletes the cache; subsequent loadOfficePdf regenerates", async () => {
    assert.ok(existsSync(cachePath), 'precondition: cache exists');
    await removeOfficePdf(srcPath);
    assert.strictEqual(existsSync(cachePath), false, 'cache deleted');

    await pinMtimePast(srcPath, '2010-01-01T00:00:00Z');
    const counterBefore = (await fsp.readFile(counterPath)).length;
    const buf = await loadOfficePdf(srcPath, { sofficePath: fakeBin });
    const counterAfter = (await fsp.readFile(counterPath)).length;
    assert.strictEqual(
      counterAfter,
      counterBefore + 1,
      'regenerated after remove'
    );
    assert.ok(buf.length > 0);
  });

  it('moveOfficePdf relocates the cache to the new path; old path is cold', async () => {
    // Set up: cache at original path.
    await pinMtimePast(srcPath, '2010-01-01T00:00:00Z');
    await loadOfficePdf(srcPath, { sofficePath: fakeBin });
    assert.ok(existsSync(cachePath), 'precondition: cache exists at old');

    // moveOfficePdf only relocates the *cache* file (the rename/move IPC
    // hook in main process handles the source file separately). Create the
    // new source file so loadOfficePdf can find it.
    const newSrc = path.join(tmp, 'renamed.docx');
    await fsp.writeFile(newSrc, 'renamed docx payload');
    await pinMtimePast(newSrc, '2010-01-01T00:00:00Z');
    const newCache = officePdfPathFor(newSrc);
    await moveOfficePdf(srcPath, newSrc);

    assert.ok(existsSync(newCache), 'cache relocated to new path');
    assert.strictEqual(existsSync(cachePath), false, 'old cache removed');

    // Load at new path should hit cache (no soffice invocation).
    const counterBefore = (await fsp.readFile(counterPath)).length;
    const buf = await loadOfficePdf(newSrc, { sofficePath: fakeBin });
    assert.strictEqual(
      (await fsp.readFile(counterPath)).length,
      counterBefore,
      'cache hit at new path after move'
    );
    assert.strictEqual(buf.toString('utf8', 0, 5), '%PDF-');

    // Clean up the test-created files.
    await fsp.rm(newSrc, { force: true });
    await fsp.rm(newCache, { force: true });
  });

  it('copyOfficePdf duplicates the cache without removing the source', async () => {
    const src = path.join(tmp, 'copy-src.docx');
    const dest = path.join(tmp, 'copy-dest.docx');
    await fsp.writeFile(src, 'src docx bytes');
    await fsp.writeFile(dest, 'dest docx bytes');

    // Populate cache for src.
    await pinMtimePast(src, '2010-01-01T00:00:00Z');
    await loadOfficePdf(src, { sofficePath: fakeBin });
    assert.ok(existsSync(officePdfPathFor(src)), 'precondition: src cache exists');

    await copyOfficePdf(src, dest);
    assert.ok(
      existsSync(officePdfPathFor(src)),
      'source cache preserved after copy'
    );
    assert.ok(
      existsSync(officePdfPathFor(dest)),
      'destination cache created'
    );

    // Cleanup.
    await removeOfficePdf(src);
    await removeOfficePdf(dest);
    await fsp.rm(src, { force: true });
    await fsp.rm(dest, { force: true });
  });

  it('copyOfficePdf is a no-op when source has no cache', async () => {
    const src = path.join(tmp, 'no-cache-src.docx');
    const dest = path.join(tmp, 'no-cache-dest.docx');
    await fsp.writeFile(src, 'x');
    await fsp.writeFile(dest, 'y');
    assert.strictEqual(existsSync(officePdfPathFor(src)), false);

    await copyOfficePdf(src, dest);
    assert.strictEqual(
      existsSync(officePdfPathFor(dest)),
      false,
      'no cache created when source had none'
    );

    await fsp.rm(src, { force: true });
    await fsp.rm(dest, { force: true });
  });

  it('throws when the source office file is gone', async () => {
    const ghost = path.join(tmp, 'ghost.docx');
    await assert.rejects(
      () => loadOfficePdf(ghost, { sofficePath: fakeBin }),
      /source office file is gone/
    );
  });
});