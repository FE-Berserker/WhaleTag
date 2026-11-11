import { randomUUID } from 'crypto';
import type { McpApprovalRequest } from '../../shared/mcp-types';

/**
 * Approval gate for MCP write tools. Mutating operations performed by an
 * external AI client (move / copy / delete / zip / create) must be approved
 * by the user in a renderer dialog before they run.
 *
 * Fail-closed by design: the request auto-DENIES when no live window can
 * show the dialog, when the user doesn't answer within APPROVAL_TIMEOUT_MS,
 * or when the queue is full. Tag/description edits (sidecar-only) skip the
 * gate — they never touch user files.
 *
 * One dialog at a time (FIFO): the renderer shows a single modal, so a second
 * request would otherwise sit unseen while its 60 s clock ran down and then
 * auto-deny for a dialog the user never saw. Only the head of the queue is
 * broadcast and timed; the next request starts its clock when it is shown.
 */

export const APPROVAL_TIMEOUT_MS = 60_000;

/**
 * Hard cap on outstanding requests. A client that fires mutating calls in a
 * loop must not grow an unbounded queue (each entry holds a promise and a
 * timer); beyond the cap requests fail closed immediately.
 */
export const MAX_PENDING_APPROVALS = 8;

/** Injected by mcp-server.ts at init: broadcast to every live window. */
let broadcast: ((req: McpApprovalRequest) => void) | null = null;
/** Injected by mcp-server.ts: are there live windows to ask? */
let hasWindows: () => boolean = () => false;

export function bindApprovalTransport(opts: {
  broadcast: (req: McpApprovalRequest) => void;
  hasWindows: () => boolean;
}): void {
  broadcast = opts.broadcast;
  hasWindows = opts.hasWindows;
}

interface PendingApproval {
  req: McpApprovalRequest;
  resolve: (allowed: boolean) => void;
  /** Per-request timeout; the clock only starts when the entry is shown. */
  timeoutMs: number;
  timer: NodeJS.Timeout | null;
}

/** FIFO: `queue[0]` is the request currently on screen (if any). */
const queue: PendingApproval[] = [];

/** Put a queued entry on screen: stamp its expiry, start its clock, push it. */
function activate(entry: PendingApproval): void {
  entry.req.expiresAt = Date.now() + entry.timeoutMs;
  entry.timer = setTimeout(() => settle(entry, false), entry.timeoutMs);
  try {
    broadcast?.(entry.req);
  } catch (error) {
    // A destroyed window can throw on send; fail closed instead of leaving a
    // request that no dialog will ever show.
    // eslint-disable-next-line no-console
    console.error('[mcp] approval broadcast failed:', error);
    settle(entry, false);
  }
}

/**
 * Resolve one request and, if it was the visible head, show the next one.
 * Idempotent: a second answer for the same entry is a no-op because the entry
 * is no longer in the queue.
 */
function settle(entry: PendingApproval, allowed: boolean): void {
  const index = queue.indexOf(entry);
  if (index === -1) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  queue.splice(index, 1);
  entry.resolve(allowed);
  if (index === 0) {
    const next = queue[0];
    if (next) activate(next);
  }
}

/** The request currently on screen (what the renderer dialog should show). */
export function pendingApprovals(): McpApprovalRequest[] {
  return queue.length > 0 ? [queue[0].req] : [];
}

/**
 * Ask the user to allow a write operation. Resolves true only on an explicit
 * allow from a live dialog. Any other outcome resolves false. `timeoutMs`
 * overrides APPROVAL_TIMEOUT_MS (tests use a short one).
 */
export function requestApproval(args: {
  tool: string;
  summary: string;
  details: string[];
  timeoutMs?: number;
}): Promise<boolean> {
  if (!broadcast || !hasWindows()) {
    return Promise.resolve(false);
  }
  if (queue.length >= MAX_PENDING_APPROVALS) {
    // eslint-disable-next-line no-console
    console.warn(
      `[mcp] approval queue full (${MAX_PENDING_APPROVALS}); denying ${args.tool}`
    );
    return Promise.resolve(false);
  }
  const req: McpApprovalRequest = {
    reqId: randomUUID(),
    tool: args.tool,
    summary: args.summary,
    details: args.details,
    // Stamped by activate() — a queued request must not burn its clock while
    // another dialog is on screen.
    expiresAt: 0,
  };
  return new Promise<boolean>((resolve) => {
    const entry: PendingApproval = {
      req,
      resolve,
      timeoutMs: args.timeoutMs ?? APPROVAL_TIMEOUT_MS,
      timer: null,
    };
    queue.push(entry);
    if (queue.length === 1) activate(entry);
  });
}

/**
 * Renderer answered (mcp:resolveApproval IPC). Only the visible head can be
 * answered; an unknown or already-settled reqId is a no-op.
 */
export function resolveApproval(reqId: string, allowed: boolean): void {
  const entry = queue[0];
  if (!entry || entry.req.reqId !== reqId) return;
  settle(entry, allowed);
}

/**
 * Deny everything still pending (window closed / server stopping). Drops the
 * whole queue without activating the next entry — quitting must not pop a
 * fresh dialog on the way out.
 */
export function denyAllPending(): void {
  const all = queue.splice(0, queue.length);
  for (const entry of all) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.resolve(false);
  }
}
