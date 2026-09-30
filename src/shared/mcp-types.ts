/**
 * Types shared between the main process and the renderer for the built-in
 * MCP server (docs/21). The server itself lives in `src/main/mcp/`; the
 * renderer only ever sees status + approval traffic over the preload bridge.
 */

/** Snapshot of the MCP server state, polled by Settings → Integrations. */
export interface McpStatus {
  /** Whether the HTTP listener is up (enabled in config AND bound). */
  running: boolean;
  /** The port the listener actually bound (config port, or a random fallback
   *  when the configured port was taken). Null while not running. */
  port: number | null;
  /** Full endpoint URL for external clients, e.g. `http://127.0.0.1:7433/mcp`. */
  endpoint: string | null;
  /** The bearer token external clients must send. Generated locally; shown
   *  in the settings UI so the user can copy it into their AI client. */
  token: string;
  /** Read-only mode: every mutating tool call is refused without approval. */
  readOnly: boolean;
  /** How many MCP sessions are currently open. */
  sessions: number;
}

/**
 * A write operation an external AI client wants to perform, pushed to the
 * renderer for an explicit allow/deny decision (fail-closed: no answer
 * within the timeout, or no live window, means deny).
 */
export interface McpApprovalRequest {
  reqId: string;
  /** Tool name, e.g. `whale_move_files`. */
  tool: string;
  /** Human-readable one-line summary, e.g. "Move 3 items to D:\docs". */
  summary: string;
  /** Detailed lines for the dialog body (paths involved, first N). */
  details: string[];
  /** Epoch ms when the request expires (auto-deny). */
  expiresAt: number;
}
