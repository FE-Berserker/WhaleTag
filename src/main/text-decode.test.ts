/**
 * Co-located tests for the shared text decoder (`decodeTextBuffer`).
 *
 * The decoder is the single encoding policy shared by the viewer read path
 * (`ipc/fs-read.ts`), the MCP extract tool and the full-text indexer
 * (`fulltext.ts`), so these tests pin the policy itself.
 *
 * jschardet is loaded lazily through `lazy-native` (`createRequire`), which is
 * what lets us swap it for a throwing stub to prove the valid-UTF-8 fast path
 * never pays for charset detection.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import iconv from 'iconv-lite';

import { decodeTextBuffer } from './text-decode';

const require_ = createRequire(__filename);
const saved = new Map<string, NodeJS.Module | undefined>();

function inject(spec: string, exports: unknown): void {
  const id = require_.resolve(spec);
  if (!saved.has(id)) saved.set(id, require_.cache[id]);
  require_.cache[id] = {
    id,
    filename: id,
    loaded: true,
    exports,
    children: [],
    paths: [],
  } as unknown as NodeJS.Module;
}

function restore(): void {
  for (const [id, mod] of saved) {
    if (mod) require_.cache[id] = mod;
    else delete require_.cache[id];
  }
  saved.clear();
}

function countReplacements(s: string): number {
  let count = 0;
  let idx = s.indexOf('\uFFFD');
  while (idx !== -1) {
    count++;
    idx = s.indexOf('\uFFFD', idx + 1);
  }
  return count;
}

after(() => restore());

describe('decodeTextBuffer', () => {
  it('returns valid UTF-8 / ASCII untouched WITHOUT running charset detection', () => {
    let detectCalls = 0;
    inject('jschardet', {
      detect: () => {
        detectCalls++;
        return { encoding: 'UTF-8', confidence: 1 };
      },
    });
    const samples = [
      'plain ascii text\n',
      'héllo — 中文 ✓ “quotes” 😀 emoji',
      'console.log("ok");\n\ttabbed\n',
      '',
    ];
    for (const sample of samples) {
      assert.equal(decodeTextBuffer(Buffer.from(sample, 'utf8')), sample);
    }
    assert.equal(detectCalls, 0, 'valid UTF-8 must take the fast path');
    restore();
  });

  it('strips a UTF-8 BOM', () => {
    const buf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('bom 文本', 'utf8'),
    ]);
    assert.equal(decodeTextBuffer(buf), 'bom 文本');
  });

  it('decodes legacy GBK / Shift-JIS / Windows-1252 documents', () => {
    const gbk = '你好，世界。这是一个 GBK 编码的测试文件，用于验证全文检索。';
    assert.equal(decodeTextBuffer(iconv.encode(gbk, 'gbk')), gbk);

    const sjis = 'これはShift_JISで書かれた日本語のテキストです。全文検索に使います。';
    assert.equal(decodeTextBuffer(iconv.encode(sjis, 'shift_jis')), sjis);

    const latin = 'café naïve — déjà vu';
    const cp1252 = iconv.encode(latin, 'windows-1252');
    assert.equal(countReplacements(cp1252.toString('utf8')) > 0, true);
    assert.equal(decodeTextBuffer(cp1252), iconv.decode(cp1252, 'windows-1252'));
    assert.equal(decodeTextBuffer(cp1252).includes('café'), true);
  });

  it('decodes UTF-16LE with a BOM (NUL bytes leave the fast path)', () => {
    const buf = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('你好 hello', 'utf16le'),
    ]);
    assert.equal(decodeTextBuffer(buf), '你好 hello');
  });

  it('prefers the legacy decoding when a GBK file holds a few invalid bytes', () => {
    const ok = iconv.encode('你好，世界。这是一个 GBK 编码的测试文件，用于验证全文检索。', 'gbk');
    const mixed = Buffer.concat([ok, Buffer.from([0x80, 0x80, 0x80, 0x80])]);
    const utf8 = mixed.toString('utf8');
    const expected = iconv.decode(mixed, 'gbk');
    assert.equal(countReplacements(utf8) > 0, true, 'fixture must not be valid UTF-8');
    const result = decodeTextBuffer(mixed);
    assert.equal(result, expected);
    assert.equal(countReplacements(result) < countReplacements(utf8), true);
  });

  it('falls back to UTF-8 when detection has no confident answer', () => {
    // chardet: { encoding: null, confidence: 0 } for this byte run.
    const buf = Buffer.from([0x80, 0x81, 0x82]);
    assert.equal(decodeTextBuffer(buf), buf.toString('utf8'));
  });

  it('decodes lone high-ANSI bytes as Windows-1252 instead of U+FFFD', () => {
    const buf = Buffer.from([0xa0, 0xa1, 0xa2]);
    assert.equal(decodeTextBuffer(buf), iconv.decode(buf, 'windows-1252'));
    assert.equal(countReplacements(decodeTextBuffer(buf)), 0);
  });
});
