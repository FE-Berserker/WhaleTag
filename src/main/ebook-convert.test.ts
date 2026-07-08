import { describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';
import { convertEbookToEpub, ebookConvertBinary } from './ebook-convert';

/**
 * Creates a fake `ebook-convert` script that writes a small deterministic EPUB
 * (just a ZIP with a marker file) to the requested output path. This avoids
 * requiring the real Calibre suite in tests.
 */
async function makeFakeCalibre(tmp: string): Promise<string> {
  const isWin = process.platform === 'win32';
  const script = isWin ? 'ebook-convert.cmd' : 'ebook-convert';
  const scriptPath = path.join(tmp, script);

  // Minimal valid ZIP: one empty entry named "marker.txt".
  const zipBase64 =
    'UEsDBBQAAAAIACeSxlAAAAAAAAAAAAAAAAAJAAAAG1hcmtlci50eHRVVA0AB2s7gWdrO4Fn' +
    'azuBZ3V4CwABBPUBAAAEFAAAAFBLAwIeAxQAAAAIACeSxlAAAAAAAAAAAAAAAAAJAAAAA2' +
    '1hcmtlci50eHRVVA0AB2s7gWdrO4FnazuBZ3V4CwABBPUBAAAEFAAAAAAkAFAAAAAAAAAA' +
    'AAAAAAAAAAB0ZXN0UEsFBgAAAAACAAIAeAAAAFgAAAAAAA==';

  const js =
    "const fs = require('fs');\n" +
    "const output = process.argv[3];\n" +
    `fs.writeFileSync(output, Buffer.from('${zipBase64}', 'base64'));\n`;

  if (isWin) {
    await fsp.writeFile(scriptPath, `@node "%~dpn0.js" %*\n`);
    await fsp.writeFile(path.join(tmp, 'ebook-convert.js'), js);
  } else {
    await fsp.writeFile(scriptPath, `#!/usr/bin/env node\n${js}`);
    await fsp.chmod(scriptPath, 0o755);
  }

  return scriptPath;
}

describe('ebook-convert', () => {
  it('throws when Calibre is missing', async () => {
    await assert.rejects(
      () =>
        convertEbookToEpub('/nonexistent/book.mobi', {
          calibrePath: '/definitely/not/ebook-convert',
        }),
      /Calibre/
    );
  });

  it('detects an explicit Calibre override', () => {
    const override = '/custom/ebook-convert';
    assert.strictEqual(ebookConvertBinary(override), override);
  });

  it('converts using a fake Calibre binary', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-ebook-test-'));
    try {
      const fakeBin = await makeFakeCalibre(tmp);
      const input = path.join(tmp, 'book.mobi');
      await fsp.writeFile(input, 'fake mobi bytes');

      const buf = await convertEbookToEpub(input, { calibrePath: fakeBin });
      assert.ok(buf.length > 0);
      // Minimal ZIP sanity: starts with PK.
      assert.strictEqual(buf[0], 0x50);
      assert.strictEqual(buf[1], 0x4b);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('throws when the converter produces no output', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-ebook-test-'));
    try {
      const noOpScript = path.join(
        tmp,
        process.platform === 'win32' ? 'noop.cmd' : 'noop'
      );
      if (process.platform === 'win32') {
        await fsp.writeFile(noOpScript, '@echo off\n');
      } else {
        await fsp.writeFile(noOpScript, '#!/bin/sh\nexit 0\n');
        await fsp.chmod(noOpScript, 0o755);
      }

      const input = path.join(tmp, 'book.mobi');
      await fsp.writeFile(input, 'fake mobi bytes');

      await assert.rejects(
        () => convertEbookToEpub(input, { calibrePath: noOpScript }),
        /did not produce/
      );
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
