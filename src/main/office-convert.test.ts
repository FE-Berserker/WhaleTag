import { describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';
import {
  convertOfficeToPdf,
  isSofficeAvailable,
} from './office-convert';
import { sofficeConvertArgs, sofficeBinary } from './thumbnail';

/**
 * Creates a fake `soffice` script that mimics LibreOffice's CLI:
 *   - parses `--outdir <dir>` and the source-path (last positional) from argv
 *   - writes a deterministic PDF marker (`%PDF-` + 8 sentinel bytes) to
 *     `<dir>/<basename(src)>.pdf`
 *   - increments a counter file in cwd on every invocation
 *   - supports a side-channel via env var: WHALE_FAKE_SOFFICE_FAIL=<code>
 *     makes it write to stderr and exit with that code (for the §16.13 fix
 *     test — verifies stderr surfaces in the thrown error).
 *   - supports WHALE_FAKE_SOFFICE_NO_OUTPUT=1 to exit 0 without writing the PDF
 *     (for the "did not produce a PDF" branch).
 *   - supports WHALE_FAKE_SOFFICE_SLEEP_MS=<n> to sleep before finishing
 *     (for the timeout test).
 *
 * Avoids requiring the real LibreOffice suite in tests — same shim pattern
 * as `ebook-convert.test.ts` (makeFakeCalibre) and `archive.test.ts`
 * (7zip shim).
 */
async function makeFakeSoffice(
  tmp: string,
  opts: { counterName?: string } = {}
): Promise<string> {
  const isWin = process.platform === 'win32';
  const script = isWin ? 'soffice.cmd' : 'soffice';
  const scriptPath = path.join(tmp, script);

  // soffice arg layout: --headless --norestore --nologo --nofirststartwizard
  //   --convert-to pdf --outdir <dir> <src>
  // We pick out --outdir and the last positional.
  const js = `
const fs = require('fs');
const args = process.argv.slice(2);
let outdir = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--outdir' && i + 1 < args.length) { outdir = args[i+1]; i++; }
}
const src = args[args.length - 1];
const sleepMs = parseInt(process.env.WHALE_FAKE_SOFFICE_SLEEP_MS || '0', 10);
if (sleepMs > 0) {
  const end = Date.now() + sleepMs;
  while (Date.now() < end) {}
}
if (process.env.WHALE_FAKE_SOFFICE_NO_OUTPUT === '1') {
  process.exit(0);
}
const failCode = process.env.WHALE_FAKE_SOFFICE_FAIL;
if (failCode) {
  process.stderr.write('fake diagnostic ' + failCode + '\\n');
  process.exit(parseInt(failCode, 10));
}
if (outdir && src) {
  const base = src.split(/[\\\\/]/).pop().replace(/\\.[^.]+$/, '');
  const outPath = outdir + '/' + base + '.pdf';
  // Minimal PDF-looking payload — first 5 bytes are %PDF- magic so callers
  // can sanity-check, rest is a deterministic sentinel.
  const payload = Buffer.concat([
    Buffer.from('%PDF-1.4\\n'),
    Buffer.from('whale-fake-soffice-' + (process.env.WHALE_FAKE_SOFFICE_TAG || 'default') + '\\n'),
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

describe('sofficeConvertArgs', () => {
  it('returns the expected arg layout with the speed flags', () => {
    const args = sofficeConvertArgs('/tmp/out', '/tmp/in.docx');
    assert.deepStrictEqual(args, [
      '--headless',
      '--norestore',
      '--nologo',
      '--nofirststartwizard',
      '--convert-to',
      'pdf',
      '--outdir',
      '/tmp/out',
      '/tmp/in.docx',
    ]);
  });
});

describe('office-convert (with fake soffice)', () => {
  it('throws when soffice override points to a missing file', async () => {
    // The override is taken as-is by sofficeBinary (it does NOT do a
    // pre-flight existsSync check), so the failure surfaces from spawn as
    // ENOENT wrapped in our `soffice failed:` prefix. Match either signal.
    await assert.rejects(
      () =>
        convertOfficeToPdf('/nonexistent.docx', {
          sofficePath: '/definitely/not/soffice',
        }),
      /soffice failed:|ENOENT/
    );
  });

  it('sofficeBinary honours explicit override', () => {
    assert.strictEqual(sofficeBinary('/custom/soffice'), '/custom/soffice');
  });

  it('isSofficeAvailable delegates to sofficeBinary', () => {
    // Smoke check — actual value depends on host having real soffice installed.
    // We only assert the function is callable and returns a boolean.
    assert.strictEqual(typeof isSofficeAvailable(), 'boolean');
  });

  it('converts using a fake soffice binary and returns the produced bytes', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-office-test-'));
    try {
      const fakeBin = await makeFakeSoffice(tmp);
      const input = path.join(tmp, 'report.docx');
      await fsp.writeFile(input, 'fake docx bytes');

      const buf = await convertOfficeToPdf(input, { sofficePath: fakeBin });
      assert.ok(buf.length > 0);
      // PDF magic check.
      assert.strictEqual(buf.toString('utf8', 0, 5), '%PDF-');
      // Default sentinel from the fake.
      assert.match(buf.toString('utf8'), /whale-fake-soffice-default/);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("throws 'did not produce a PDF' when fake exits 0 without writing output", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-office-test-'));
    try {
      const fakeBin = await makeFakeSoffice(tmp);
      const input = path.join(tmp, 'a.docx');
      await fsp.writeFile(input, 'x');
      const prev = process.env.WHALE_FAKE_SOFFICE_NO_OUTPUT;
      process.env.WHALE_FAKE_SOFFICE_NO_OUTPUT = '1';
      try {
        await assert.rejects(
          () => convertOfficeToPdf(input, { sofficePath: fakeBin }),
          /did not produce/
        );
      } finally {
        if (prev === undefined) delete process.env.WHALE_FAKE_SOFFICE_NO_OUTPUT;
        else process.env.WHALE_FAKE_SOFFICE_NO_OUTPUT = prev;
      }
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('surfaces stderr in the error message when fake exits non-zero (§16.13 fix)', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-office-test-'));
    try {
      const fakeBin = await makeFakeSoffice(tmp);
      const input = path.join(tmp, 'b.docx');
      await fsp.writeFile(input, 'x');
      const prevFail = process.env.WHALE_FAKE_SOFFICE_FAIL;
      process.env.WHALE_FAKE_SOFFICE_FAIL = '2';
      try {
        await assert.rejects(
          () => convertOfficeToPdf(input, { sofficePath: fakeBin }),
          (err: Error) => {
            // Must contain the stderr sentinel from the fake — proves the
            // §16.13 capture-fix is wired (without it, the message is just
            // "Command failed: ...").
            assert.match(err.message, /fake diagnostic 2/);
            assert.match(err.message, /soffice failed:/);
            return true;
          }
        );
      } finally {
        if (prevFail === undefined) delete process.env.WHALE_FAKE_SOFFICE_FAIL;
        else process.env.WHALE_FAKE_SOFFICE_FAIL = prevFail;
      }
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('honours options.timeout (rejects when fake sleeps past it)', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-office-test-'));
    try {
      const fakeBin = await makeFakeSoffice(tmp);
      const input = path.join(tmp, 'c.docx');
      await fsp.writeFile(input, 'x');
      const prevSleep = process.env.WHALE_FAKE_SOFFICE_SLEEP_MS;
      process.env.WHALE_FAKE_SOFFICE_SLEEP_MS = '3000';
      try {
        await assert.rejects(
          () =>
            convertOfficeToPdf(input, {
              sofficePath: fakeBin,
              timeout: 200,
            }),
          (err: Error) => {
            // Node sets err.message to "Command failed: ..." and err.killed=true
            // when the child is killed by timeout — we don't pin to a specific
            // message shape (varies by Node version) but the failure must
            // happen, not silently complete.
            assert.ok(err instanceof Error);
            return true;
          }
        );
      } finally {
        if (prevSleep === undefined)
          delete process.env.WHALE_FAKE_SOFFICE_SLEEP_MS;
        else process.env.WHALE_FAKE_SOFFICE_SLEEP_MS = prevSleep;
      }
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});