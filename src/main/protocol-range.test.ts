import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyExtensionCors,
  createFileRangeResponse,
  extensionCorsPreflight,
  parseRange,
} from './protocol-range';

const enc = new TextEncoder();
const bytes = enc.encode('0123456789ABCDEFGHIJ'); // 20 bytes

/**
 * `parseRange` was a private, untested function in main.ts before the
 * whale-audio work factored it into protocol-range.ts. It's the core of the
 * Range/206 serving shared by `whale-file://` and `whale-audio://`'s cache-hit
 * branch — a bug here breaks seeking for every media file. These tests pin the
 * accepted forms and the explicit rejections.
 */
describe('parseRange', () => {
  it('parses bytes=START-END', () => {
    assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
    assert.deepEqual(parseRange('bytes=500-999', 1000), { start: 500, end: 999 });
  });

  it('parses open-ended bytes=START- (to end)', () => {
    assert.deepEqual(parseRange('bytes=0-', 1000), { start: 0, end: 999 });
    assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  });

  it('returns null for malformed input', () => {
    assert.equal(parseRange('', 1000), null);
    assert.equal(parseRange('bytes=', 1000), null);
    assert.equal(parseRange('bytes=-500', 1000), null); // suffix form unsupported
    assert.equal(parseRange('bytes=abc-100', 1000), null);
    assert.equal(parseRange('not-a-range', 1000), null);
  });

  it('returns null for multi-range (unsupported)', () => {
    assert.equal(parseRange('bytes=0-10,20-30', 1000), null);
  });

  it('returns null for out-of-bounds requests', () => {
    assert.equal(parseRange('bytes=1000-2000', 1000), null); // start at EOF
    assert.equal(parseRange('bytes=999-1000', 1000), null); // end past last byte
    assert.equal(parseRange('bytes=500-499', 1000), null); // end < start
    assert.equal(parseRange('bytes=0-999', 0), null); // empty file
  });
});

/**
 * `createFileRangeResponse` is the shared file-serving path for whale-file and
 * whale-audio (cache-hit). Smoke-test that the refactor didn't change the
 * 200 / 206 + Content-Range + byte-slice behavior that `<video>` / `<audio>`
 * rely on.
 */
describe('createFileRangeResponse', () => {
  let dir: string;
  let file: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'whale-range-'));
    file = join(dir, 'sample.bin');
    writeFileSync(file, bytes);
  });
  after(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  async function readBody(res: Response): Promise<Uint8Array> {
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value as Uint8Array);
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  it('serves the full file with 200 when no Range header', async () => {
    const req = new Request('whale-file:///x');
    const res = createFileRangeResponse(
      file,
      req,
      new Headers({ 'Content-Type': 'application/octet-stream' })
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
    assert.equal(res.headers.get('Content-Length'), '20');
    assert.deepEqual(await readBody(res), bytes);
  });

  it('serves a 206 partial slice with Content-Range', async () => {
    const req = new Request('whale-file:///x', {
      headers: { Range: 'bytes=5-9' },
    });
    const res = createFileRangeResponse(
      file,
      req,
      new Headers({ 'Content-Type': 'application/octet-stream' })
    );
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('Content-Range'), 'bytes 5-9/20');
    assert.equal(res.headers.get('Content-Length'), '5');
    assert.deepEqual(await readBody(res), enc.encode('56789'));
  });

  it('serves an open-ended range to the end', async () => {
    const req = new Request('whale-file:///x', {
      headers: { Range: 'bytes=15-' },
    });
    const res = createFileRangeResponse(
      file,
      req,
      new Headers({ 'Content-Type': 'application/octet-stream' })
    );
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('Content-Range'), 'bytes 15-19/20');
    assert.deepEqual(await readBody(res), enc.encode('FGHIJ'));
  });

  it('falls back to 200 for a malformed Range', async () => {
    const req = new Request('whale-file:///x', {
      headers: { Range: 'bytes=-500' },
    });
    const res = createFileRangeResponse(
      file,
      req,
      new Headers({ 'Content-Type': 'application/octet-stream' })
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await readBody(res), bytes);
  });
});

describe('applyExtensionCors', () => {
  it('echoes a whale-extension origin and exposes the Range headers', () => {
    const headers = new Headers({ 'Content-Type': 'application/pdf' });
    const req = new Request('whale-file:///x', {
      headers: { Origin: 'whale-extension://pdf-viewer' },
    });
    applyExtensionCors(headers, req);
    assert.equal(
      headers.get('Access-Control-Allow-Origin'),
      'whale-extension://pdf-viewer'
    );
    assert.equal(
      headers.get('Access-Control-Expose-Headers'),
      'Accept-Ranges, Content-Range, Content-Length'
    );
  });

  it('sets nothing for a non-extension origin', () => {
    const headers = new Headers();
    const req = new Request('whale-file:///x', {
      headers: { Origin: 'https://evil.example' },
    });
    applyExtensionCors(headers, req);
    assert.equal(headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(headers.get('Access-Control-Expose-Headers'), null);
  });

  it('sets nothing when no Origin header is present', () => {
    const headers = new Headers();
    applyExtensionCors(headers, new Request('whale-file:///x'));
    assert.equal(headers.get('Access-Control-Allow-Origin'), null);
  });
});

describe('extensionCorsPreflight', () => {
  it('returns null for non-OPTIONS requests', () => {
    assert.equal(
      extensionCorsPreflight(new Request('whale-file:///x')),
      null
    );
  });

  it('answers 204 with Range method+headers for an extension origin', () => {
    const res = extensionCorsPreflight(
      new Request('whale-file:///x', {
        method: 'OPTIONS',
        headers: { Origin: 'whale-extension://office-viewer' },
      })
    );
    assert.ok(res);
    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get('Access-Control-Allow-Origin'),
      'whale-extension://office-viewer'
    );
    assert.equal(
      res.headers.get('Access-Control-Allow-Methods'),
      'GET, OPTIONS'
    );
    assert.equal(
      res.headers.get('Access-Control-Allow-Headers'),
      'Range, Content-Type'
    );
  });

  it('refuses OPTIONS from a non-extension origin', () => {
    const res = extensionCorsPreflight(
      new Request('whale-file:///x', {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example' },
      })
    );
    assert.ok(res);
    assert.equal(res.status, 403);
  });
});
