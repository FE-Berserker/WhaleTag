import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import Module from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
  shell: {},
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
