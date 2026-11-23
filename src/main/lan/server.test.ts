import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { SearchQuery } from '../../shared/search-query';
import type { LanIndexReader } from './index-reader';
import {
  getLanStatus,
  LAN_REQUEST_HEADER,
  LAN_REQUEST_VALUE,
  startLanServer,
  stopLanServer,
} from './server';
import { encodeEntryId } from './security';

interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text: string;
  json: any;
}

let root: string;
let mobile: string;
let port: number;
let cookie = '';
let queries: SearchQuery[];
let reader: LanIndexReader;

function loopbackInterfaces(): ReturnType<typeof os.networkInterfaces> {
  return {
    lo: [{
      address: '127.0.0.1',
      netmask: '255.0.0.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:00',
      internal: true,
      cidr: '127.0.0.0/8',
    }],
  };
}

function request(
  requestPath: string,
  options: { method?: string; headers?: http.OutgoingHttpHeaders } = {}
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method: options.method ?? 'GET',
      headers: options.headers,
      agent: false,
    }, (res) => {
      const chunks: Uint8Array[] = [];
      res.on('data', (chunk: Uint8Array) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const text = body.toString('utf8');
        let json: any = null;
        if (res.headers['content-type']?.startsWith('application/json') && text) {
          json = JSON.parse(text);
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function boot(options: Parameters<typeof startLanServer>[0] = {}) {
  const status = await startLanServer({
    roots: [root],
    host: '127.0.0.1',
    port: 0,
    mobileRoot: mobile,
    indexReader: reader,
    networkInterfaces: loopbackInterfaces,
    networkPollMs: 60_000,
    ...options,
  });
  port = status.port!;
  cookie = '';
  return status;
}

async function login(): Promise<string> {
  const token = getLanStatus().token!;
  const response = await request('/api/session', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      [LAN_REQUEST_HEADER]: LAN_REQUEST_VALUE,
    },
  });
  assert.equal(response.status, 204);
  const setCookie = response.headers['set-cookie']?.[0] ?? '';
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  cookie = setCookie.split(';', 1)[0];
  return cookie;
}

function apiHeaders(extra: http.OutgoingHttpHeaders = {}): http.OutgoingHttpHeaders {
  return {
    Cookie: cookie,
    [LAN_REQUEST_HEADER]: LAN_REQUEST_VALUE,
    'Sec-Fetch-Site': 'same-origin',
    ...extra,
  };
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-lan-root-'));
  mobile = await fsp.mkdtemp(path.join(os.tmpdir(), 'whale-lan-mobile-'));
  await fsp.mkdir(path.join(root, '.whale'));
  await fsp.mkdir(path.join(root, 'sub', 'nested'), { recursive: true });
  await fsp.writeFile(path.join(root, 'report[filename].txt'), '0123456789');
  await fsp.writeFile(path.join(root, 'note.pdf'), '%PDF-test');
  await fsp.writeFile(path.join(root, '.whale', 'secret.txt'), 'private');
  await fsp.writeFile(path.join(root, 'sub', 'nested', 'leaf.txt'), 'leaf');
  await fsp.writeFile(path.join(root, '.whale', 'wsd.json'), JSON.stringify({
    version: 1,
    files: { 'report[filename].txt': { tags: ['sidecar'] } },
  }));
  await fsp.mkdir(path.join(mobile, 'assets'));
  await fsp.writeFile(path.join(mobile, 'index.html'), '<html><script src="/main.abc123.js"></script></html>');
  await fsp.writeFile(path.join(mobile, 'main.abc123.js'), 'window.lanReady=true;');
  await fsp.writeFile(path.join(mobile, 'assets', 'logo.png'), new Uint8Array([1, 2, 3]));
  queries = [];
  reader = {
    async search(_rootPath, query) {
      queries.push(query);
      return {
        indexUnavailable: false,
        entries: [
          { path: 'report[filename].txt', name: 'report[filename].txt', isDir: false, size: 10, mtime: 0, ext: '.txt', tags: ['indexed'] },
          { path: '../outside.txt', name: 'outside.txt', isDir: false, size: 1, mtime: 0, ext: '.txt', tags: [] },
          { path: '.whale/secret.txt', name: 'secret.txt', isDir: false, size: 1, mtime: 0, ext: '.txt', tags: [] },
          { path: 'missing.txt', name: 'missing.txt', isDir: false, size: 1, mtime: 0, ext: '.txt', tags: [] },
        ],
      };
    },
    async tags() {
      return { tags: ['alpha', 'beta'], indexUnavailable: false };
    },
  };
});

afterEach(async () => {
  await stopLanServer();
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(mobile, { recursive: true, force: true });
});

describe('LAN HTTP server', () => {
  it('is opt-in, creates an ephemeral token, and gates cookie JSON APIs', async () => {
    assert.deepEqual(getLanStatus(), { running: false, port: null, urls: [], token: null });
    const status = await boot();
    assert.equal(status.running, true);
    assert.ok(status.token && status.token.length >= 32);
    assert.deepEqual(status.urls, [`http://127.0.0.1:${port}/`]);

    const unauthenticated = await request('/api/roots', { headers: apiHeaders() });
    assert.equal(unauthenticated.status, 401);
    const wrong = await request('/api/session', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong', [LAN_REQUEST_HEADER]: LAN_REQUEST_VALUE },
    });
    assert.equal(wrong.status, 401);
    await login();

    const roots = await request('/api/roots', { headers: apiHeaders() });
    assert.equal(roots.status, 200);
    assert.deepEqual(roots.json.roots, [{ id: 'r1', name: path.basename(root) }]);
    assert.equal(roots.text.includes(root), false, 'never exposes an absolute path');
    const missingHeader = await request('/api/roots', {
      headers: { Cookie: cookie },
    });
    assert.equal(missingHeader.status, 403);
    const head = await request('/api/roots', { method: 'HEAD', headers: apiHeaders() });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], roots.headers['content-length']);
    const wrongMethod = await request('/api/roots', { method: 'POST', headers: apiHeaders() });
    assert.equal(wrongMethod.status, 405);
  });

  it('lists bounded real entries, hides metadata, and merges filename/sidecar tags', async () => {
    await boot({ listLimit: 2 });
    await login();
    const listing = await request('/api/list?rootId=r1', { headers: apiHeaders() });
    assert.equal(listing.status, 200);
    assert.equal(listing.json.truncated, true);
    assert.equal(listing.json.entries.length, 2);
    assert.equal(listing.text.includes('.whale'), false);
    assert.equal(listing.text.includes(root), false);

    const nestedId = encodeEntryId('sub/nested');
    const nested = await request(`/api/list?rootId=r1&id=${nestedId}`, { headers: apiHeaders() });
    assert.equal(nested.status, 200);
    assert.equal(nested.json.parentId, encodeEntryId('sub'));
    assert.equal(nested.json.entries[0].path, 'sub/nested/leaf.txt');

    await stopLanServer();
    await boot();
    await login();
    const full = await request('/api/list?rootId=r1', { headers: apiHeaders() });
    const report = full.json.entries.find((entry: any) => entry.name === 'report[filename].txt');
    assert.ok(report.tags.includes('filename'));
    assert.ok(report.tags.includes('sidecar'));
    const traversal = await request(`/api/list?rootId=r1&id=${encodeEntryId('../outside')}`, {
      headers: apiHeaders(),
    });
    assert.equal(traversal.status, 400);
    const metadata = await request(`/api/file?rootId=r1&id=${encodeEntryId('.whale/secret.txt')}`, {
      headers: apiHeaders(),
    });
    assert.equal(metadata.status, 400);
  });

  it('keeps listing files and reports unavailable sidecar metadata', async () => {
    await boot();
    await login();
    await fsp.writeFile(path.join(root, '.whale', 'wsd.json'), '{broken', 'utf8');
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const listing = await request('/api/list?rootId=r1', { headers: apiHeaders() });
      assert.equal(listing.status, 200);
      assert.equal(listing.json.metadataUnavailable, true);
      const report = listing.json.entries.find((entry: any) => entry.name === 'report[filename].txt');
      assert.ok(report.tags.includes('filename'));
      assert.equal(report.tags.includes('sidecar'), false);
      assert.equal(warnings.length, 1);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('returns indexUnavailable and confines index results to existing root entries', async () => {
    await boot();
    await login();
    const missing = await request('/api/tags?rootId=r1', { headers: apiHeaders() });
    assert.equal(missing.status, 200);
    assert.deepEqual(missing.json, { tags: ['alpha', 'beta'], indexUnavailable: false });
    const search = await request('/api/search?rootId=r1&q=report&tag=alpha', { headers: apiHeaders() });
    assert.equal(search.status, 200);
    assert.deepEqual(search.json.entries.map((entry: any) => entry.path), ['report[filename].txt']);
    assert.ok(search.json.entries[0].tags.includes('filename'));
    assert.ok(search.json.entries[0].tags.includes('indexed'));
    assert.equal(search.json.indexUnavailable, false);
    assert.equal(queries[0].text, 'report');
    assert.deepEqual(queries[0].tags, ['alpha']);

    reader = {
      async search() { return { entries: [], indexUnavailable: true }; },
      async tags() { return { tags: [], indexUnavailable: true }; },
    };
    await stopLanServer();
    await boot();
    await login();
    const unavailable = await request('/api/search?rootId=r1&q=anything', { headers: apiHeaders() });
    assert.deepEqual(unavailable.json, { entries: [], indexUnavailable: true });
  });

  it('streams files with HEAD, exact ranges, forced downloads, and fetch-site checks', async () => {
    await boot();
    await login();
    const id = encodeEntryId('report[filename].txt');
    const file = await request(`/api/file?rootId=r1&id=${id}`, { headers: apiHeaders() });
    assert.equal(file.status, 200);
    assert.equal(file.text, '0123456789');
    assert.match(file.headers['content-disposition'] ?? '', /^inline;/);
    const head = await request(`/api/file?rootId=r1&id=${id}`, { method: 'HEAD', headers: apiHeaders() });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], '10');
    assert.equal(head.headers['content-type'], file.headers['content-type']);

    const range = await request(`/api/file?rootId=r1&id=${id}`, {
      headers: apiHeaders({ Range: 'bytes=2-5' }),
    });
    assert.equal(range.status, 206);
    assert.equal(range.text, '2345');
    assert.equal(range.headers['content-range'], 'bytes 2-5/10');
    const malformed = await request(`/api/file?rootId=r1&id=${id}`, {
      headers: apiHeaders({ Range: 'bytes=oops' }),
    });
    assert.equal(malformed.status, 400);
    for (const value of ['bytes=99-', 'bytes=0-1,3-4']) {
      const unsatisfiable = await request(`/api/file?rootId=r1&id=${id}`, {
        headers: apiHeaders({ Range: value }),
      });
      assert.equal(unsatisfiable.status, 416);
      assert.equal(unsatisfiable.headers['content-range'], 'bytes */10');
    }

    const pdf = await request(`/api/file?rootId=r1&id=${encodeEntryId('note.pdf')}`, {
      headers: apiHeaders(),
    });
    assert.match(pdf.headers['content-disposition'] ?? '', /^attachment;/);
    const crossSite = await request(`/api/file?rootId=r1&id=${id}`, {
      headers: apiHeaders({ 'Sec-Fetch-Site': 'cross-site' }),
    });
    assert.equal(crossSite.status, 403);
  });

  it('serves only the mobile bundle with a static CSP and no API SPA fallback', async () => {
    await boot();
    const index = await request('/');
    assert.equal(index.status, 200);
    assert.match(index.text, /main\.abc123\.js/);
    assert.match(String(index.headers['content-security-policy'] ?? ''), /script-src 'self'/);
    assert.doesNotMatch(String(index.headers['content-security-policy'] ?? ''), /script-src[^;]*unsafe-inline/);
    const script = await request('/main.abc123.js');
    assert.equal(script.status, 200);
    assert.equal(script.text, 'window.lanReady=true;');
    const asset = await request('/assets/logo.png');
    assert.equal(asset.status, 200);
    const head = await request('/', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], index.headers['content-length']);

    await login();
    const apiMissing = await request('/api/not-a-route', { headers: apiHeaders() });
    assert.equal(apiMissing.status, 404);
    assert.equal(apiMissing.json.error, 'Not found');
    for (const requestPath of ['/assets/../index.html', '/assets/%2e%2e/index.html', '/package.json']) {
      const response = await request(requestPath);
      assert.ok(response.status === 403 || response.status === 404, requestPath);
      assert.equal(response.text.includes('<html>'), false);
    }
    const post = await request('/', { method: 'POST' });
    assert.equal(post.status, 405);
  });

  it('rate limits bearer failures without logging or reflecting secrets', async () => {
    await boot();
    let last: TestResponse | null = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      last = await request('/api/session', {
        method: 'POST',
        headers: { Authorization: 'Bearer definitely-wrong', [LAN_REQUEST_HEADER]: LAN_REQUEST_VALUE },
      });
      assert.equal(last.text.includes('definitely-wrong'), false);
      assert.equal(last.text.includes(getLanStatus().token!), false);
    }
    assert.equal(last!.status, 429);
    assert.ok(Number(last!.headers['retry-after']) >= 1);
    const validWhileLimited = await request('/api/session', {
      method: 'POST',
      headers: { Authorization: `Bearer ${getLanStatus().token!}`, [LAN_REQUEST_HEADER]: LAN_REQUEST_VALUE },
    });
    assert.equal(validWhileLimited.status, 429);
  });

  it('invalidates token and sessions on stop and uses a fresh token on restart', async () => {
    const first = await boot();
    await login();
    const oldCookie = cookie;
    await stopLanServer();
    assert.deepEqual(getLanStatus(), { running: false, port: null, urls: [], token: null });
    const second = await boot();
    assert.notEqual(second.token, first.token);
    const oldSession = await request('/api/roots', {
      headers: { Cookie: oldCookie, [LAN_REQUEST_HEADER]: LAN_REQUEST_VALUE },
    });
    assert.equal(oldSession.status, 401);
  });

  it('cancels a pending start instead of publishing a listener after stop', async () => {
    const starting = startLanServer({
      roots: [root],
      host: '127.0.0.1',
      port: 0,
      mobileRoot: mobile,
      indexReader: reader,
      networkInterfaces: loopbackInterfaces,
      networkPollMs: 60_000,
    });
    const stopping = stopLanServer();
    const [started, stopped] = await Promise.all([starting, stopping]);
    assert.equal(started.running, false);
    assert.equal(started.port, null);
    assert.deepEqual(stopped, {
      running: false,
      port: null,
      urls: [],
      token: null,
    });
    const restarted = await boot();
    assert.equal(restarted.running, true);
    assert.ok(restarted.token);
  });

  it('lets a later stop cancel a start queued behind an earlier stop', async () => {
    await boot();
    const firstStop = stopLanServer();
    const queuedStart = startLanServer({
      roots: [root],
      host: '127.0.0.1',
      port: 0,
      mobileRoot: mobile,
      indexReader: reader,
      networkInterfaces: loopbackInterfaces,
      networkPollMs: 60_000,
    });
    const secondStop = stopLanServer();
    const results = await Promise.all([firstStop, secondStop, queuedStart]);
    for (const status of results) {
      assert.equal(status.running, false);
      assert.equal(status.port, null);
    }
    assert.deepEqual(getLanStatus(), {
      running: false,
      port: null,
      urls: [],
      token: null,
    });
    const restarted = await boot();
    assert.equal(restarted.running, true);
  });

  it('advertises only IPv4 pairing URLs when listening on IPv4', async () => {
    const interfaces = loopbackInterfaces();
    interfaces['Wi-Fi'] = [{
      address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4',
      mac: '00:00:00:00:00:01', internal: false, cidr: '192.168.1.20/24',
    }];
    interfaces['utun'] = [{
      address: 'fd00::20', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6',
      mac: '00:00:00:00:00:02', internal: false, cidr: 'fd00::20/64', scopeid: 0,
    }];
    const status = await boot({ host: '0.0.0.0', networkInterfaces: () => interfaces });
    assert.deepEqual(status.urls, [`http://192.168.1.20:${status.port}/`]);
  });

  it('stops automatically when the network fingerprint changes', async () => {
    let interfaces = loopbackInterfaces();
    await boot({
      networkInterfaces: () => interfaces,
      networkPollMs: 50,
    });
    interfaces = {
      ...loopbackInterfaces(),
      lan: [{
        address: '192.168.1.20',
        netmask: '255.255.255.0',
        family: 'IPv4',
        mac: '00:00:00:00:00:01',
        internal: false,
        cidr: '192.168.1.20/24',
      }],
    };
    const deadline = Date.now() + 2_000;
    while (getLanStatus().running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(getLanStatus().running, false);
    assert.equal(getLanStatus().token, null);
  });

  it('omits loopback from pairing URLs when a LAN interface exists', async () => {
    await boot({
      host: '0.0.0.0',
      networkInterfaces: () => ({
        ...loopbackInterfaces(),
        lan: [{
          address: '192.168.1.20',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:01',
          internal: false,
          cidr: '192.168.1.20/24',
        }],
      }),
    });
    assert.deepEqual(getLanStatus().urls, [`http://192.168.1.20:${port}/`]);
    const address = getLanStatus().port;
    assert.equal(typeof address, 'number');
    assert.ok(address! > 0 && address! < 65_536);
  });
});
