import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import type { McpApprovalRequest } from '../../shared/mcp-types';
import {
  bindApprovalTransport,
  requestApproval,
  resolveApproval,
  denyAllPending,
  pendingApprovals,
} from './mcp-approval';

/**
 * Pure-logic tests for the MCP write-op approval gate. The gate is
 * fail-closed: only an explicit allow from a live dialog lets an operation
 * through — timeout, no-window, and denial all count as denial.
 */

function bind(broadcast: ((req: McpApprovalRequest) => void) | null, windows = true) {
  bindApprovalTransport({
    broadcast: broadcast ?? (() => undefined),
    hasWindows: () => windows,
  });
}

describe('mcp approval gate', () => {
  beforeEach(() => {
    // Deny (and thereby clear) anything left over from a previous case.
    denyAllPending();
    bind(null);
  });

  it('denies immediately when no window can show the dialog', async () => {
    bind(null, false);
    const allowed = await requestApproval({
      tool: 'whale_move_files',
      summary: 'Move 1 item',
      details: ['a.txt'],
    });
    assert.equal(allowed, false);
    assert.equal(pendingApprovals().length, 0);
  });

  it('broadcasts the request and resolves on explicit allow', async () => {
    const seen: { reqId: string; tool: string }[] = [];
    bind((req) => seen.push({ reqId: req.reqId, tool: req.tool }));
    const promise = requestApproval({
      tool: 'whale_delete_files',
      summary: 'Delete 2 items (to recycle bin)',
      details: ['a.txt', 'b.txt'],
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].tool, 'whale_delete_files');
    assert.equal(pendingApprovals().length, 1);
    // expiresAt is in the future by APPROVAL_TIMEOUT_MS.
    assert.ok(pendingApprovals()[0].expiresAt > Date.now());
    resolveApproval(seen[0].reqId, true);
    assert.equal(await promise, true);
    assert.equal(pendingApprovals().length, 0);
  });

  it('resolves false on explicit deny', async () => {
    const seen: string[] = [];
    bind((req) => seen.push(req.reqId));
    const promise = requestApproval({
      tool: 'whale_zip_files',
      summary: 'Zip 3 items',
      details: [],
    });
    await new Promise((r) => setImmediate(r));
    resolveApproval(seen[0], false);
    assert.equal(await promise, false);
  });

  it('auto-denies when the user does not answer in time', async () => {
    bind((req) => void req);
    const promise = requestApproval({
      tool: 'whale_move_files',
      summary: 'Move 1 item',
      details: ['a.txt'],
      timeoutMs: 20,
    });
    assert.equal(await promise, false);
    assert.equal(pendingApprovals().length, 0);
  });

  it('denyAllPending rejects every outstanding request (window closed)', async () => {
    const seen: string[] = [];
    bind((req) => seen.push(req.reqId));
    const p1 = requestApproval({ tool: 't1', summary: 's', details: [] });
    const p2 = requestApproval({ tool: 't2', summary: 's', details: [] });
    await new Promise((r) => setImmediate(r));
    assert.equal(pendingApprovals().length, 2);
    denyAllPending();
    assert.equal(await p1, false);
    assert.equal(await p2, false);
  });

  it('ignores a stale resolve for an unknown reqId', async () => {
    const seen: string[] = [];
    bind((req) => seen.push(req.reqId));
    const promise = requestApproval({
      tool: 'whale_create_folder',
      summary: 'Create folder x',
      details: [],
    });
    await new Promise((r) => setImmediate(r));
    // A late/duplicate answer for an already-settled id must not throw…
    resolveApproval('nonexistent', true);
    // …and the real answer still settles the real request.
    resolveApproval(seen[0], true);
    assert.equal(await promise, true);
  });
});
