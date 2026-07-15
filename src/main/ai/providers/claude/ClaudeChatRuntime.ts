import type { Options, WarmQuery } from '@anthropic-ai/claude-agent-sdk';

import type { AiProvider } from '../../provider';
import type { AiQueryPayload, StreamChunk } from '../../../../shared/ai-types';
import {
  buildClaudeOptions,
  buildColdStartOptions,
  buildTurnPrompt,
} from './buildQueryOptions';
import { findClaudeCLIPath } from './cli/findClaudeCliPath';
import { loadClaudeSdk } from '../../component-resolver';
import {
  createTransformState,
  transformSdkMessage,
} from './stream/transformSdkMessage';
import type { ApprovalCallback } from './approvalHandler';
import { consumeRecentSpawnExit } from './customSpawn';
import { hasApiKey } from '../../security/secretStore';
import { parseEnvironmentVariables } from '../../utils/env';
import fs from 'fs';
import os from 'os';
import path from 'path';

function errorMessage(e: unknown): string {
  let base: string;
  if (e instanceof Error) base = e.message;
  else if (typeof e === 'string') base = e;
  else {
    try {
      base = JSON.stringify(e);
    } catch {
      base = String(e);
    }
  }
  // The SDK throws "Claude Code process exited with code N" / "terminated by
  // signal S" with no stderr. Pull the captured stderr tail for this exit so
  // the user sees the real cause (auth failure, binary mismatch, …) instead
  // of a bare exit code.
  const m = base.match(/exited with code (\d+)|terminated by signal (\w+)/);
  if (m) {
    const expectedCode = m[1] ? Number(m[1]) : null;
    const diag =
      expectedCode !== null ? consumeRecentSpawnExit(expectedCode) : null;
    if (diag?.stderrTail) {
      // eslint-disable-next-line no-control-regex -- intentional: strip ANSI color escapes from Claude CLI stderr
      const ansiColor = /\x1b\[[0-9;]*m/g;
      const tail = diag.stderrTail
        .replace(ansiColor, '') // strip ANSI colors
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-8)
        .join('\n');
      return `${base}\nClaude Code 输出:\n${tail}`;
    }
    return `${base}\n（Claude Code 未输出诊断。常见原因：API key 失效或未运行 \`claude login\`、CLI 二进制与系统不兼容）`;
  }
  return base;
}

interface WarmEntry {
  key: string;
  controller: AbortController;
  promise: Promise<WarmQuery>;
}

/**
 * Runs the Claude Code CLI. Phase C: a **warm-query pool** eliminates
 * per-turn cold-start latency.
 *
 * The SDK's `startup()` pre-spawns + initializes the CLI subprocess; a
 * `WarmQuery` is one-shot (`query(prompt)` runs exactly one turn on the warm
 * process). So we keep ONE pre-warmed query: after each turn we `startup()` the
 * next one (with `resume` = the just-captured sessionId) in the background, so
 * the following turn's process is already up. The renderer also pre-warms on
 * panel-open / conversation-switch so the first turn is warm too.
 *
 * Safety: any failure in the warm path falls back to a plain cold `query()`,
 * so a warm-pool bug can never break a turn — worst case it's no faster than
 * before. A warm query is only reused when its `optionsKey` matches exactly
 * (cwd / systemPrompt / model / effort / permission / cliPath / resume /
 * additionalDirectories); any change discards it and the turn cold-starts.
 */
export class ClaudeChatRuntime implements AiProvider {
  private active = new Map<string, AbortController>();
  private resolvedCliPath: string | null | undefined;
  private warm: WarmEntry | null = null;

  /** Resolve the CLI binary, honoring a settings override; cached. */
  private getCliPath(override: string | null): string | null {
    if (this.resolvedCliPath !== undefined && !override) {
      return this.resolvedCliPath;
    }
    const found = findClaudeCLIPath(override || undefined);
    if (!override) this.resolvedCliPath = found;
    return found;
  }

  /** True if no Anthropic credential is reachable from this machine. */
  private isLikelyUnauthenticated(payload: AiQueryPayload): boolean {
    if (hasApiKey()) return false;
    if (process.env.ANTHROPIC_API_KEY) return false;
    const env = parseEnvironmentVariables(
      payload.settings.envVarOverrides ?? ''
    );
    if (env.ANTHROPIC_API_KEY) return false;
    try {
      return !fs.existsSync(
        path.join(os.homedir(), '.claude', '.credentials.json')
      );
    } catch {
      return false; // can't tell — let the real error speak
    }
  }

  /** Stable key over the option fields that pin a CLI subprocess. */
  optionsKey(options: Options): string {
    return JSON.stringify({
      cwd: options.cwd,
      model: options.model,
      effort: options.effort,
      permissionMode: options.permissionMode,
      cli: options.pathToClaudeCodeExecutable,
      resume: (options.resume as string | undefined) ?? null,
      systemPrompt: options.systemPrompt,
      additionalDirectories: [...(options.additionalDirectories ?? [])].sort(),
      settingSources: options.settingSources,
      // MCP config change must rebuild the warm process (servers are spawned
      // at process start).
      mcpServers: options.mcpServers,
    });
  }

  /** Pre-warm a warm query for the given payload's options (panel-open / switch). */
  prewarm(
    payload: AiQueryPayload,
    approvalCallback: ApprovalCallback
  ): void {
    const cliPath = this.getCliPath(payload.settings.cliPath);
    if (!cliPath) return;
    try {
      const controller = new AbortController();
      const options = buildClaudeOptions({
        payload,
        cliPath,
        resumeSessionId: payload.sessionId,
        approvalCallback,
        abortController: controller,
      });
      this.startWarm(this.optionsKey(options), options, controller);
    } catch {
      // Pre-warm is best-effort; never throw into the renderer.
    }
  }

  /** Start (or reuse) a warm query matching `key`. */
  private startWarm(
    key: string,
    options: Options,
    controller: AbortController
  ): void {
    if (this.warm && this.warm.key === key) return;
    this.destroyWarm();
    this.warm = {
      key,
      controller,
      promise: (async () => {
        const { startup } = await loadClaudeSdk();
        return startup({ options });
      })()
        // If startup (or SDK load) fails, leave a rejected promise; the
        // consumer falls back to a cold query.
        .catch((e) => {
          throw e;
        }),
    };
  }

  /** Close + forget any pending warm query. */
  private destroyWarm(): void {
    const w = this.warm;
    this.warm = null;
    if (w) {
      void w.promise.then(
        (q) => {
          try {
            q.close();
          } catch {
            // ignore
          }
        },
        () => undefined
      );
    }
  }

  async *runTurn(
    payload: AiQueryPayload,
    approvalCallback: ApprovalCallback
  ): AsyncGenerator<StreamChunk> {
    const cliPath = this.getCliPath(payload.settings.cliPath);
    if (!cliPath) {
      yield {
        type: 'error',
        content:
          'Claude Code CLI was not found. Install Claude Code (or set its path in Settings → AI), or switch provider to Ollama/OpenAI in Settings → AI.',
      };
      return;
    }

    // Fast-fail with a clear hint when no Anthropic credential is reachable —
    // otherwise the user waits ~10s for claude.exe to crash with an often-empty
    // stderr. Credentials: stored API key, ANTHROPIC_API_KEY in env / overrides,
    // or `claude login` (~/.claude/.credentials.json).
    if (this.isLikelyUnauthenticated(payload)) {
      yield {
        type: 'error',
        content:
          '未检测到 Claude 凭证。请在 设置 → AI 填写 Anthropic API key，或在系统终端运行 `claude login` 后重启 WhaleTag。',
      };
      return;
    }

    // Try the warm path: take a matching pre-warmed query (one-shot), send the
    // prompt. The warm's controller is the live one for cancel. If the warm
    // process failed to start (startup rejected), fall back to a cold query
    // rather than erroring out — a warm-pool hiccup should never break a turn.
    let sessionIdForNextPrewarm = payload.sessionId;
    const prompt = buildTurnPrompt(payload);
    const transformState = createTransformState();
    try {
      const sdk = await loadClaudeSdk();
      const warm = this.takeWarm(approvalCallback, payload, cliPath, prompt);
      let iterator: AsyncIterable<unknown>;
      let liveController: AbortController;
      if (warm) {
        liveController = warm.controller;
        try {
          const warmQuery = await warm.promise;
          iterator = warmQuery.query(prompt);
        } catch {
          // Warm startup rejected (cli path changed / pre-warm crashed):
          // fall back to a cold query.
          const controller = new AbortController();
          liveController = controller;
          const { options } = buildColdStartOptions({
            payload,
            cliPath,
            resumeSessionId: payload.sessionId,
            approvalCallback,
            abortController: controller,
          });
          iterator = sdk.query({ prompt, options });
        }
      } else {
        // Cold path: fresh controller + fresh query.
        const controller = new AbortController();
        liveController = controller;
        const { options } = buildColdStartOptions({
          payload,
          cliPath,
          resumeSessionId: payload.sessionId,
          approvalCallback,
          abortController: controller,
        });
        iterator = sdk.query({ prompt, options });
      }
      this.active.set(payload.conversationId, liveController);
      try {
        for await (const message of iterator as AsyncIterable<never>) {
          for (const chunk of transformSdkMessage(message, transformState)) {
            if (chunk.type === 'usage' && chunk.sessionId) {
              sessionIdForNextPrewarm = chunk.sessionId;
            }
            yield chunk;
          }
        }
      } finally {
        this.active.delete(payload.conversationId);
      }
    } catch (e) {
      yield { type: 'error', content: errorMessage(e) };
      return;
    }

    // Re-warm for the NEXT turn with the captured sessionId (resume), so the
    // following turn's process is already up. Best-effort.
    this.prewarmNext(payload, cliPath, approvalCallback, sessionIdForNextPrewarm);
  }

  /** Take + clear a matching warm entry, or null if none / mismatch. */
  private takeWarm(
    _approvalCallback: ApprovalCallback,
    payload: AiQueryPayload,
    cliPath: string,
    _prompt: string
  ): WarmEntry | null {
    if (!this.warm) return null;
    // Build the options this turn WOULD use, to compute its key for matching.
    const controller = new AbortController();
    const options = buildClaudeOptions({
      payload,
      cliPath,
      resumeSessionId: payload.sessionId,
      approvalCallback: _approvalCallback,
      abortController: controller,
    });
    const key = this.optionsKey(options);
    if (this.warm.key !== key) {
      // Stale (location/model/… changed) — discard; the turn cold-starts.
      this.destroyWarm();
      return null;
    }
    const entry = this.warm;
    this.warm = null; // one-shot consumed
    return entry;
  }

  /** Pre-warm for the next turn, resuming from `sessionId`. */
  private prewarmNext(
    payload: AiQueryPayload,
    cliPath: string,
    approvalCallback: ApprovalCallback,
    sessionId: string | null
  ): void {
    try {
      const controller = new AbortController();
      const options = buildClaudeOptions({
        payload,
        cliPath,
        resumeSessionId: sessionId,
        approvalCallback,
        abortController: controller,
      });
      this.startWarm(this.optionsKey(options), options, controller);
    } catch {
      // best-effort
    }
  }

  /** Abort the in-flight turn for a conversation (user clicked Stop). */
  cancel(conversationId: string): void {
    this.active.get(conversationId)?.abort();
  }
}
