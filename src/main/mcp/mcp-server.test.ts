import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import Module from 'node:module';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Lifecycle tests for the Electron-facing MCP shell: bring the listener up and
 * down through `applyMcpConfigChange`, check that status honestly reflects it,
 * and prove a disable cannot hang on a client's keep-alive socket.
 *
 * `electron` is stubbed before import (same pattern as mcp-http.test.ts); no
 * BrowserWindow exists, so only the listener half of the module is exercised.
 */

const TMP_USER_DATA = path.join(
  os.tmpdir(),
  `whaletag-mcp-server-${process.pid}-${Date.now()}`
);
fs.mkdirSync(TMP_USER_DATA, { recursive: true });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const electronStub: any = {
  app: {
    getPath: () => TMP_USER_DATA,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    setName: () => undefined,
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

const TOKEN = 'server-test-token-0123456789';

type ServerModule = typeof import('./mcp-server');
let mod: ServerModule;
let port = 0;

/** Reserve a port, then release it so the MCP listener can bind it. */
async function reservePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const p = (probe.address() as { port: number }).port;
      probe.close(() => resolve(p));
    });
  });
}

before(async () => {
  port = await reservePort();
  fs.writeFileSync(
    path.join(TMP_USER_DATA, 'mcp-config.json'),
    JSON.stringify({
      enabled: false,
      port,
      token: TOKEN,
      readOnly: true,
    })
  );
  mod = await import('./mcp-server');
});

after(async () => {
  await mod.stopMcpServer();
});

describe('mcp-server lifecycle', () => {
  it('starts stopped and reports no endpoint', () => {
    const status = mod.getMcpStatus();
    assert.equal(status.running, false);
    assert.equal(status.port, null);
    assert.equal(status.endpoint, null);
    assert.equal(status.token, TOKEN);
    assert.equal(status.readOnly, true);
  });

  it('enabling binds the configured port and the endpoint answers 401', async () => {
    const status = await mod.applyMcpConfigChange('enabled', true);
    assert.equal(status.running, true);
    assert.equal(status.port, port);
    assert.equal(status.endpoint, `http://127.0.0.1:${port}/mcp`);

    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 401);
  });

  it('toggling read-only is reflected without restarting the listener', async () => {
    const status = await mod.applyMcpConfigChange('readOnly', false);
    assert.equal(status.readOnly, false);
    assert.equal(status.running, true);
    assert.equal(status.port, port);
    const back = await mod.applyMcpConfigChange('readOnly', true);
    assert.equal(back.readOnly, true);
  });

  it('disabling releases the port even with a keep-alive client connected', async () => {
    // Open a pooling connection that would otherwise hold server.close() open.
    const agent = new http.Agent({ keepAlive: true });
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          agent,
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
            'content-length': 2,
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve());
        }
      );
      req.on('error', reject);
      req.end('{}');
    });

    const status = await Promise.race([
      mod.applyMcpConfigChange('enabled', false),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('disable hung on keep-alive')), 3_000)
      ),
    ]);
    agent.destroy();
    assert.equal(status.running, false);
    assert.equal(status.port, null);
    assert.equal(status.endpoint, null);
  });

  it('serializes concurrent toggles to the last requested state', async () => {
    const [, , last] = await Promise.all([
      mod.applyMcpConfigChange('enabled', true),
      mod.applyMcpConfigChange('enabled', false),
      mod.applyMcpConfigChange('enabled', true),
    ]);
    assert.equal(last.running, true);
    assert.equal(mod.getMcpStatus().running, true);
    await mod.applyMcpConfigChange('enabled', false);
    assert.equal(mod.getMcpStatus().running, false);
  });

  it('never throws to the caller when the listener cannot bind', async () => {
    // Occupy the configured port so both the configured bind and the
    // ephemeral fallback are impossible only for the configured one — the
    // core must still come up on a random port, or report a clean status.
    const blocker = http.createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(port, '127.0.0.1', () => resolve())
    );
    try {
      const status = await mod.applyMcpConfigChange('enabled', true);
      // Fallback port: still running, but not on the configured one.
      assert.equal(status.running, true);
      assert.notEqual(status.port, port);
    } finally {
      blocker.close();
      await mod.applyMcpConfigChange('enabled', false);
    }
  });
});
