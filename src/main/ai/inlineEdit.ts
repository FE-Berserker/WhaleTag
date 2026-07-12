/**
 * Inline edit: rewrite a text selection per the user's instruction. A single
 * non-streaming completion with a strict "output only the replacement" prompt,
 * applied back into the editor by the host.
 *
 * Both HTTP providers (Ollama / OpenAI — a single non-streaming chat
 * completion) AND the Claude CLI path (`query()` cold-start with a dedicated
 * "output only the rewritten text" system prompt). The Claude path resolves
 * the CLI the same way chat does; a missing CLI / cold-start error surfaces
 * as `''` (the host shows the original selection was unchanged) rather than a
 * thrown error so the editor stays interactive.
 *
 * WarmQuery reuse: not worth it. Inline-edit's distinct systemPrompt means its
 * `optionsKey` never matches the chat pool's key (see §8), so the warm pool
 * would cold-start anyway. The path below is cold-start only — acceptable for
 * a one-shot tweak (the CLI spawn is ~1-3s on a warm machine).
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { AiSettingsSnapshot } from '../../shared/ai-types';
import { getSecret, SECRET_NAMES } from './security/secretStore';
import { findClaudeCLIPath } from './providers/claude/cli/findClaudeCliPath';
import { loadClaudeSdk } from './component-resolver';

const INLINE_SYSTEM_PROMPT =
  'You rewrite a text selection from the user\'s file per their instruction. ' +
  'Output ONLY the rewritten text — no preamble, no explanation, no surrounding ' +
  'quotes, no markdown code fences.';

export interface InlineEditInput {
  settings: AiSettingsSnapshot;
  selection: string;
  instruction: string;
}

/** Strip a single pair of surrounding triple fences the model sometimes adds. */
export function cleanReplacement(raw: string): string {
  let out = raw;
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/;
  const m = out.match(fence);
  if (m) out = m[1];
  return out;
}

/**
 * Pull the assistant's text out of an SDK message stream. Concatenate the
 * FINAL assistant message's `text` content blocks (the message after all the
 * partial deltas settle) so tool calls / thinking don't leak in. Returns `''`
 * when no assistant text was emitted. Pure; exported for testing.
 *
 * The SDK's `SDKAssistantMessage.message.content` is the Anthropic content
 * array (text / tool_use / thinking / tool_result blocks); see
 * `transformSdkMessage.ts` for the streaming-time counterpart that yields the
 * same text into the chat panel.
 */
export async function extractAssistantTextFromSdk(
  messages: AsyncIterable<unknown>
): Promise<string> {
  let lastAssistantText = '';
  for await (const msg of messages as AsyncIterable<{
    type?: string;
    message?: { content?: Array<{ type: string; text?: string }> };
  }>) {
    if (msg?.type !== 'assistant') continue;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    // The SDK's final assistant message carries every text block assembled;
    // take the union in order (a turn may have text before/after a tool_use).
    const parts: string[] = [];
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    if (parts.length > 0) lastAssistantText = parts.join('');
  }
  return lastAssistantText;
}

export async function generateInlineEdit(
  input: InlineEditInput
): Promise<string> {
  const { settings, selection, instruction } = input;
  if (settings.provider === 'claude-cli') {
    let cliPath: string | null;
    try {
      cliPath = findClaudeCLIPath(settings.cliPath || undefined);
    } catch {
      cliPath = null;
    }
    return generateInlineEditClaude(input, cliPath);
  }
  return generateInlineEditHttp(settings, selection, instruction);
}

/** Claude CLI inline-edit: a cold-start `query()` with the strict system prompt.
 *  Splits the CLI path off so tests can exercise the missing-CLI branch without
 *  spawning the SDK / a real CLI. */
export async function generateInlineEditClaude(
  input: InlineEditInput,
  cliPath: string | null
): Promise<string> {
  if (!cliPath) return '';
  const { settings, selection, instruction } = input;

  try {
    // Resolve the SDK via the OPTIONAL AI component (loadClaudeSdk). A packaged
    // build has no devDeps in node_modules, so `import('@anthropic-ai/…')`
    // (webpack-externalized to an app-level require) would throw
    // MODULE_NOT_FOUND; only loadClaudeSdk's createRequire(<componentDir>/…)
    // path can resolve it from <userData>/components/ai. If the component isn't
    // installed this throws "未安装 AI 组件" — caught below → '' (graceful).
    const sdk = await loadClaudeSdk();
    const query = sdk.query;
    const abortController = new AbortController();
    const options: Options = {
      abortController,
      model: settings.model,
      systemPrompt: INLINE_SYSTEM_PROMPT,
      pathToClaudeCodeExecutable: cliPath,
      // No cwd / additionalDirectories — inline-edit is pure text→text, the agent
      // doesn't read/write files here, so we don't widen the allowed-roots scope.
      permissionMode: 'default',
      maxTurns: 1,
      effort: settings.effort,
      allowDangerouslySkipPermissions: false,
      // The DIRTI-setting suppresses any CLI-side "would you like to …" prompts.
    };
    const prompt =
      `Instruction: ${instruction}\n\n` +
      `Selection:\n"""\n${selection}\n"""`;

    const iterator = query({ prompt, options }) as AsyncIterable<unknown>;
    const raw = await extractAssistantTextFromSdk(iterator);
    return cleanReplacement(raw);
  } catch {
    // Missing component, CLI spawn failure, or SDK error — keep the editor
    // interactive; the host shows aiInlineEditClaudeEmpty on ''.
    return '';
  }
}

/** HTTP inline-edit: a single non-streaming chat completion. */
async function generateInlineEditHttp(
  settings: AiSettingsSnapshot,
  selection: string,
  instruction: string
): Promise<string> {
  const isOllama = settings.provider === 'ollama';
  const base = (isOllama ? settings.ollamaUrl : settings.openaiUrl).replace(
    /\/+$/,
    ''
  );
  const apiKey = isOllama ? '' : getSecret(SECRET_NAMES.openai);

  let resp: Response;
  try {
    resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: settings.model,
        stream: false,
        messages: [
          { role: 'system', content: INLINE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Instruction: ${instruction}\n\nSelection:\n"""\n${selection}\n"""`,
          },
        ],
      }),
    });
  } catch {
    return '';
  }
  if (!resp.ok) return '';
  try {
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return cleanReplacement(data.choices?.[0]?.message?.content ?? '');
  } catch {
    return '';
  }
}
