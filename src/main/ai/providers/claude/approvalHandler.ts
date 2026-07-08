/**
 * Tool-call gate — shared by both providers.
 *
 *  - {@link decideToolCall} runs the read-only guard then the approval callback
 *    and returns a provider-neutral `{allow}` / `{deny, message}` decision.
 *  - {@link createCanUseTool} wraps it into the SDK's `CanUseTool` shape for the
 *    Claude CLI path.
 *  - The HTTP provider calls `decideToolCall` directly (and auto-allows read
 *    tools before it).
 *
 * `allowDangerouslySkipPermissions: true` is set in the options builder so the
 * SDK never shows its own permission UI — this gate fully owns the decision.
 */
import type {
  CanUseTool,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';

import type { ApprovalDecision } from '../../../../shared/ai-types';
import {
  checkReadOnlyGuard,
  type ReadOnlyGuardContext,
} from '../../security/readOnlyGuard';

export type ApprovalCallback = (
  toolName: string,
  input: Record<string, unknown>,
  description: string
) => Promise<ApprovalDecision>;

/** Provider-neutral allow/deny decision. */
export type ToolDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

/**
 * Build a human-readable one-line summary of what a tool call will do. Minimal
 * (tool name + primary target); Claudian's richer per-tool descriptions can be
 * ported later.
 */
export function getActionDescription(
  toolName: string,
  input: Record<string, unknown>
): string {
  const target =
    (typeof input.file_path === 'string' && input.file_path) ||
    (typeof input.path === 'string' && input.path) ||
    (typeof input.notebook_path === 'string' && input.notebook_path) ||
    (typeof input.command === 'string' && input.command) ||
    (typeof input.pattern === 'string' && input.pattern) ||
    '';
  return target ? `${toolName}: ${target}` : toolName;
}

/** Tools that only read (no mutation) — auto-allowed without a modal so the
 *  agent can explore/list freely. Covers Claude Code CLI built-ins + Whale's
 *  MCP tool names. (The HTTP provider already auto-allows its own read tools
 *  before calling decideToolTool; this brings the CLI path to parity.) */
const READ_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'List', 'WebSearch', 'WebFetch', 'TodoRead',
  'read_file', 'list_directory', 'list_tags',
]);

/** Run the read-only guard then the approval callback; return a decision.
 *  `permissionMode='yolo'` auto-allows anything past the guard; read tools are
 *  always auto-allowed (non-mutating). Only writes/bash in normal/plan mode
 *  prompt the user. */
export async function decideToolCall(
  toolName: string,
  input: Record<string, unknown>,
  guardCtx: ReadOnlyGuardContext,
  approvalCallback: ApprovalCallback,
  permissionMode?: 'yolo' | 'plan' | 'normal'
): Promise<ToolDecision> {
  const guard = checkReadOnlyGuard(toolName, input, guardCtx);
  if (guard.deny) {
    return {
      behavior: 'deny',
      message: guard.reason ?? 'Denied by Whale read-only guard.',
    };
  }
  if (permissionMode === 'yolo' || READ_TOOLS.has(toolName)) {
    return { behavior: 'allow' };
  }
  const description = getActionDescription(toolName, input);
  const decision = await approvalCallback(toolName, input, description);
  if (decision === 'deny' || decision === 'cancel') {
    return {
      behavior: 'deny',
      message:
        decision === 'cancel' ? 'User interrupted.' : 'User denied this action.',
      ...(decision === 'cancel' ? { interrupt: true } : {}),
    };
  }
  return { behavior: 'allow' };
}

export function createCanUseTool(
  approvalCallback: ApprovalCallback,
  guardCtx: ReadOnlyGuardContext,
  permissionMode?: 'yolo' | 'plan' | 'normal'
): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    const decision = await decideToolCall(
      toolName,
      input,
      guardCtx,
      approvalCallback,
      permissionMode
    );
    if (decision.behavior === 'allow') return { behavior: 'allow' };
    return {
      behavior: 'deny',
      message: decision.message,
      ...(decision.interrupt ? { interrupt: true } : {}),
    };
  };
}
