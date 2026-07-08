/**
 * Read-only location guard for AI tool calls. Enforces the one safety
 * guardrail the user kept alongside "Claudian 全权": a Whale location marked
 * read-only must stay read-only for the agent too — even though the Claude
 * Code CLI's own tools touch disk directly under `cwd`.
 *
 * Pure function; the runtime calls it from `canUseTool` BEFORE any approval
 * modal (Phase B). Phase A auto-allows everything else; this guard is the one
 * hard auto-deny.
 */
import { isPathWithinDirectory } from '../utils/path';

/** Tools that create/modify/delete files. Covers both the Claude CLI's
 *  built-in tool names AND Whale's HTTP-provider tool names. */
const WRITE_TOOLS = new Set([
  // Claude Code CLI built-ins:
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  // Whale HTTP-provider tools (see providers/http/tools.ts):
  'write_file',
  'apply_tag',
]);

/** Tools that run arbitrary shell commands (no declared file target). */
const BASH_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell']);

export interface ReadOnlyGuardContext {
  /** Absolute paths of read-only location roots. */
  readOnlyRoots: string[];
  /** The agent working directory (the active location root). */
  cwd: string;
}

export interface ReadOnlyGuardResult {
  deny: boolean;
  reason?: string;
}

/** Pull the target file path out of a write tool's input. */
function extractTargetPath(
  toolName: string,
  input: Record<string, unknown>
): string | null {
  if (toolName === 'NotebookEdit') {
    const p = input.notebook_path;
    return typeof p === 'string' ? p : null;
  }
  const p = input.file_path ?? input.path;
  return typeof p === 'string' ? p : null;
}

/**
 * Decide whether a tool call must be auto-denied because it would mutate a
 * read-only location. Returns `{ deny: false }` for read-only tools (Read,
 * Grep, Glob, LS, WebSearch, …) and for writes/Bash that target a writable
 * location.
 */
export function checkReadOnlyGuard(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ReadOnlyGuardContext
): ReadOnlyGuardResult {
  if (WRITE_TOOLS.has(toolName)) {
    const target = extractTargetPath(toolName, input);
    if (target && hitsReadOnlyRoot(target, ctx)) {
      return {
        deny: true,
        reason: `Refused: "${target}" is inside a read-only location.`,
      };
    }
    return { deny: false };
  }
  if (BASH_TOOLS.has(toolName)) {
    // Bash has no declared target; gate it on the working directory's writability.
    if (hitsReadOnlyRoot(ctx.cwd, ctx)) {
      return {
        deny: true,
        reason: 'Refused: the current location is read-only (no shell access).',
      };
    }
    return { deny: false };
  }
  return { deny: false };
}

function hitsReadOnlyRoot(
  candidatePath: string,
  ctx: ReadOnlyGuardContext
): boolean {
  return ctx.readOnlyRoots.some((root) =>
    isPathWithinDirectory(candidatePath, root)
  );
}
