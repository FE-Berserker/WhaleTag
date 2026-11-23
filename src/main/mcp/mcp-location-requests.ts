import { randomUUID } from 'crypto';

import type { McpAddLocationRequest } from '../../shared/mcp-types';

/**
 * Main → renderer request channel for `whale_add_location`.
 *
 * Location records belong to the renderer's persisted Redux state, while the
 * MCP server lives in main. This small coordinator lets the tool wait until
 * the renderer has dispatched the addition, synced allowed roots and flushed
 * redux-persist. It never edits the persistence file behind the renderer's
 * back. Completion is explicit and late/unknown acknowledgements are ignored.
 */

export const LOCATION_REQUEST_TIMEOUT_MS = 15_000;
const MAX_PENDING_LOCATION_REQUESTS = 4;

type LocationRequestInput = Omit<McpAddLocationRequest, 'reqId'>;

interface PendingLocationRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

let deliver: ((req: McpAddLocationRequest) => void) | null = null;
let hasWindows: () => boolean = () => false;
const pending = new Map<string, PendingLocationRequest>();

/** Injected by mcp-server.ts; tests can supply an electron-free transport. */
export function bindLocationRequestTransport(opts: {
  deliver: (req: McpAddLocationRequest) => void;
  hasWindows: () => boolean;
}): void {
  deliver = opts.deliver;
  hasWindows = opts.hasWindows;
}

/**
 * Ask the live renderer to add and durably persist a location. Rejects when no
 * window can receive the request, delivery fails, the renderer reports an
 * error, or no acknowledgement arrives before the timeout.
 */
export function requestLocationAddition(
  input: LocationRequestInput,
  timeoutMs = LOCATION_REQUEST_TIMEOUT_MS
): Promise<void> {
  if (!deliver || !hasWindows()) {
    return Promise.reject(
      new Error('no live WhaleTag window can add the location')
    );
  }
  if (pending.size >= MAX_PENDING_LOCATION_REQUESTS) {
    return Promise.reject(
      new Error('too many location additions are already waiting for WhaleTag')
    );
  }

  const req: McpAddLocationRequest = { reqId: randomUUID(), ...input };
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(req.reqId);
      reject(
        new Error(
          'WhaleTag did not confirm the location addition in time; ' +
            'check whale_roots before retrying'
        )
      );
    }, timeoutMs);
    pending.set(req.reqId, { resolve, reject, timer });
    try {
      deliver?.(req);
    } catch (error) {
      clearTimeout(timer);
      pending.delete(req.reqId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Renderer acknowledgement for one request. Returns false for an unknown,
 * already-settled or timed-out id, matching the approval IPC convention.
 */
export function completeLocationRequest(
  reqId: string,
  errorMessage?: string
): boolean {
  const entry = pending.get(reqId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(reqId);
  if (errorMessage) entry.reject(new Error(errorMessage));
  else entry.resolve();
  return true;
}

/** Stop/shutdown hook: no request may remain blocked on a vanished renderer. */
export function rejectAllLocationRequests(reason: string): void {
  const all = Array.from(pending.values());
  pending.clear();
  for (const entry of all) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
}
