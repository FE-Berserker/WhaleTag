import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { McpAddLocationRequest } from '../../shared/mcp-types';
import {
  bindLocationRequestTransport,
  completeLocationRequest,
  rejectAllLocationRequests,
  requestLocationAddition,
} from './mcp-location-requests';

const input = { path: 'D:\\Reference', name: 'Reference', readOnly: false };
let delivered: McpAddLocationRequest[];

beforeEach(() => {
  delivered = [];
  bindLocationRequestTransport({
    deliver: (req) => delivered.push(req),
    hasWindows: () => true,
  });
});

afterEach(() => {
  rejectAllLocationRequests('test cleanup');
});

describe('MCP location request coordinator', () => {
  it('delivers the canonical location input and resolves on acknowledgement', async () => {
    const request = requestLocationAddition(input);
    assert.equal(delivered.length, 1);
    assert.deepEqual(
      { ...delivered[0], reqId: '<generated>' },
      { ...input, reqId: '<generated>' }
    );
    assert.ok(delivered[0].reqId.length > 0);

    assert.equal(completeLocationRequest(delivered[0].reqId), true);
    await request;
    assert.equal(
      completeLocationRequest(delivered[0].reqId),
      false,
      'a late duplicate acknowledgement must not settle another request'
    );
  });

  it('surfaces renderer failures instead of reporting a false success', async () => {
    const request = requestLocationAddition(input);
    completeLocationRequest(delivered[0].reqId, 'persist flush failed');
    await assert.rejects(request, /persist flush failed/);
  });

  it('fails closed without a live window or when delivery throws', async () => {
    bindLocationRequestTransport({
      deliver: () => assert.fail('must not deliver without a window'),
      hasWindows: () => false,
    });
    await assert.rejects(requestLocationAddition(input), /no live WhaleTag window/);

    bindLocationRequestTransport({
      deliver: () => {
        throw new Error('webContents was destroyed');
      },
      hasWindows: () => true,
    });
    await assert.rejects(requestLocationAddition(input), /webContents was destroyed/);
  });

  it('times out honestly and ignores the late acknowledgement', async () => {
    const request = requestLocationAddition(input, 5);
    await assert.rejects(request, /check whale_roots before retrying/);
    assert.equal(completeLocationRequest(delivered[0].reqId), false);
  });

  it('releases every waiter on server shutdown', async () => {
    const first = requestLocationAddition(input);
    const second = requestLocationAddition({ ...input, name: 'Second' });
    const firstRejection = assert.rejects(first, /server stopping/);
    const secondRejection = assert.rejects(second, /server stopping/);
    rejectAllLocationRequests('server stopping');
    await Promise.all([firstRejection, secondRejection]);
  });
});
