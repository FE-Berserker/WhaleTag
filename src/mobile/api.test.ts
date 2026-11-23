import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLanClient,
  fileUrl,
  LanApiError,
  TEXT_PREVIEW_LIMIT,
} from './api';
import type { FetchLike } from './api';

interface Call {
  url: string;
  init?: RequestInit;
}

function response(status: number, body = '', headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    body: null,
    json: async () => JSON.parse(body) as unknown,
    text: async () => body,
  } as Response;
}

function recorder(...responses: Response[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      const next = responses.shift();
      if (!next) throw new Error('Unexpected fetch');
      return next;
    },
  };
}

describe('mobile LAN API', () => {
  it('pairs with a bearer token and uses the read-only session header', async () => {
    const { fetch, calls } = recorder(response(204));
    await createLanClient(fetch).pair('secret token');
    assert.equal(calls[0].url, '/api/session');
    assert.equal(calls[0].init?.method, 'POST');
    assert.equal(calls[0].init?.credentials, 'same-origin');
    assert.deepEqual(calls[0].init?.headers, {
      'X-Whale-Request': 'read-only',
      Authorization: 'Bearer secret token',
    });
  });

  it('loads roots, directories, tags, and search through contract URLs', async () => {
    const payloads = [
      { roots: [] },
      { rootId: 'root', id: '', name: 'Root', path: '/', parentId: null, entries: [] },
      { tags: ['work'], indexUnavailable: false },
      { entries: [], indexUnavailable: true },
    ];
    const { fetch, calls } = recorder(...payloads.map((value) => response(200, JSON.stringify(value))));
    const client = createLanClient(fetch);
    await client.roots();
    await client.list('root id', 'folder/1');
    await client.tags('root id');
    await client.search('root id', '  report 2026  ', 'a&b');
    assert.deepEqual(calls.map((call) => call.url), [
      '/api/roots',
      '/api/list?rootId=root+id&id=folder%2F1',
      '/api/tags?rootId=root+id',
      '/api/search?rootId=root+id&q=report+2026&tag=a%26b',
    ]);
    for (const call of calls) {
      assert.deepEqual(call.init?.headers, { 'X-Whale-Request': 'read-only' });
    }
  });

  it('builds file URLs without exposing tokens', () => {
    assert.equal(
      fileUrl('root 1', 'a/b', true),
      '/api/file?rootId=root+1&id=a%2Fb&download=1',
    );
    assert.equal(fileUrl('root', 'file'), '/api/file?rootId=root&id=file');
  });

  it('reads a small text response with a bounded Range request', async () => {
    const { fetch, calls } = recorder(response(200, 'hello', { 'Content-Length': '5' }));
    const preview = await createLanClient(fetch).text('root', 'notes');
    assert.deepEqual(preview, { text: 'hello', truncated: false });
    assert.deepEqual(calls[0].init?.headers, {
      'X-Whale-Request': 'read-only',
      Range: `bytes=0-${TEXT_PREVIEW_LIMIT - 1}`,
    });
    assert.equal(calls[0].init?.credentials, 'same-origin');
  });

  it('accepts a valid partial response and reports truncation', async () => {
    const partial = response(206, 'partial', {
      'Content-Range': `bytes 0-${TEXT_PREVIEW_LIMIT - 1}/1000000`,
    });
    const preview = await createLanClient(recorder(partial).fetch).text('root', 'large');
    assert.deepEqual(preview, { text: 'partial', truncated: true });
  });

  it('cancels an unbounded or invalid response instead of reading it', async () => {
    let cancelled = 0;
    let reads = 0;
    const oversized = response(200, 'must not be read', { 'Content-Length': '999999999' });
    Object.assign(oversized, {
      body: { cancel: async () => { cancelled += 1; } },
      text: async () => { reads += 1; return ''; },
    });
    const preview = await createLanClient(recorder(oversized).fetch).text('root', 'large');
    assert.deepEqual(preview, { text: '', truncated: true });
    assert.equal(cancelled, 1);
    assert.equal(reads, 0);

    const invalid = response(206, 'must not be read', { 'Content-Range': 'bytes 100-200/1000' });
    Object.assign(invalid, { body: { cancel: async () => { cancelled += 1; } } });
    await assert.rejects(() => createLanClient(recorder(invalid).fetch).text('root', 'bad'), LanApiError);
    assert.equal(cancelled, 2);
  });

  it('treats the fixed empty-file Range response as empty text', async () => {
    const empty = response(416, '', { 'Content-Range': 'bytes */0' });
    const preview = await createLanClient(recorder(empty).fetch).text('root', 'empty');
    assert.deepEqual(preview, { text: '', truncated: false });
  });

  it('surfaces HTTP failures as LanApiError', async () => {
    await assert.rejects(
      () => createLanClient(recorder(response(401)).fetch).roots(),
      (error: unknown) => error instanceof LanApiError && error.status === 401,
    );
  });

  it('probes a file with HEAD so media failures can detect an expired session', async () => {
    const { fetch, calls } = recorder(response(200));
    await createLanClient(fetch).probe('root', 'file');
    assert.equal(calls[0].url, '/api/file?rootId=root&id=file');
    assert.equal(calls[0].init?.method, 'HEAD');
    assert.equal(calls[0].init?.credentials, 'same-origin');
    assert.deepEqual(calls[0].init?.headers, { 'X-Whale-Request': 'read-only' });

    await assert.rejects(
      () => createLanClient(recorder(response(401)).fetch).probe('root', 'file'),
      (error: unknown) => error instanceof LanApiError && error.status === 401,
    );
  });

  it('refuses to read a 200 response without Content-Length', async () => {
    let cancelled = 0;
    let reads = 0;
    const unbounded = response(200, 'must not be read');
    Object.assign(unbounded, {
      body: { cancel: async () => { cancelled += 1; } },
      text: async () => { reads += 1; return ''; },
    });
    const preview = await createLanClient(recorder(unbounded).fetch).text('root', 'unknown');
    assert.deepEqual(preview, { text: '', truncated: true });
    assert.equal(cancelled, 1);
    assert.equal(reads, 0);
  });

  it('treats a blank Content-Length as unbounded instead of zero', async () => {
    let cancelled = 0;
    let reads = 0;
    const blank = response(200, 'must not be read', { 'Content-Length': '' });
    Object.assign(blank, {
      body: { cancel: async () => { cancelled += 1; } },
      text: async () => { reads += 1; return ''; },
    });
    const preview = await createLanClient(recorder(blank).fetch).text('root', 'unknown');
    assert.deepEqual(preview, { text: '', truncated: true });
    assert.equal(cancelled, 1);
    assert.equal(reads, 0);
  });
});
