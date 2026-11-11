import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import type { McpApprovalRequest } from '../../shared/mcp-types';
import {
  APPROVAL_TIMEOUT_MS,
  MAX_PENDING_APPROVALS,
  bindApprovalTransport,
  requestApproval,
  resolveApproval,
  denyAllPending,
  pendingApprovals,
} from './mcp-approval';

/**
 * Pure-logic tests for the MCP write-op approval gate. The gate is
 * fail-closed: only an explicit allow from a live dialog lets an operation
 * through — timeout, no-window, and denial all count as denial. Only one
 * request is on screen at a time; a queued request's clock starts when it is
 * shown, never while another dialog is up.
 */

function bind(broadcast: ((req: McpApprovalRequest) => void) | null, windows = true) {
  bindApprovalTransport({
    broadcast: broadcast ?? (() => undefined),
    hasWindows: () => windows,
  });
}

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    await tick();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].tool, 'whale_delete_files');
    assert.equal(pendingApprovals().length, 1);
    // The visible request's expiry is stamped when it is shown.
    assert.ok(pendingApprovals()[0].expiresAt > Date.now());
    assert.ok(pendingApprovals()[0].expiresAt <= Date.now() + APPROVAL_TIMEOUT_MS);
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
    await tick();
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

  it('shows one request at a time, then promotes the next when the head settles', async () => {
    const seen: McpApprovalRequest[] = [];
    bind((req) => seen.push(req));
    const p1 = requestApproval({ tool: 't1', summary: 'first', details: [] });
    const p2 = requestApproval({ tool: 't2', summary: 'second', details: [] });
    await tick();
    // Only the head is broadcast; the second is queued, not shown.
    assert.equal(seen.length, 1);
    assert.equal(pendingApprovals().length, 1);
    assert.equal(pendingApprovals()[0].tool, 't1');

    resolveApproval(seen[0].reqId, true);
    assert.equal(await p1, true);
    await tick();
    assert.equal(seen.length, 2);
    assert.equal(seen[1].tool, 't2');
    // The promoted request got its expiry stamped only now.
    assert.ok(seen[1].expiresAt >= seen[0].expiresAt);
    assert.equal(pendingApprovals()[0].reqId, seen[1].reqId);

    resolveApproval(seen[1].reqId, true);
    assert.equal(await p2, true);
  });

  it('does not run a queued request’s timeout clock while another dialog is up', async () => {
    const seen: McpApprovalRequest[] = [];
    bind((req) => seen.push(req));
    const p1 = requestApproval({ tool: 't1', summary: 'first', details: [], timeoutMs: 5_000 });
    const p2 = requestApproval({ tool: 't2', summary: 'second', details: [], timeoutMs: 30 });
    await tick();
    const head = seen[0];
    assert.equal(pendingApprovals()[0].reqId, head.reqId);
    // Well past the queued request's 30 ms budget: it must still be waiting.
    await sleep(60);
    assert.equal(pendingApprovals()[0].reqId, head.reqId);
    assert.equal(seen.length, 1);

    // Answering the head promotes the queued request and starts its clock.
    resolveApproval(head.reqId, false);
    assert.equal(await p1, false);
    await tick();
    assert.equal(seen.length, 2);
    assert.equal(await p2, false);
    assert.equal(pendingApprovals().length, 0);
  });

  it('fails closed immediately when the queue is full', async () => {
    bind(() => undefined);
    const accepted: Promise<boolean>[] = [];
    for (let i = 0; i < MAX_PENDING_APPROVALS; i += 1) {
      accepted.push(requestApproval({ tool: `t${i}`, summary: 's', details: [] }));
    }
    await tick();
    assert.equal(pendingApprovals().length, 1);
    const overflow = await requestApproval({ tool: 'overflow', summary: 's', details: [] });
    assert.equal(overflow, false);
    denyAllPending();
    assert.deepEqual(await Promise.all(accepted), accepted.map(() => false));
  });

  it('denyAllPending rejects every outstanding request (window closed)', async () => {
    const seen: string[] = [];
    bind((req) => seen.push(req.reqId));
    const p1 = requestApproval({ tool: 't1', summary: 's', details: [] });
    const p2 = requestApproval({ tool: 't2', summary: 's', details: [] });
    await tick();
    // Only the head is visible; the queued one is still outstanding.
    assert.equal(seen.length, 1);
    assert.equal(pendingApprovals().length, 1);
    denyAllPending();
    assert.equal(await p1, false);
    assert.equal(await p2, false);
    // Quitting does not promote the queued request into a fresh dialog.
    assert.equal(seen.length, 1);
    assert.equal(pendingApprovals().length, 0);
  });

  it('ignores a stale resolve for an unknown reqId', async () => {
    const seen: string[] = [];
    bind((req) => seen.push(req.reqId));
    const promise = requestApproval({
      tool: 'whale_create_folder',
      summary: 'Create folder x',
      details: [],
    });
    await tick();
    // A late/duplicate answer for an already-settled id must not throw…
    resolveApproval('nonexistent', true);
    // …and the real answer still settles the real request.
    resolveApproval(seen[0], true);
    assert.equal(await promise, true);
  });
});
