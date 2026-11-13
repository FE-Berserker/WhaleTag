/**
 * Preload bridge contract tests (docs/01 §12, docs/13 §1).
 *
 * `preload.ts` is the only surface the sandboxed renderer gets, so a typo in
 * a channel name or a dropped subscription helper is invisible until the
 * feature silently no-ops at runtime. These tests pin down:
 *   - the single `whale` bridge object and a representative subset of methods;
 *   - invoke/send channel names and argument order (a renamed channel fails
 *     as "no handler registered" only when the user clicks);
 *   - push-channel helpers forward the payload (not the Electron event) and
 *     unsubscribe the exact listener they registered.
 *
 * Mocking strategy mirrors `ipc.test.ts`: Electron 42's bundled `node:test`
 * predates `t.mock.module`, so we populate `require.cache` with an `electron`
 * stub before the dynamic `require('./preload')`. The stub records every
 * IPC touch; the module is dropped from the cache between tests so each test
 * sees a fresh `contextBridge.exposeInMainWorld` call.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require_ = createRequire(__filename);

interface IpcCall {
  channel: string;
  args: unknown[];
}

type AnyListener = (...args: unknown[]) => void;

let exposedName: string | null = null;
// The bridge is a plain object of thin IPC wrappers; `any` keeps the test
// able to call methods with their real argument shapes without re-declaring
// the whole `WhaleApi` interface here (that would let the interface and the
// preload object drift apart — the assertions below are the contract).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let exposedApi: Record<string, (...args: any[]) => any> | null = null;
let invokes: IpcCall[] = [];
let sends: IpcCall[] = [];
let onCalls: { channel: string; listener: AnyListener }[] = [];
let offCalls: { channel: string; listener: AnyListener }[] = [];
let pathForFileCalls: unknown[] = [];

const SAVED_CACHE = new Map<string, NodeJS.Module | undefined>();

function injectMock(moduleName: string, exports: unknown): void {
  const modulePath = require_.resolve(moduleName);
  if (!SAVED_CACHE.has(modulePath)) {
    SAVED_CACHE.set(modulePath, require_.cache[modulePath]);
  }
  const existing = require_.cache[modulePath];
  const stub: NodeJS.Module = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
    children: existing?.children ?? [],
    paths: existing?.paths ?? [],
  } as NodeJS.Module;
  require_.cache[modulePath] = stub;
}

function restoreMocks(): void {
  for (const [modulePath, original] of SAVED_CACHE.entries()) {
    if (original) {
      require_.cache[modulePath] = original;
    } else {
      delete require_.cache[modulePath];
    }
  }
  SAVED_CACHE.clear();
  const preloadPath = require_.resolve('./preload');
  delete require_.cache[preloadPath];
}

interface Bridge {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: Record<string, (...args: any[]) => any>;
}

function loadBridge(): Bridge {
  const electronStub = {
    contextBridge: {
      exposeInMainWorld: (name: string, api: Record<string, never>): void => {
        exposedName = name;
        exposedApi = api;
      },
    },
    ipcRenderer: {
      invoke: async (channel: string, ...args: unknown[]): Promise<unknown> => {
        invokes.push({ channel, args });
        return { channel, args };
      },
      send: (channel: string, ...args: unknown[]): void => {
        sends.push({ channel, args });
      },
      on: (channel: string, listener: AnyListener): void => {
        onCalls.push({ channel, listener });
      },
      off: (channel: string, listener: AnyListener): void => {
        offCalls.push({ channel, listener });
      },
    },
    webUtils: {
      getPathForFile: (file: unknown): string => {
        pathForFileCalls.push(file);
        return '/resolved/from/webUtils';
      },
    },
  };

  injectMock('electron', electronStub);
  require_('./preload');
  assert.ok(exposedApi, 'preload must call contextBridge.exposeInMainWorld');
  return { api: exposedApi! };
}

function lastOn(channel: string): AnyListener {
  const call = [...onCalls].reverse().find((c) => c.channel === channel);
  assert.ok(call, `no listener registered for ${channel}`);
  return call.listener;
}

beforeEach(() => {
  exposedName = null;
  exposedApi = null;
  invokes = [];
  sends = [];
  onCalls = [];
  offCalls = [];
  pathForFileCalls = [];
  restoreMocks();
});

afterEach(() => {
  restoreMocks();
});

describe('preload bridge — exposed shape', () => {
  it('exposes exactly one `whale` object with the public API surface', () => {
    const { api } = loadBridge();
    assert.equal(exposedName, 'whale');

    const expected = [
      'listDirectory',
      'readFile',
      'setAllowedRoots',
      'importExternal',
      'setUserCommandTemplates',
      'runCommand',
      'openNative',
      'zipEntries',
      'writeSidecar',
      'readSidecars',
      'generateThumbnail',
      'buildLocationIndex',
      'mcpGetStatus',
      'mcpResolveApproval',
      'persistRead',
      'persistWrite',
      'flushComplete',
      'onBeforeUnloadFlush',
      'onDirChanged',
      'onIndexProgress',
      'onMcpApprovalRequest',
      'reportRendererError',
      'getPathForFile',
      'startFileDrag',
      'onAppUpdateEvent',
    ];
    for (const name of expected) {
      assert.equal(typeof api[name], 'function', `whale.${name} must exist`);
    }
  });

  it('keeps every method a thin invoke/send wrapper (no Node objects leak)', () => {
    const { api } = loadBridge();
    // A renderer must never receive a function that resolves to the bridge
    // itself or to Electron internals; sample one and check the resolved
    // value is the stubbed IPC reply.
    return api.listDirectory('/dir').then((reply) => {
      assert.deepEqual(reply, {
        channel: 'fs:listDirectory',
        args: ['/dir'],
      });
    });
  });
});

describe('preload bridge — invoke channels', () => {
  it('maps directory, mutation and sidecar calls to their channels', async () => {
    const { api } = loadBridge();

    await api.listDirectory('/dir');
    await api.setAllowedRoots(['/root']);
    await api.importExternal(['/src/a.png'], '/dest');
    await api.zipEntries(['/a.txt'], '/out.zip');
    await api.writeSidecar('/a.txt', { tags: ['x'] });
    await api.persistWrite('wtag-persist', '{}');

    assert.deepEqual(
      invokes.map((c) => c.channel),
      [
        'fs:listDirectory',
        'fs:setAllowedRoots',
        'fs:importExternal',
        'fs:zipEntries',
        'sidecar:write',
        'persist:write',
      ]
    );
    assert.deepEqual(invokes[2].args, [['/src/a.png'], '/dest']);
    assert.deepEqual(invokes[4].args, ['/a.txt', { tags: ['x'] }]);
  });

  it('maps command, MCP and revision calls to their channels', async () => {
    const { api } = loadBridge();

    await api.setUserCommandTemplates(['echo ${path}']);
    await api.runCommand('echo ${path}', '/dir');
    await api.mcpGetStatus();
    await api.mcpResolveApproval('req-1', true);
    await api.listRevisions('/a.drawio');

    assert.deepEqual(
      invokes.map((c) => c.channel),
      [
        'shell:setCommandTemplates',
        'shell:runCommand',
        'mcp:getStatus',
        'mcp:resolveApproval',
        'ext:listRevisions',
      ]
    );
    assert.deepEqual(invokes[1].args, ['echo ${path}', '/dir']);
    assert.deepEqual(invokes[3].args, ['req-1', true]);
  });
});

describe('preload bridge — send channels', () => {
  it('uses send (not invoke) for fire-and-forget lifecycle calls', () => {
    const { api } = loadBridge();

    api.startFileDrag('/a.png');
    api.flushComplete();
    api.requestQuit();
    api.appQuitAndInstall();
    api.reportRendererError('boom');

    assert.deepEqual(
      sends.map((c) => c.channel),
      [
        'drag:startFile',
        'app:flush-complete',
        'app:request-quit',
        'app:update-quit-and-install',
        'app:report-renderer-error',
      ]
    );
    assert.equal(invokes.length, 0, 'send channels must not go through invoke');
  });
});

describe('preload bridge — push channels', () => {
  it('onDirChanged forwards the payload and unsubscribes its own listener', () => {
    const { api } = loadBridge();
    const seen: unknown[] = [];
    const off = api.onDirChanged((ev: unknown) => seen.push(ev)) as () => void;

    const listener = lastOn('fs:dirChanged');
    listener({ sender: 'electron-event' }, { rootPath: '/r', paths: ['a'] });
    assert.deepEqual(seen, [{ rootPath: '/r', paths: ['a'] }]);

    off();
    assert.equal(offCalls.length, 1);
    assert.equal(offCalls[0].channel, 'fs:dirChanged');
    assert.equal(offCalls[0].listener, listener);
  });

  it('onBeforeUnloadFlush ignores the event argument', () => {
    const { api } = loadBridge();
    let calls = 0;
    api.onBeforeUnloadFlush(() => {
      calls += 1;
    });

    lastOn('app:request-flush')({ sender: 'electron-event' });
    assert.equal(calls, 1);
  });

  it('onAppUpdateEvent derives the wire channel from the state name', () => {
    const { api } = loadBridge();
    const seen: unknown[] = [];
    const off = api.onAppUpdateEvent('progress', (data: unknown) =>
      seen.push(data)
    ) as () => void;

    const listener = lastOn('app:update-progress');
    listener({}, { percent: 42 });
    assert.deepEqual(seen, [{ percent: 42 }]);

    off();
    assert.equal(offCalls[0].channel, 'app:update-progress');
    assert.equal(offCalls[0].listener, listener);
  });
});

describe('preload bridge — dropped files', () => {
  it('getPathForFile delegates to webUtils (File.path is gone in Electron ≥32)', () => {
    const { api } = loadBridge();
    const file = { name: 'a.png' };
    assert.equal(api.getPathForFile(file), '/resolved/from/webUtils');
    assert.deepEqual(pathForFileCalls, [file]);
  });
});
