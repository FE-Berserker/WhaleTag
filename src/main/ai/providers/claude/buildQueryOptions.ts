/**
 * Build the Claude Agent SDK `Options` for a turn — port of Claudian's
 * `ClaudeQueryOptionsBuilder.ts`, trimmed to Phase A (cold-start only; the
 * persistent warm-query path lands in Phase C).
 *
 * Phase-A continuity: each turn is a fresh `query()` call, but we pass
 * `resume: sessionId` (captured from the previous turn's `result` chunk) so the
 * CLI replays its native session history. This avoids the persistent-query
 * machinery while keeping multi-turn memory.
 */
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { AiQueryPayload, ImageAttachment, ManagedMcpServer } from '../../../../shared/ai-types';
import { buildSystemPrompt } from '../../prompt';
import {
  createCanUseTool,
  type ApprovalCallback,
  type AskUserCallback,
} from './approvalHandler';
import { createCustomSpawnFunction } from './customSpawn';
import { getEnhancedPath, parseEnvironmentVariables } from '../../utils/env';
import { getApiKey } from '../../security/secretStore';
import type { ReadOnlyGuardContext } from '../../security/readOnlyGuard';

/**
 * Filter enabled MCP servers and project them to the SDK's `mcpServers` map
 * shape (`Record<name, config>`). Pure; exported for testing.
 */
export function activeMcpServers(
  servers: ManagedMcpServer[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of servers) {
    if (s.enabled) out[s.name] = s.config;
  }
  return out;
}

export interface BuildOptionsInput {
  payload: AiQueryPayload;
  /** Resolved Claude Code CLI path (from findClaudeCLIPath). */
  cliPath: string;
  /** Previously captured Claude session id, for `resume`. Null on first turn. */
  resumeSessionId: string | null;
  /** Phase A: auto-allow callback. Phase B: IPC approval modal callback. */
  approvalCallback: ApprovalCallback;
  /** AskUserQuestion bridge: pushes the questions to the renderer and awaits
   *  the user's answers. Optional — when absent, AskUserQuestion is denied
   *  with a clear message instead of hanging the turn. */
  askUserCallback?: AskUserCallback;
  /** Abort controller for cancel; also wired into the custom spawn. */
  abortController: AbortController;
}

/** Build the SDK `Options` for a turn (no prompt). Used by both the cold
 *  `query()` path and the warm `startup()` pre-warm path. */
export function buildClaudeOptions(input: BuildOptionsInput): Options {
  const { payload, cliPath, resumeSessionId, approvalCallback, abortController } =
    input;
  const { askUserCallback } = input;
  const { settings, cwd, locationRoots } = payload;

  const readOnlyRoots = locationRoots
    .filter((r) => r.readOnly)
    .map((r) => r.path);
  const additionalDirectories = locationRoots
    .filter((r) => !r.readOnly && r.path !== cwd)
    .map((r) => r.path);

  const guardCtx: ReadOnlyGuardContext = { readOnlyRoots, cwd };

  const enhancedPath = getEnhancedPath(undefined, cliPath);
  const envOverrides = parseEnvironmentVariables(settings.envVarOverrides);
  const apiKey = getApiKey();
  const env: Record<string, string> = {
    ...process.env,
    ...envOverrides,
    PATH: enhancedPath,
  };
  if (apiKey) {
    // Relays/proxies typically authenticate via ANTHROPIC_AUTH_TOKEN (Bearer);
    // official Anthropic uses ANTHROPIC_API_KEY (x-api-key). cc-switch defaults
    // to AUTH_TOKEN — let the user pick which env var the key is written to.
    if (settings.anthropicAuthMode === 'authToken') {
      env.ANTHROPIC_AUTH_TOKEN = apiKey;
    } else {
      env.ANTHROPIC_API_KEY = apiKey;
    }
  }
  // Relay/proxy providers need a custom endpoint (env ANTHROPIC_BASE_URL).
  // Empty = official api.anthropic.com. (Claude Code 2.1+ reads this from env,
  // not ~/.claude/settings.json — see cc-switch docs on relay providers.)
  if (settings.anthropicBaseUrl) {
    env.ANTHROPIC_BASE_URL = settings.anthropicBaseUrl;
  }

  const systemPrompt = buildSystemPrompt({
    cwd,
    locationRoots,
    customInstructions: settings.customSystemPrompt,
    viewMode: payload.turn.viewMode,
    subview: payload.turn.subview,
    viewDepth: payload.turn.viewDepth,
  });

  return {
    abortController,
    cwd,
    additionalDirectories,
    model: settings.model,
    systemPrompt,
    env,
    // canUseTool is the gate for normal/plan (our approval modal). For 'yolo' we
    // use bypassPermissions (full autonomy). allowDangerouslySkipPermissions is
    // REQUIRED to enable bypassPermissions — and it MUST stay OFF in normal/plan,
    // or the SDK forces bypassPermissions and shadows canUseTool entirely (it
    // warns CLAUDE_SDK_CAN_USE_TOOL_SHADOWED): the approval modal never shows,
    // and tools fall through to the CLI's own permission path, which returns a
    // malformed deny for un-allowed MCP tools → the SDK validator throws.
    allowDangerouslySkipPermissions: settings.permissionMode === 'yolo',
    canUseTool: createCanUseTool(
      approvalCallback,
      guardCtx,
      settings.permissionMode,
      askUserCallback
    ),
    // 'yolo' = full autonomy: bypass claude.exe's OWN permission checks too
    // (it otherwise blocks high-risk Bash like `python -c` / redirections at the
    // schema level, which our canUseTool can't override). normal/plan keep the
    // CLI's default gating + our canUseTool (with readOnlyGuard).
    permissionMode:
      settings.permissionMode === 'yolo'
        ? 'bypassPermissions'
        : settings.permissionMode === 'plan'
          ? 'plan'
          : 'default',
    pathToClaudeCodeExecutable: cliPath,
    spawnClaudeCodeProcess: createCustomSpawnFunction(enhancedPath),
    maxTurns: 50,
    effort: settings.effort,
    // Stream assistant text token-by-token (Phase B). The transform assembles
    // the deltas and dedups the trailing complete assistant message.
    includePartialMessages: true,
    // MCP servers (Claude CLI provider). The SDK spawns stdio servers itself.
    mcpServers: activeMcpServers(settings.mcpServers) as never,
    settingSources: settings.loadUserSettings
      ? ['user', 'project', 'local']
      : ['local'],
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
  };
}

/** Build the SDK options + the prompt string for a cold-start turn. */
export function buildColdStartOptions(input: BuildOptionsInput): {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Options;
} {
  return {
    prompt: buildTurnPromptInput(input.payload),
    options: buildClaudeOptions(input),
  };
}

/**
 * Compose the user-facing prompt string for the turn, injecting any attached
 * file/selection context. (The CLI resolves paths itself; we surface the
 * current file inline so the model has it even without a Read call.)
 */
export function buildTurnPrompt(payload: AiQueryPayload): string {
  const { turn } = payload;
  const parts: string[] = [];
  if (turn.currentNotePath) {
    parts.push(
      `<current_note path="${turn.currentNotePath}">` +
        `${turn.editorSelection?.text ?? ''}</current_note>`
    );
  }
  if (turn.selectedPaths && turn.selectedPaths.length > 0) {
    parts.push(formatSelectedFilesBlock(turn.selectedPaths));
  }
  parts.push(turn.text);
  return parts.join('\n\n');
}

/**
 * Render a multi-selection as a compact `<selected_files>` envelope so the
 * model sees the path list without the per-file content blowup. The agent can
 * then `read_file` / `list_tags` / `apply_tag` per path as needed. Pure; shared
 * by the Claude and HTTP provider turn builders.
 */
export function formatSelectedFilesBlock(selectedPaths: string[]): string {
  const count = selectedPaths.length;
  const body = selectedPaths.map((p) => `  - ${p}`).join('\n');
  return `<selected_files count="${count}">\n${body}\n</selected_files>`;
}

/**
 * The turn prompt in the shape `query()` / `WarmQuery.query()` accepts: a
 * plain string for text-only turns, or a single-message async iterable when
 * the turn carries images (pdf-viewer marquee screenshots). The image blocks
 * use the Anthropic API's base64 source shape, so the model sees the region
 * even when it has no extractable text (scanned pages). Pure except the lazy
 * iteration; exported for tests.
 */
export function buildTurnPromptInput(
  payload: AiQueryPayload
): string | AsyncIterable<SDKUserMessage> {
  const text = buildTurnPrompt(payload);
  const images = payload.turn.images;
  if (!images || images.length === 0) return text;
  return singleUserMessagePrompt(text, images);
}

async function* singleUserMessagePrompt(
  text: string,
  images: ImageAttachment[]
): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: [
        ...images.map((img) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: img.mediaType,
            data: img.data,
          },
        })),
        { type: 'text' as const, text },
      ],
    },
    parent_tool_use_id: null,
  };
}
