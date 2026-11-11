import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  parseRange,
  createFileRangeResponse,
  createBackpressuredWebStream,
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

  it('preserves MIME/CSP headers and serves an exact one-byte offset', async () => {
    const req = new Request('whale-file:///x', {
      headers: { Range: 'bytes=10-10' },
    });
    const res = createFileRangeResponse(
      file,
      req,
      new Headers({
        'Content-Type': 'video/mp4',
        'Content-Security-Policy': "default-src 'none'",
      })
    );
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('Content-Type'), 'video/mp4');
    assert.equal(res.headers.get('Content-Security-Policy'), "default-src 'none'");
    assert.equal(res.headers.get('Content-Range'), 'bytes 10-10/20');
    assert.deepEqual(await readBody(res), enc.encode('A'));
  });
});

const nextTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

describe('createBackpressuredWebStream', () => {
  it('does not drain the producer while the consumer is stalled', async () => {
    const chunkCount = 32;
    const produced: number[] = [];
    const source = new Readable({
      // Keep Node's own permitted read-ahead tiny so the assertion isolates
      // the adapter's backpressure rather than the producer's buffer size.
      highWaterMark: 1,
      read() {
        const next = produced.length;
        if (next === chunkCount) {
          this.push(null);
          return;
        }
        produced.push(next);
        this.push(Buffer.from([next]));
      },
    });

    const body = createBackpressuredWebStream(source);
    // Construction may fill the web queue once. After that initial pull, the
    // producer must stay bounded and then quiescent while nobody reads.
    await nextTurn();
    await nextTurn();
    assert.ok(produced.length > 0, 'the initial queue pull should read');
    assert.ok(
      produced.length < chunkCount,
      `stalled consumer caused ${produced.length}/${chunkCount} producer reads`
    );
    const stalledAt = produced.length;
    await nextTurn();
    assert.equal(produced.length, stalledAt);

    const reader = body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.deepEqual(first.value, new Uint8Array([0]));
    await nextTurn();
    assert.ok(
      produced.length > stalledAt,
      'a consumer read should permit another producer pull'
    );
    assert.ok(produced.length < chunkCount);

    await reader.cancel();
    assert.equal(source.destroyed, true);
  });

  it('destroys the producer when the consumer cancels a pending read', async () => {
    const source = new Readable({ read() {} });
    const reader = createBackpressuredWebStream(source).getReader();
    const pending = reader.read();
    await nextTurn();

    await reader.cancel();
    const result = await pending;
    assert.equal(result.done, true);
    assert.equal(source.destroyed, true);
  });

  it('propagates producer errors and tears down the stream', async () => {
    const expected = new Error('producer failed');
    const source = new Readable({
      read() {
        queueMicrotask(() => this.destroy(expected));
      },
    });
    const reader = createBackpressuredWebStream(source).getReader();

    await assert.rejects(reader.read(), (err) => {
      assert.equal(err, expected);
      return true;
    });
    assert.equal(source.destroyed, true);
  });

  it('finishes a pending read when the producer is destroyed', async () => {
    const source = new Readable({ read() {} });
    const reader = createBackpressuredWebStream(source).getReader();
    const pending = reader.read();
    await nextTurn();

    source.destroy();
    const result = await pending;
    assert.equal(result.done, true);
    assert.equal(source.destroyed, true);
  });
});

