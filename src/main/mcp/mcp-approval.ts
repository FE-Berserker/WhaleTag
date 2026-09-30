import { randomUUID } from 'crypto';
import type { McpApprovalRequest } from '../../shared/mcp-types';

/**
 * Approval gate for MCP write tools. Mutating operations performed by an
 * external AI client (move / copy / delete / zip / create) must be approved
 * by the user in a renderer dialog before they run.
 *
 * Fail-closed by design: the request auto-DENIES when no live window can
 * show the dialog, when the user doesn't answer within APPROVAL_TIMEOUT_MS,
 * or when a new request supersedes an unanswered one. Tag/description edits
 * (sidecar-only) skip the gate — they never touch user files.
 */

export const APPROVAL_TIMEOUT_MS = 60_000;

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
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingApproval>();

/** All unanswered requests (the renderer re-renders its dialogs from this). */
export function pendingApprovals(): McpApprovalRequest[] {
  return Array.from(pending.values(), (p) => p.req);
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
  const reqId = randomUUID();
  const timeout = args.timeoutMs ?? APPROVAL_TIMEOUT_MS;
  const req: McpApprovalRequest = {
    reqId,
    tool: args.tool,
    summary: args.summary,
    details: args.details,
    expiresAt: Date.now() + timeout,
  };
  return new Promise<boolean>((resolve) => {
    const settle = (allowed: boolean) => {
      clearTimeout(pending.get(reqId)?.timer);
      pending.delete(reqId);
      resolve(allowed);
    };
    const timer = setTimeout(() => settle(false), timeout);
    pending.set(reqId, {
      req,
      resolve: settle,
      timer,
    });
    broadcast(req);
  });
}

/** Renderer answered (mcp:resolveApproval IPC). Unknown reqId is a no-op. */
export function resolveApproval(reqId: string, allowed: boolean): void {
  pending.get(reqId)?.resolve(allowed);
}

/** Deny everything still pending (window closed / server stopping). */
export function denyAllPending(): void {
  for (const p of pending.values()) p.resolve(false);
}

/** Convenience for tests / status reporting. */
export function approvalCount(): number {
  return pending.size;
}
