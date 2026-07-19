/**
 * SDK message → `StreamChunk` transform — Phase B: stateful, handles live
 * token streaming.
 *
 * With `includePartialMessages: true` (set in buildQueryOptions), the SDK also
 * yields `stream_event` (SDKPartialAssistantMessage) messages carrying the
 * raw Anthropic streaming events. We translate those into `text`/`thinking`/
 * `tool_use` chunks as they arrive so the UI types token-by-token. The SDK
 * THEN yields complete `assistant` message(s) — we dedup against what the
 * deltas already emitted so nothing is shown twice.
 *
 * Wire facts confirmed by capturing the CLI's stream-json output (2026-07-18,
 * claude-code 2.1.198 — see docs/09 §23):
 *
 * - **`message.uuid` is a fresh random value per emitted LINE** — it does NOT
 *   correlate a `stream_event` with its complete `assistant` message, nor two
 *   `stream_event`s with each other. Never use it as a dedup key. (Older
 *   builds shared the uuid between `message_start` and the complete message
 *   but not the deltas, which is why per-uuid dedup half-worked historically.)
 * - A complete `assistant` message is yielded **as soon as one content block's
 *   deltas finish — BEFORE that block's `content_block_stop`** — and one API
 *   message can arrive as SEVERAL non-cumulative completes (e.g. `[thinking]`
 *   then `[tool_use]`).
 * - A content block's complete text equals the concatenation of its deltas
 *   **byte-for-byte**; a tool_use block's `id` is stable across stream and
 *   complete. These — not uuids — are the reliable dedup keys.
 *
 * Correlation therefore runs on a per-scope flow keyed by `parent_tool_use_id`
 * (subagent streams interleave with the top level): `message_start` opens a
 * new flow, deltas accumulate per content-block index, and completes exact-
 * match their blocks against what was streamed.
 *
 * The {@link TransformState} is created fresh per turn by the runtime (turns
 * are serial), which keeps the per-scope bookkeeping local.
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

/** A text/thinking block already shown to the user (exact-content dedup). */
interface ShownBlock {
  type: 'text' | 'thinking';
  text: string;
}

/**
 * Flow state for ONE in-flight API message within one scope. Created/reset by
 * `message_start`. The complete `assistant` message(s) for the API message
 * arrive while the flow is live and dedup against it.
 */
interface MsgFlow {
  /** True once `assistant_message_start` was emitted for this API message
   *  (top-level scope only) — the complete message must not open a 2nd bubble. */
  bubbleOpen: boolean;
  /** In-flight text/thinking accumulators, keyed by content-block index.
   *  A block's deltas are all in by the time its complete arrives (the
   *  complete is yielded before `content_block_stop`), so at complete time
   *  the accumulator holds the block's full text. */
  acc: Map<number, ShownBlock>;
  /** Blocks already shown this API message — finalized streamed blocks plus
   *  blocks emitted from a complete (so a cumulative repeat complete skips
   *  them). Exact full-string match: a complete block's text equals the
   *  concatenation of its deltas, so there is no substring ambiguity. */
  shown: ShownBlock[];
}

/** Scope key for the top-level stream (a real `parent_tool_use_id` never ''). */
const TOP_SCOPE = '';

/**
 * Per-turn transform state. Holds the bookkeeping needed to stream deltas and
 * then dedup the final complete assistant message(s).
 */
export interface TransformState {
  /** In-flight API-message flows, keyed by scope (`parent_tool_use_id`, or
   *  {@link TOP_SCOPE} for the top level). Subagent streams interleave with
   *  the top level, so each gets its own flow. */
  flows: Map<string, MsgFlow>;
  /** Tool-use ids already emitted — by `content_block_stop` OR by a complete
   *  message, whichever arrives first (completes usually win: they precede
   *  the stop on the wire). */
  emittedToolIds: Set<string>;
  /** Tool-use blocks mid-stream, keyed by `${scope}:${content-block index}`. */
  toolBlocks: Map<string, PendingToolBlock>;
}

export function createTransformState(): TransformState {
  return {
    flows: new Map(),
    emittedToolIds: new Set(),
    toolBlocks: new Map(),
  };
}

function freshFlow(): MsgFlow {
  return { bubbleOpen: false, acc: new Map(), shown: [] };
}

/** Get the scope's live flow, creating one if the stream opened mid-message. */
function getFlow(state: TransformState, scope: string): MsgFlow {
  let flow = state.flows.get(scope);
  if (!flow) {
    flow = freshFlow();
    state.flows.set(scope, flow);
  }
  return flow;
}

/** True if `block` (from a complete message) was already shown — either still
 *  accumulating from deltas or finalized/emitted earlier. */
function alreadyShown(flow: MsgFlow, block: ShownBlock): boolean {
  for (const b of flow.acc.values()) {
    if (b.type === block.type && b.text === block.text) return true;
  }
  return flow.shown.some((b) => b.type === block.type && b.text === block.text);
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
  const scope = parent ?? TOP_SCOPE;

  if (event.type === 'message_start') {
    // A new API message in this scope: reset the flow so its blocks dedup
    // against their own deltas only. Subagent turns aren't top-level
    // messages — don't open a new bubble for them.
    const flow = freshFlow();
    state.flows.set(scope, flow);
    if (parent) return;
    flow.bubbleOpen = true;
    yield { type: 'assistant_message_start', itemId: message.uuid };
    return;
  }

  if (event.type === 'content_block_start') {
    const block = (event as { content_block?: { type?: string; id?: string; name?: string } })
      .content_block;
    const index = (event as { index?: number }).index ?? 0;
    if (block?.type === 'tool_use' && typeof block.id === 'string') {
      state.toolBlocks.set(`${scope}:${index}`, {
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
      const flow = getFlow(state, scope);
      const index = (event as { index?: number }).index ?? 0;
      const slot = flow.acc.get(index) ?? { type: 'text' as const, text: '' };
      slot.text += delta.text;
      flow.acc.set(index, slot);
      if (parent) {
        yield { type: 'subagent_text', subagentId: parent, content: delta.text };
      } else {
        yield { type: 'text', content: delta.text };
      }
    } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      const flow = getFlow(state, scope);
      const index = (event as { index?: number }).index ?? 0;
      const slot = flow.acc.get(index) ?? { type: 'thinking' as const, text: '' };
      slot.text += delta.thinking;
      flow.acc.set(index, slot);
      if (!parent) {
        yield { type: 'thinking', content: delta.thinking };
      }
    } else if (
      delta.type === 'input_json_delta' &&
      typeof delta.partial_json === 'string'
    ) {
      const index = (event as { index?: number }).index ?? 0;
      const pending = state.toolBlocks.get(`${scope}:${index}`);
      if (pending) pending.json += delta.partial_json;
    }
    return;
  }

  if (event.type === 'content_block_stop') {
    const index = (event as { index?: number }).index ?? 0;
    // Finalize a streamed text/thinking block into the dedup pool.
    const flow = state.flows.get(scope);
    const slot = flow?.acc.get(index);
    if (flow && slot) {
      flow.acc.delete(index);
      flow.shown.push(slot);
    }
    const key = `${scope}:${index}`;
    const pending = state.toolBlocks.get(key);
    if (pending) {
      state.toolBlocks.delete(key);
      // The complete message usually beats the stop to the wire and emits the
      // tool_use first — then this stop must not re-emit it.
      if (state.emittedToolIds.has(pending.id)) return;
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
  const scope = parent ?? TOP_SCOPE;
  const flow = getFlow(state, scope);
  if (!parent && !flow.bubbleOpen) {
    // No `message_start` seen for this API message (partial events lost or
    // disabled) — open the bubble now.
    flow.bubbleOpen = true;
    yield { type: 'assistant_message_start', itemId: message.uuid };
  }
  const content = message.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type === 'text') {
      // Skip if streamed token-by-token (exact full-text match — a complete
      // block's text is the concatenation of its deltas).
      const shown: ShownBlock = { type: 'text', text: block.text };
      if (alreadyShown(flow, shown)) continue;
      flow.shown.push(shown);
      if (parent) {
        yield { type: 'subagent_text', subagentId: parent, content: block.text };
      } else {
        yield { type: 'text', content: block.text };
      }
    } else if (block.type === 'thinking') {
      const shown: ShownBlock = { type: 'thinking', text: block.thinking };
      if (alreadyShown(flow, shown)) continue;
      flow.shown.push(shown);
      if (!parent) {
        yield { type: 'thinking', content: block.thinking };
      }
    } else if (block.type === 'tool_use') {
      if (state.emittedToolIds.has(block.id)) continue;
      state.emittedToolIds.add(block.id);
      // The complete usually arrives BEFORE this block's content_block_stop —
      // drop the pending assembly so the stop doesn't re-emit the same call.
      for (const [key, pending] of state.toolBlocks) {
        if (pending.id === block.id) state.toolBlocks.delete(key);
      }
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
