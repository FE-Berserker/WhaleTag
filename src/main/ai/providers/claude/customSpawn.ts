/**
 * Custom spawn function for the Claude Agent SDK — port of Claudian's
 * `src/providers/claude/runtime/customSpawn.ts` (pure Node; the Obsidian
 * comment is preserved because the gotcha is identical under Electron).
 *
 * The SDK calls this to launch the Claude Code CLI. We:
 *  1. Re-route Node-backed CLI paths (`.js`/`.cjs`/shebang) through a `node`
 *     found via the enhanced PATH (Electron may launch with a minimal PATH).
 *  2. Rewrap Windows `.cmd` shims as `cmd.exe /d /s /c …` (see windowsCmdShim).
 *  3. Handle abort MANUALLY — passing `signal` straight to `spawn()` fails
 *     under Electron because AbortSignal lives in a different realm than
 *     Node's internals (`instanceof EventTarget` checks reject it).
 */
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { type ChildProcess, spawn } from 'child_process';

import { cliPathRequiresNode, findNodeExecutable } from '../../utils/env';
import {
  resolveWindowsCmdShimSpawnSpec,
  terminateSpawnedProcess,
  type WindowsCmdShimSpawnSpec,
} from '../../utils/windowsCmdShim';

/** Diagnostic snapshot of a Claude Code subprocess that exited non-zero. */
interface SpawnExitDiag {
  pid: number | undefined;
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  at: number;
}

// Ring buffer of recent non-zero exits. The SDK's `SpawnedProcess` type has no
// stderr field — it reports only a bare "Claude Code process exited with code N".
// We capture the child's stderr here so ClaudeChatRuntime.errorMessage can
// surface the real cause (auth failure, binary mismatch, …). cli-wrapper.cjs
// spawns the real claude.exe with stdio:'inherit', so claude.exe's stderr flows
// to us through the child's stderr pipe.
const MAX_EXIT_ENTRIES = 8;
const MAX_STDERR_BYTES = 64 * 1024;
const recentExits: SpawnExitDiag[] = [];

/**
 * Pop the most recent exit diagnostic matching `expectedCode` (within 30s).
 * Consumes (removes) the entry so a stale diag can't be reused by a later turn.
 * Returns null if none matches — caller falls back to a generic hint.
 */
export function consumeRecentSpawnExit(
  expectedCode: number
): SpawnExitDiag | null {
  const now = Date.now();
  for (let i = recentExits.length - 1; i >= 0; i--) {
    const d = recentExits[i];
    if (d.code === expectedCode && now - d.at < 30_000) {
      recentExits.splice(i, 1);
      return d;
    }
  }
  return null;
}

export function createCustomSpawnFunction(
  enhancedPath: string
): (options: SpawnOptions) => SpawnedProcess {
  return (options: SpawnOptions): SpawnedProcess => {
    let { command } = options;
    let { args } = options;
    const { cwd, env, signal } = options;
    const shouldPipeStderr = !!env?.DEBUG_CLAUDE_AGENT_SDK;

    // Normalize Node-backed CLI paths before Electron spawns with shell=false.
    if (command === 'node' || cliPathRequiresNode(command)) {
      const nodeFullPath = findNodeExecutable(enhancedPath);
      if (command === 'node') {
        if (nodeFullPath) command = nodeFullPath;
      } else {
        args = [command, ...args];
        command = nodeFullPath ?? 'node';
      }
    }

    const resolvedSpawnSpec = resolveWindowsCmdShimSpawnSpec({ args, command });

    // Do NOT pass `signal` directly to spawn() — Electron's AbortSignal lives
    // in a different realm, so Node's `instanceof EventTarget` checks fail.
    // Handle abort manually instead.
    const child = spawn(resolvedSpawnSpec.command, resolvedSpawnSpec.args, {
      cwd,
      env: env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(resolvedSpawnSpec.windowsVerbatimArguments
        ? { windowsVerbatimArguments: true }
        : {}),
    });
    installTreeAwareKill(child, resolvedSpawnSpec);

    if (signal) {
      const killChild = (): void => {
        child.kill('SIGTERM');
      };
      if (signal.aborted) {
        killChild();
      } else {
        signal.addEventListener('abort', killChild, { once: true });
      }
    }

    // Drain stderr into a rolling buffer so a non-zero exit can be diagnosed.
    // MUST be consumed — an undrained stderr pipe fills (~64KB) and blocks
    // claude.exe. Keep only the tail to bound memory.
    let stderrBuf = '';
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8');
        if (stderrBuf.length > MAX_STDERR_BYTES) {
          stderrBuf = stderrBuf.slice(-MAX_STDERR_BYTES);
        }
        if (shouldPipeStderr) process.stderr.write(`[claude] ${chunk}`);
      });
    }
    child.on('exit', (code, signal) => {
      if ((code !== null && code !== 0) || signal) {
        recentExits.push({
          pid: child.pid,
          code,
          signal,
          stderrTail: stderrBuf.slice(-4096).trim(),
          at: Date.now(),
        });
        while (recentExits.length > MAX_EXIT_ENTRIES) recentExits.shift();
      }
    });

    if (!child.stdin || !child.stdout) {
      throw new Error('Failed to create process streams');
    }

    return child as unknown as SpawnedProcess;
  };
}

function installTreeAwareKill(
  child: ChildProcess,
  spawnSpec: WindowsCmdShimSpawnSpec
): void {
  if (!spawnSpec.killProcessTree) return;
  const originalKill: (signal?: NodeJS.Signals | number) => boolean =
    child.kill.bind(child);
  const killableChild = {
    get pid(): number | undefined {
      return child.pid;
    },
    kill: (signal?: NodeJS.Signals | number): boolean => originalKill(signal),
  };
  child.kill = ((signal?: NodeJS.Signals | number): boolean =>
    terminateSpawnedProcess(killableChild, signal, spawn, spawnSpec)) as never;
}
