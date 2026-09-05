import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import type { ExtensionMessage, HostMessage } from '../../../shared/extension-types';
import { createRpcHandler } from './rpc-cases';
import * as ipcApiModule from '-/services/ipc-api';

/**
 * rpc-cases tests (docs/07 §9): the `request* → reply` plumbing — reply
 * shapes, error fallbacks, and the non-RPC fall-through. `ipcApi` is stubbed
 * via its CommonJS module binding (same trick as the useNow subscribeNow spy).
 */

type IpcFn = (...args: never[]) => Promise<unknown>;

const posted: HostMessage[] = [];
const calls: Array<{ fn: string; args: unknown[] }> = [];
let fakeIpc: Record<string, IpcFn> = {};
let origIpcApi: unknown;

function stubIpc(fn: string, impl: IpcFn): void {
  fakeIpc[fn] = impl;
}

function post(msg: HostMessage): void {
  posted.push(msg);
}

function rpc(type: string, extra: Record<string, unknown> = {}): ExtensionMessage {
  return { type, requestId: 'r1', ...extra } as unknown as ExtensionMessage;
}

beforeEach(() => {
  posted.length = 0;
  calls.length = 0;
  fakeIpc = {};
  origIpcApi = (ipcApiModule as { ipcApi: unknown }).ipcApi;
  const recorder = new Proxy(
    {},
    {
      get:
        (_t, fn: string) =>
        (...args: unknown[]) => {
          calls.push({ fn, args });
          const impl = fakeIpc[fn];
          return impl
            ? impl(...(args as never[]))
            : Promise.reject(new Error(`no stub for ${fn}`));
        },
    }
  );
  (ipcApiModule as { ipcApi: unknown }).ipcApi = recorder;
});

afterEach(() => {
  (ipcApiModule as { ipcApi: unknown }).ipcApi = origIpcApi;
});

describe('createRpcHandler', () => {
  it('requestHeicWasm: success replies with data', async () => {
    stubIpc('getHeicWasm', () => Promise.resolve(new ArrayBuffer(3)));
    const handle = createRpcHandler(post);
    assert.equal(handle(rpc('requestHeicWasm')), true);
    await new Promise((r) => setImmediate(r));
    assert.equal(posted.length, 1);
    const reply = posted[0] as { type: string; requestId: string; data: unknown };
    assert.equal(reply.type, 'heicWasm');
    assert.equal(reply.requestId, 'r1');
    assert.ok(reply.data instanceof ArrayBuffer || ArrayBuffer.isView(reply.data));
  });

  it('requestHeicWasm: failure replies with data:null + error message', async () => {
    stubIpc('getHeicWasm', () => Promise.reject(new Error('ENOENT boom')));
    const handle = createRpcHandler(post);
    handle(rpc('requestHeicWasm'));
    await new Promise((r) => setImmediate(r));
    const reply = posted[0] as { data: unknown; error?: string };
    assert.equal(reply.data, null);
    assert.equal(reply.error, 'ENOENT boom');
  });

  it('non-RPC messages fall through (false, no ipc call, no post)', () => {
    const handle = createRpcHandler(post);
    assert.equal(handle(rpc('ready')), false);
    assert.equal(calls.length, 0);
    assert.equal(posted.length, 0);
  });
});
