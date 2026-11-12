import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import Module from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { setAllowedRoots } from '../allowed-roots';
import { createMcpHttpCore, type McpHttpCore } from './mcp-http';

/**
 * End-to-end protocol test for the MCP HTTP core: boots the real handler on
 * an ephemeral port and drives it with the OFFICIAL client SDK — covering the
 * initialize handshake, session management, tool listing and a read-only
 * tool call, plus the bearer-token gate.
 *
 * mcp-tools (registered here) transitively imports Electron modules
 * (ipcMain/shell/utilityProcess via fs-write/fs-read/index-worker-host) that
 * only destructure at import time; under `ELECTRON_RUN_AS_NODE` the electron
 * require resolves to the binary path, so we stub it BEFORE the dynamic
 * import below. No stubbed API is actually invoked by this test's paths.
 */

const TMP_USER_DATA = path.join(os.tmpdir(), 'whaletag-mcp-test');
fs.mkdirSync(TMP_USER_DATA, { recursive: true });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const electronStub: any = {
  app: {
    getPath: () => TMP_USER_DATA,
    setName: () => undefined,
    isPackaged: true,
  },
  ipcMain: { handle: () => undefined, on: () => undefined },
  shell: {
    // `whale_delete_files` trashes through Electron's shell API; the harness
    // simulates it with rm so the tool's own bookkeeping is what gets tested.
    trashItem: async (target: string) => {
      await fs.promises.rm(target, { recursive: true, force: true });
    },
  },
  utilityProcess: {
    fork: () => {
      throw new Error('utilityProcess is not available in tests');
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: unknown[]) {
  if (request === 'electron') return electronStub;
  return originalLoad.apply(Module, [request, ...rest]);
};

const TOKEN = 'test-token-0123456789abcdef';
let server: http.Server;
let core: McpHttpCore;
let port = 0;

before(async () => {
  const { registerMcpTools } = await import('./mcp-tools');
  core = createMcpHttpCore({
    token: () => TOKEN,
    registerTools: registerMcpTools,
    serverInfo: { name: 'whaletag-test', version: '0.0.0' },
  });
  server = http.createServer((req, res) => core.handler(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

after(async () => {
  await core.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function connectClient(): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }
  );
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(transport);
  return { client, transport };
}

describe('mcp http core (official client SDK)', () => {
  it('rejects requests without a valid bearer token (401)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'x', version: '0' },
        },
      }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects requests whose Host is not the loopback listener (403, pre-auth)', async () => {
    // DNS-rebinding shape: a browser page talking same-origin to a rebound
    // domain presents a non-loopback Host header. Must be refused before the
    // token check, even with valid credentials attached.
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            Host: 'attacker.example:80',
            Authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
          },
        },
        resolve
      );
      req.on('error', reject);
      req.end();
    });
    let body = '';
    for await (const chunk of res) body += String(chunk);
    assert.equal(res.statusCode, 403);
    assert.equal(body, 'Forbidden');
  });

  it('completes the initialize handshake and lists the WhaleTag tools', async () => {
    const { client, transport } = await connectClient();
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    assert.ok(names.includes('whale_roots'), 'whale_roots missing');
    assert.ok(names.includes('whale_search'), 'whale_search missing');
    assert.ok(names.includes('whale_apply_tags'), 'whale_apply_tags missing');
    assert.ok(names.includes('whale_zip_files'), 'whale_zip_files missing');
    assert.equal(core.sessionCount(), 1);
    // terminateSession() is the client-side DELETE; plain close() only drops
    // the streams — the server session would linger until server shutdown.
    await transport.terminateSession();
    await client.close();
    assert.equal(core.sessionCount(), 0);
  });

  it('calls a read-only tool end-to-end (whale_roots)', async () => {
    const { client } = await connectClient();
    const res = await client.callTool({ name: 'whale_roots', arguments: {} });
    // isError is only present on failure results.
    assert.notEqual(res.isError, true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = ((res.content as any[]) ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');
    const parsed = JSON.parse(text) as { roots: unknown[]; readOnly: boolean };
    // No locations configured in the test env — but the call must succeed
    // with a well-formed payload, not a protocol error.
    assert.deepEqual(parsed.roots, []);
    assert.equal(typeof parsed.readOnly, 'boolean');
    await client.close();
  });

  it('refuses mutating tools while a session is unapproved (deny path)', async () => {
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'whale_create_folder',
      arguments: { path: path.join(TMP_USER_DATA, 'should-not-exist') },
    });
    // No live window → the approval gate fail-closes → the tool reports an
    // error result instead of creating anything.
    assert.equal(res.isError, true);
    assert.equal(fs.existsSync(path.join(TMP_USER_DATA, 'should-not-exist')), false);
    await client.close();
  });
});

describe('mcp http core — hardening', () => {
  it('only answers /mcp, not arbitrary prefixes', async () => {
    for (const p of ['/mcpfoo', '/mcpx', '/']) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      assert.equal(res.status, 404, `${p} should not be the MCP endpoint`);
    }
  });

  it('rejects an unknown mcp-session-id with 404 (client must re-initialize)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'mcp-session-id': 'does-not-exist',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
    });
    assert.equal(res.status, 404);
  });

  it('treats DELETE for an unknown session as idempotent', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'mcp-session-id': 'already-gone',
      },
    });
    assert.equal(res.status, 204);
  });

  it('answers an oversized body with 413 instead of dropping the socket', async () => {
    // 4 MiB + 1 byte of padding — over the core's limit, well under what the
    // process can allocate for one test.
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
      pad: 'x'.repeat(4 * 1024 * 1024 + 1),
    });
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        resolve
      );
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(res.statusCode, 413);
    for await (const _chunk of res) {
      /* drain */
    }
  });

  it('reaps a session that has been idle past the configured TTL', async () => {
    const idleCore = createMcpHttpCore({
      token: () => TOKEN,
      registerTools: () => undefined,
      serverInfo: { name: 'whaletag-idle', version: '0.0.0' },
      sessionIdleMs: 20,
    });
    const idleServer = http.createServer((req, res) => idleCore.handler(req, res));
    const idlePort = await new Promise<number>((resolve) => {
      idleServer.listen(0, '127.0.0.1', () =>
        resolve((idleServer.address() as { port: number }).port)
      );
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${idlePort}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }
    );
    const client = new Client({ name: 'idle-client', version: '0.0.1' });
    await client.connect(transport);
    assert.equal(idleCore.sessionCount(), 1);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(idleCore.reapIdleSessions(), 1);
    assert.equal(idleCore.sessionCount(), 0);
    // A second sweep is a no-op, not a double-close.
    assert.equal(idleCore.reapIdleSessions(), 0);
    await client.close().catch(() => undefined);
    await idleCore.close();
    await new Promise<void>((resolve) => idleServer.close(() => resolve()));
  });

  it('does not reap fresh sessions when the idle TTL is disabled', async () => {
    const coreNoIdle = createMcpHttpCore({
      token: () => TOKEN,
      registerTools: () => undefined,
      serverInfo: { name: 'whaletag-noidle', version: '0.0.0' },
      sessionIdleMs: 0,
      sessionSweepMs: 10,
    });
    const srv = http.createServer((req, res) => coreNoIdle.handler(req, res));
    const p = await new Promise<number>((resolve) => {
      srv.listen(0, '127.0.0.1', () =>
        resolve((srv.address() as { port: number }).port)
      );
    });
    const t = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${p}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }
    );
    const c = new Client({ name: 'keep-client', version: '0.0.1' });
    await c.connect(t);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(coreNoIdle.reapIdleSessions(), 0);
    assert.equal(coreNoIdle.sessionCount(), 1);
    await c.close().catch(() => undefined);
    await coreNoIdle.close();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });
});

/**
 * The guards that stand between an MCP client and real data: read-only mode,
 * the "a location root is a container, not an entry" rule, and the read cap.
 * These run against a real configured root — unlike the deny-path test above,
 * which never registers one (and therefore exercises assertWithinAllowedRoot
 * rather than the specific guard under test).
 */
describe('mcp tool guards (location roots, read-only, read caps)', () => {
  let ROOT = '';
  let FILE = '';
  let DIR = '';
  let config: typeof import('./mcp-config');

  function textOf(res: unknown): string {
    const content = (res as { content?: unknown }).content;
    return ((content as { type: string; text?: string }[]) ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
  }

  before(async () => {
    ROOT = await fs.promises.realpath(
      await fs.promises.mkdtemp(path.join(os.tmpdir(), 'whale-mcp-guards-'))
    );
    FILE = path.join(ROOT, 'note.txt');
    DIR = path.join(ROOT, 'sub');
    await fs.promises.writeFile(FILE, 'hello', 'utf8');
    await fs.promises.mkdir(DIR);
    setAllowedRoots([ROOT]);
    config = await import('./mcp-config');
  });

  after(async () => {
    setAllowedRoots([]);
    await config.setMcpReadOnly(true);
    await fs.promises.rm(ROOT, { recursive: true, force: true });
  });

  it('refuses whale_apply_tags in read-only mode', async () => {
    await config.setMcpReadOnly(true);
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'whale_apply_tags',
      arguments: { paths: [FILE], add: ['mcp-guard-test'] },
    });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /read-only/);
    await client.close();
  });

  it('refuses whale_build_fulltext in read-only mode', async () => {
    await config.setMcpReadOnly(true);
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'whale_build_fulltext',
      arguments: { rootPath: ROOT },
    });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /read-only/);
    await client.close();
  });

  it('refuses to tag the configured location root itself', async () => {
    await config.setMcpReadOnly(false);
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'whale_apply_tags',
      arguments: { paths: [ROOT], add: ['should-not-land'] },
    });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /configured location root/);
    // Nothing may be written above the boundary (a root's sidecar would land
    // in the root's PARENT directory).
    const parentSidecar = path.join(path.dirname(ROOT), '.whale');
    assert.equal(fs.existsSync(parentSidecar), false);
    await client.close();
  });

  it('tags a normal file inside the root without approval (sidecar-level write)', async () => {
    await config.setMcpReadOnly(false);
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'whale_apply_tags',
      arguments: { paths: [FILE], add: ['mcp-guard-test'] },
    });
    assert.notEqual(res.isError, true);
    const parsed = JSON.parse(textOf(res)) as { updated: number; errors: unknown[] };
    assert.equal(parsed.updated, 1);
    assert.deepEqual(parsed.errors, []);
    await client.close();
  });

  it('refuses to read a directory as text', async () => {
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'whale_read_text',
      arguments: { path: DIR },
    });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /Not a file/);
    await client.close();
  });
});

/**
 * The rest of the tool surface: read tools that never touch the index worker,
 * sidecar-only writes, and the APPROVAL-ALLOW path for every file operation.
 * Before this suite the only approval test was the deny path, so an approval
 * gate that silently allowed everything would have passed.
 */
describe('mcp tool surface (approval allow path)', () => {
  let ROOT = '';
  let config: typeof import('./mcp-config');
  let approval: typeof import('./mcp-approval');

  function textOf(res: unknown): string {
    const content = (res as { content?: unknown }).content;
    return ((content as { type: string; text?: string }[]) ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
  }

  function jsonOf<T>(res: unknown): T {
    return JSON.parse(textOf(res)) as T;
  }

  before(async () => {
    ROOT = await fs.promises.realpath(
      await fs.promises.mkdtemp(path.join(os.tmpdir(), 'whale-mcp-tools-'))
    );
    setAllowedRoots([ROOT]);
    config = await import('./mcp-config');
    await config.setMcpReadOnly(false);
    approval = await import('./mcp-approval');
    // Auto-approve the visible request on the next microtask, the way the
    // dialog answers it. The approve() path then runs for real.
    approval.bindApprovalTransport({
      broadcast: (req) => {
        queueMicrotask(() => approval.resolveApproval(req.reqId, true));
      },
      hasWindows: () => true,
    });
  });

  after(async () => {
    approval.bindApprovalTransport({
      broadcast: () => undefined,
      hasWindows: () => false,
    });
    approval.denyAllPending();
    await config.setMcpReadOnly(true);
    setAllowedRoots([]);
    await fs.promises.rm(ROOT, { recursive: true, force: true });
  });

  it('lists one directory level', async () => {
    const dir = await fs.promises.mkdtemp(path.join(ROOT, 'list-'));
    await fs.promises.writeFile(path.join(dir, 'a.txt'), 'A', 'utf8');
    await fs.promises.mkdir(path.join(dir, 'inner'));
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'whale_list_directory',
      arguments: { path: dir },
    });
    assert.notEqual(res.isError, true);
    const parsed = jsonOf<{
      count: number;
      entries: { name: string; isDirectory: boolean }[];
    }>(res);
    assert.equal(parsed.count, 2);
    assert.deepEqual(
      parsed.entries.map((e) => [e.name, e.isDirectory]).sort(),
      [
        ['a.txt', false],
        ['inner', true],
      ]
    );
    await client.close();
  });

  it('reads sidecar metadata back after tagging', async () => {
    const dir = await fs.promises.mkdtemp(path.join(ROOT, 'meta-'));
    const file = path.join(dir, 'note.txt');
    await fs.promises.writeFile(file, 'meta', 'utf8');
    const { client } = await connectClient();
    await client.callTool({
      name: 'whale_apply_tags',
      arguments: { paths: [file], add: ['surface-test'] },
    });
    const res = await client.callTool({
      name: 'whale_get_meta',
      arguments: { paths: [file] },
    });
    assert.notEqual(res.isError, true);
    const parsed = jsonOf<{
      metas: Record<string, { tags: string[] }>;
    }>(res);
    const meta = parsed.metas[file];
    assert.ok(meta, 'the tagged file has metadata');
    assert.deepEqual(meta.tags, ['surface-test']);
    await client.close();
  });

  it('writes a description and keeps existing tags', async () => {
    const dir = await fs.promises.mkdtemp(path.join(ROOT, 'desc-'));
    const file = path.join(dir, 'note.txt');
    await fs.promises.writeFile(file, 'desc', 'utf8');
    const { client } = await connectClient();
    await client.callTool({
      name: 'whale_apply_tags',
      arguments: { paths: [file], add: ['keep-me'] },
    });
    const res = await client.callTool({
      name: 'whale_write_description',
      arguments: { path: file, description: 'summary from the assistant' },
    });
    assert.notEqual(res.isError, true);
    const meta = await client.callTool({
      name: 'whale_get_meta',
      arguments: { paths: [file] },
    });
    const parsed = jsonOf<{
      metas: Record<string, { description?: string; tags: string[] }>;
    }>(meta);
    const entry = parsed.metas[file];
    assert.ok(entry, 'the described file has metadata');
    assert.equal(entry.description, 'summary from the assistant');
    assert.deepEqual(entry.tags, ['keep-me']);
    await client.close();
  });

  it('extracts text from a supported document', async () => {
    const dir = await fs.promises.mkdtemp(path.join(ROOT, 'extract-'));
    const file = path.join(dir, 'readme.md');
    await fs.promises.writeFile(file, '# Title\n\nBody text.', 'utf8');
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'whale_extract_text',
      arguments: { path: file },
    });
    assert.notEqual(res.isError, true);
    const parsed = jsonOf<{ text: string }>(res);
    assert.match(parsed.text, /Body text/);
    await fs.promises.rm(dir, { recursive: true, force: true });
    await client.close();
  });

  it('creates a folder after approval', async () => {
    const target = path.join(ROOT, 'created-folder');
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'whale_create_folder',
      arguments: { path: target },
    });
    assert.notEqual(res.isError, true);
    assert.equal(fs.statSync(target).isDirectory(), true);
    await client.close();
  });

  it('creates a text file after approval and refuses to overwrite it', async () => {
    const target = path.join(ROOT, 'report.md');
    const content = '# Report\n\n中文内容。';
    const { client } = await connectClient();
    const created = await client.callTool({
      name: 'whale_create_text_file',
      arguments: { path: target, content },
    });
    assert.notEqual(created.isError, true);
    assert.equal(await fs.promises.readFile(target, 'utf8'), content);
    assert.equal(
      jsonOf<{ bytes: number }>(created).bytes,
      Buffer.byteLength(content, 'utf8')
    );
    const again = await client.callTool({
      name: 'whale_create_text_file',
      arguments: { path: target, content: 'clobber' },
    });
    assert.equal(again.isError, true);
    assert.equal(await fs.promises.readFile(target, 'utf8'), content);
    await client.close();
  });

  it('copies files after approval', async () => {
    const dir = await fs.promises.mkdtemp(path.join(ROOT, 'copy-src-'));
    const source = path.join(dir, 'data.txt');
    await fs.promises.writeFile(source, 'COPY ME', 'utf8');
    const dest = await fs.promises.mkdtemp(path.join(ROOT, 'copy-dst-'));
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'whale_copy_files',
      arguments: { paths: [source], destDir: dest },
    });
    assert.notEqual(res.isError, true);
    assert.equal(jsonOf<{ copied: number }>(res).copied, 1);
    assert.equal(
      await fs.promises.readFile(path.join(dest, 'data.txt'), 'utf8'),
      'COPY ME'
    );
    assert.equal(fs.existsSync(source), true, 'copy keeps the source');
    await fs.promises.rm(dir, { recursive: true, force: true });
    await client.close();
  });

  it('moves files after approval', async () => {
    const dir = await fs.promises.mkdtemp(path.join(ROOT, 'move-src-'));
    const source = path.join(dir, 'data.txt');
    await fs.promises.writeFile(source, 'MOVE ME', 'utf8');
    const dest = await fs.promises.mkdtemp(path.join(ROOT, 'move-dst-'));
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'whale_move_files',
      arguments: { paths: [source], destDir: dest },
    });
    assert.notEqual(res.isError, true);
    assert.equal(jsonOf<{ moved: number }>(res).moved, 1);
    assert.equal(fs.existsSync(source), false);
    assert.equal(
      await fs.promises.readFile(path.join(dest, 'data.txt'), 'utf8'),
      'MOVE ME'
    );
    await client.close();
  });

  it('deletes files after approval (trash)', async () => {
    const dir = await fs.promises.mkdtemp(path.join(ROOT, 'delete-'));
    const target = path.join(dir, 'trash-me.txt');
    await fs.promises.writeFile(target, 'bye', 'utf8');
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'whale_delete_files',
      arguments: { paths: [target] },
    });
    assert.notEqual(res.isError, true);
    assert.equal(jsonOf<{ deleted: number }>(res).deleted, 1);
    assert.equal(fs.existsSync(target), false);
    await client.close();
  });

  it('zips files after approval', async () => {
    const dir = await fs.promises.mkdtemp(path.join(ROOT, 'zip-'));
    await fs.promises.writeFile(path.join(dir, 'one.txt'), 'ONE', 'utf8');
    const archive = path.join(ROOT, 'bundle.zip');
    const { client } = await connectClient();
    const res = await client.callTool({
      name: 'whale_zip_files',
      arguments: { paths: [dir], zipPath: archive },
    });
    assert.notEqual(res.isError, true);
    assert.equal(fs.existsSync(archive), true);
    assert.ok(fs.statSync(archive).size > 0, 'the archive has content');
    await client.close();
  });
});
