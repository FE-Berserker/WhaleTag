/**
 * SDK message → `StreamChunk` transform — Phase B: stateful, handles live
 * token streaming.
 *
 * With `includePartialMessages: true` (set in buildQueryOptions), the SDK also
 * yields `stream_event` (SDKPartialAssistantMessage) messages carrying the
 * raw Anthropic streaming events. We translate those into `text`/`thinking`/
 * `tool_use` chunks as they arrive so the UI types token-by-token. The SDK
 * THEN yields the complete `assistant` message — we dedup against what the
 * deltas already emitted so nothing is shown twice.
 *
 * The {@link TransformState} is created fresh per turn by the runtime (turns
 * are serial), which keeps the per-index/per-uuid bookkeeping local.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { StreamChunk, UsageInfo } from '../../../../../shared/ai-types';

/** Discriminated content-block shapes we narrow at runtime (complete msgs). */
interface TextBlock {
  type: 'text';
  text: string;
}
interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}
interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}
type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** A tool_use block being assembled from `input_json_delta` chunks. */
interface PendingToolBlock {
  id: string;
  name: string;
  /** Accumulated raw JSON string from input_json_delta; parsed on stop. */
  json: string;
}

/**
 * Per-turn transform state. Holds the bookkeeping needed to stream deltas and
 * then dedup the final complete assistant message.
 */
export interface TransformState {
  /** Assistant message uuids whose `assistant_message_start` was emitted. */
  startedMsgs: Set<string>;
  /** Assistant message uuids that received any streamed text/thinking. */
  streamedMsgs: Set<string>;
  /** Tool-use ids already emitted via content_block_stop (to skip in complete). */
  emittedToolIds: Set<string>;
  /** Tool-use blocks mid-stream, keyed by content-block index. */
  toolBlocks: Map<number, PendingToolBlock>;
}

export function createTransformState(): TransformState {
  return {
    startedMsgs: new Set(),
    streamedMsgs: new Set(),
    emittedToolIds: new Set(),
    toolBlocks: new Map(),
  };
}

/**
 * Convert one SDK message into zero or more stream chunks. A generator so the
 * runtime can `yield*` it without buffering.
 *
 * `parent` = the message's `parent_tool_use_id`. When set, the message belongs
 * to a subagent turn (nested under the tool-use that spawned it) and is emitted
 * as `subagent_*` chunks instead of flat top-level ones.
 */
export function* transformSdkMessage(
  message: SDKMessage,
  state: TransformState = createTransformState()
): Generator<StreamChunk> {
  const parent =
    (message as { parent_tool_use_id?: string | null }).parent_tool_use_id ??
    null;
  switch (message.type) {
    case 'stream_event':
      yield* transformStreamEvent(message, state, parent);
      break;
    case 'assistant':
      yield* transformAssistant(message, state, parent);
      break;
    case 'user':
      yield* transformUser(message, parent);
      break;
    case 'result':
      yield* transformResult(message);
      break;
    default:
      // system/init, control messages — ignored.
      break;
  }
}

/** Live deltas: text/thinking stream token-by-token; tool_use assembled. */
function* transformStreamEvent(
  message: { uuid: string; event: unknown },
  state: TransformState,
  parent: string | null
): Generator<StreamChunk> {
  const event = message.event as { type?: string };
  if (!event || typeof event.type !== 'string') return;
  const uuid = message.uuid;

  if (event.type === 'message_start') {
    // Subagent turns aren't top-level messages — don't open a new bubble.
    if (parent) return;
    if (!state.startedMsgs.has(uuid)) {
      state.startedMsgs.add(uuid);
      yield { type: 'assistant_message_start', itemId: uuid };
    }
    return;
  }

  if (event.type === 'content_block_start') {
    const block = (event as { content_block?: { type?: string; id?: string; name?: string } })
      .content_block;
    if (block?.type === 'tool_use' && typeof block.id === 'string') {
      const index = (event as { index?: number }).index ?? 0;
      state.toolBlocks.set(index, {
        id: block.id,
        name: typeof block.name === 'string' ? block.name : '',
        json: '',
      });
    }
    return;
  }

  if (event.type === 'content_block_delta') {
    const delta = (event as { delta?: { type?: string; text?: string; thinking?: string; partial_json?: string } }).delta;
    if (!delta) return;
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      state.streamedMsgs.add(uuid);
      if (parent) {
        yield { type: 'subagent_text', subagentId: parent, content: delta.text };
      } else {
        yield { type: 'text', content: delta.text };
      }
    } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      state.streamedMsgs.add(uuid);
      if (!parent) yield { type: 'thinking', content: delta.thinking };
    } else if (
      delta.type === 'input_json_delta' &&
      typeof delta.partial_json === 'string'
    ) {
      const index = (event as { index?: number }).index ?? 0;
      const pending = state.toolBlocks.get(index);
      if (pending) pending.json += delta.partial_json;
    }
    return;
  }

  if (event.type === 'content_block_stop') {
    const index = (event as { index?: number }).index ?? 0;
    const pending = state.toolBlocks.get(index);
    if (pending) {
      state.toolBlocks.delete(index);
      state.emittedToolIds.add(pending.id);
      const input = parseToolInput(pending.json);
      if (parent) {
        yield {
          type: 'subagent_tool_use',
          subagentId: parent,
          id: pending.id,
          name: pending.name,
          input,
        };
      } else {
        yield { type: 'tool_use', id: pending.id, name: pending.name, input };
      }
    }
    return;
  }
}

/** Complete assistant message — emit only what the deltas didn't already send. */
function* transformAssistant(
  message: { uuid: string; message?: { content?: ContentBlock[] } },
  state: TransformState,
  parent: string | null
): Generator<StreamChunk> {
  const uuid = message.uuid;
  if (!parent && !state.startedMsgs.has(uuid)) {
    state.startedMsgs.add(uuid);
    yield { type: 'assistant_message_start', itemId: uuid };
  }
  const content = message.message?.content;
  if (!Array.isArray(content)) return;
  const streamed = state.streamedMsgs.has(uuid);
  for (const block of content) {
    if (block.type === 'text') {
      if (streamed) continue;
      if (parent) {
        yield { type: 'subagent_text', subagentId: parent, content: block.text };
      } else {
        yield { type: 'text', content: block.text };
      }
    } else if (block.type === 'thinking') {
      if (!streamed && !parent) yield { type: 'thinking', content: block.thinking };
    } else if (block.type === 'tool_use') {
      if (state.emittedToolIds.has(block.id)) continue;
      if (parent) {
        yield {
          type: 'subagent_tool_use',
          subagentId: parent,
          id: block.id,
          name: block.name,
          input: block.input ?? {},
        };
      } else {
        yield {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input ?? {},
        };
      }
    }
  }
}

/** tool_result blocks the SDK routes back through a `user` message. */
function* transformUser(
  message: { message?: { content?: ContentBlock[] } },
  parent: string | null
): Generator<StreamChunk> {
  const content = message.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type !== 'tool_result') continue;
    const body = stringifyToolResult(block.content);
    if (parent) {
      yield {
        type: 'subagent_tool_result',
        subagentId: parent,
        id: block.tool_use_id,
        content: body,
        isError: block.is_error === true,
      };
    } else {
      yield {
        type: 'tool_result',
        id: block.tool_use_id,
        content: body,
        isError: block.is_error === true,
      };
    }
  }
}

function* transformResult(message: {
  subtype?: string;
  usage?: UsageBlock;
  session_id?: string;
}): Generator<StreamChunk> {
  if (message.subtype === 'success') {
    yield { type: 'usage', usage: toUsageInfo(message.usage), sessionId: message.session_id ?? null };
    yield { type: 'done' };
  } else {
    yield {
      type: 'error',
      content: `Claude request failed${message.subtype ? ` (${message.subtype})` : ''}.`,
    };
  }
}

function parseToolInput(json: string): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Flatten a tool_result `content` (string | block array) into display text. */
function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === 'object') {
          const b = block as { type?: string; text?: string };
          if (b.type === 'text' && typeof b.text === 'string') return b.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content === null || content === undefined) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/**
 * Build a {@link UsageInfo} from the SDK's per-turn usage block. `output_tokens`
 * doubles as the context-token estimate in Phase A/B; the authoritative
 * context-window total arrives via the `result` message in a later phase.
 */
function toUsageInfo(usage: UsageBlock | undefined): UsageInfo {
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const contextTokens = inputTokens + outputTokens + cacheCreation + cacheRead;
  const contextWindow = 200_000;
  const percentage = Math.min(
    100,
    Math.round((contextTokens / contextWindow) * 100)
  );
  return {
    inputTokens,
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
    contextWindow,
    contextTokens,
    percentage,
  };
}
