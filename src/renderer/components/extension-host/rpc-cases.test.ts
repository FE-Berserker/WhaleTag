import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import type { ExtensionMessage, HostMessage } from '../../../shared/extension-types';
import { createRpcHandler } from './rpc-cases';
import * as ipcApiModule from '-/services/ipc-api';

/**
 * rpc-cases tests (docs/07 §10): the `request* → reply` plumbing — reply
 * shapes, error fallbacks, settings-path forwarding, and the non-RPC
 * fall-through. `ipcApi` is stubbed via its CommonJS module binding (same
 * trick as the useNow subscribeNow spy).
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

const PATHS = {
  dwg2dxfPath: 'C:/dwg2dxf.exe',
  odaPath: null,
  calibrePath: null,
  sofficePath: 'C:/LO/soffice.exe',
};

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
  it('requestPdfAsset: success replies with data', async () => {
    stubIpc('getPdfAsset', () => Promise.resolve(new ArrayBuffer(3)));
    const handle = createRpcHandler(post, PATHS);
    assert.equal(handle(rpc('requestPdfAsset', { kind: 'cMapUrl', filename: 'a.bcmap' })), true);
    await new Promise((r) => setImmediate(r));
    assert.equal(posted.length, 1);
    const reply = posted[0] as { type: string; requestId: string; data: unknown };
    assert.equal(reply.type, 'pdfAsset');
    assert.equal(reply.requestId, 'r1');
    assert.ok(reply.data instanceof ArrayBuffer || ArrayBuffer.isView(reply.data));
  });

  it('requestPdfAsset: failure replies with data:null + error message', async () => {
    stubIpc('getPdfAsset', () => Promise.reject(new Error('ENOENT boom')));
    const handle = createRpcHandler(post, PATHS);
    handle(rpc('requestPdfAsset', { kind: 'cMapUrl', filename: 'x' }));
    await new Promise((r) => setImmediate(r));
    const reply = posted[0] as { data: unknown; error?: string };
    assert.equal(reply.data, null);
    assert.equal(reply.error, 'ENOENT boom');
  });

  it('requestOfficeConvert forwards the settings sofficePath override', async () => {
    stubIpc('convertOfficeToPdf', () => Promise.resolve(new Uint8Array(2)));
    const handle = createRpcHandler(post, PATHS);
    handle(rpc('requestOfficeConvert', { path: 'D:/a.docx' }));
    await new Promise((r) => setImmediate(r));
    const call = calls.find((c) => c.fn === 'convertOfficeToPdf');
    assert.deepEqual(call?.args, ['D:/a.docx', { sofficePath: 'C:/LO/soffice.exe' }]);
  });

  it('requestSofficeCheck: failure collapses to available:false (no error field)', async () => {
    stubIpc('isSofficeAvailable', () => Promise.reject(new Error('probe died')));
    const handle = createRpcHandler(post, PATHS);
    handle(rpc('requestSofficeCheck'));
    await new Promise((r) => setImmediate(r));
    const reply = posted[0] as { type: string; available: boolean; error?: string };
    assert.equal(reply.type, 'sofficeCheckResult');
    assert.equal(reply.available, false);
    assert.equal(reply.error, undefined);
  });

  it('requestThumbnail: null thumbnail coalesces to dataUrl:null', async () => {
    stubIpc('loadThumbnail', () => Promise.resolve(null));
    const handle = createRpcHandler(post, PATHS);
    handle(rpc('requestThumbnail', { path: 'D:/b.docx' }));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(posted[0], {
      type: 'thumbnailContent',
      requestId: 'r1',
      dataUrl: null,
    });
  });

  it('requestWriteEbookAnnotations: success replies ok:true with null payload', async () => {
    stubIpc('writeEbookAnnotations', () => Promise.resolve());
    const handle = createRpcHandler(post, PATHS);
    handle(rpc('requestWriteEbookAnnotations', { path: 'D:/b.epub', payload: { x: 1 } }));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(posted[0], {
      type: 'ebookAnnotations',
      requestId: 'r1',
      ok: true,
      payload: null,
    });
  });

  it('non-RPC messages fall through (false, no ipc call, no post)', () => {
    const handle = createRpcHandler(post, PATHS);
    assert.equal(handle(rpc('ready')), false);
    assert.equal(calls.length, 0);
    assert.equal(posted.length, 0);
  });
});
