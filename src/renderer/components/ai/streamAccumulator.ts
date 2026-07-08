/**
 * Reducer that folds a sequence of {@link StreamChunk}s into a `ChatMessage[]`
 * with ordered `contentBlock`s — the canonical UI state for the AI panel.
 *
 * Phase-B port of Claudian's stream-accumulation logic. Subagent chunks
 * (`subagent_*`) nest under their parent tool call (matched by `subagentId`).
 * Turn stream is serial, so "the current assistant message" is unambiguously
 * the last assistant message in the list.
 */
import type {
  ChatMessage,
  StreamChunk,
  SubagentInfo,
  ToolCallInfo,
} from '../../../shared/ai-types';

/** Append `text` to the last text block of the message, or start a new one. */
function appendText(msg: ChatMessage, text: string): ChatMessage {
  const blocks = msg.contentBlocks ? [...msg.contentBlocks] : [];
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'text') {
    blocks[blocks.length - 1] = { type: 'text', content: last.content + text };
  } else {
    blocks.push({ type: 'text', content: text });
  }
  return { ...msg, content: (msg.content || '') + text, contentBlocks: blocks };
}

function appendThinking(msg: ChatMessage, text: string): ChatMessage {
  const blocks = msg.contentBlocks ? [...msg.contentBlocks] : [];
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'thinking') {
    blocks[blocks.length - 1] = {
      type: 'thinking',
      content: last.content + text,
      durationSeconds: last.durationSeconds,
    };
  } else {
    blocks.push({ type: 'thinking', content: text });
  }
  return { ...msg, contentBlocks: blocks };
}

function registerToolUse(
  msg: ChatMessage,
  id: string,
  name: string,
  input: Record<string, unknown>
): ChatMessage {
  const toolCalls: ToolCallInfo[] = msg.toolCalls
    ? [...msg.toolCalls]
    : [];
  if (!toolCalls.some((t) => t.id === id)) {
    toolCalls.push({ id, name, input, status: 'running' });
  }
  const blocks = msg.contentBlocks ? [...msg.contentBlocks] : [];
  if (!blocks.some((b) => b.type === 'tool_use' && b.toolId === id)) {
    blocks.push({ type: 'tool_use', toolId: id });
  }
  return { ...msg, toolCalls, contentBlocks: blocks };
}

function attachToolResult(
  msg: ChatMessage,
  id: string,
  content: string,
  isError?: boolean
): ChatMessage {
  if (!msg.toolCalls) return msg;
  const status = (isError ? 'error' : 'completed') as ToolCallInfo['status'];
  const toolCalls = msg.toolCalls.map((t) => {
    if (t.id !== id) return t;
    const next = { ...t, result: content, status };
    // A tool_result for the parent tool means its subagent (if any) finished.
    if (t.subagent) {
      next.subagent = {
        ...t.subagent,
        status: (isError ? 'error' : 'completed') as SubagentInfo['status'],
      };
    }
    return next;
  });
  return { ...msg, toolCalls };
}

/** Lazily create the subagent container on a tool call (id = parent tool-use id). */
function ensureSubagent(tc: ToolCallInfo, parentId: string): SubagentInfo {
  if (!tc.subagent) {
    tc.subagent = { id: parentId, status: 'running', toolCalls: [] };
  }
  return tc.subagent;
}

/**
 * Apply `fn` to the tool call with `id` (searched across all assistant
 * messages — the parent tool-use may not be on the streaming tail message).
 */
function updateToolCall(
  messages: ChatMessage[],
  id: string,
  fn: (tc: ToolCallInfo) => ToolCallInfo
): ChatMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    const idx = m.toolCalls.findIndex((t) => t.id === id);
    if (idx === -1) continue;
    const toolCalls = [...m.toolCalls];
    toolCalls[idx] = fn({ ...toolCalls[idx] });
    const copy = [...messages];
    copy[i] = { ...m, toolCalls };
    return copy;
  }
  return messages;
}

function appendToolOutput(msg: ChatMessage, id: string, content: string): ChatMessage {
  if (!msg.toolCalls) return msg;
  const toolCalls = msg.toolCalls.map((t) =>
    t.id === id
      ? { ...t, result: (t.result || '') + content }
      : t
  );
  return { ...msg, toolCalls };
}

/** The last assistant message — where streaming text/tool calls land. */
function updateLastAssistant(
  messages: ChatMessage[],
  fn: (m: ChatMessage) => ChatMessage
): ChatMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      const copy = [...messages];
      copy[i] = fn(copy[i]);
      return copy;
    }
  }
  return messages;
}

/**
 * Fold one chunk into the message list. The "seed" user message is added by the
 * hook on send, so `user_message_start` is a no-op here.
 */
export function applyChunk(
  messages: ChatMessage[],
  chunk: StreamChunk
): ChatMessage[] {
  switch (chunk.type) {
    case 'user_message_start':
      return messages; // renderer echoes the user message on send
    case 'assistant_message_start': {
      const msg: ChatMessage = {
        id: chunk.itemId ?? `a-${messages.length}`,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        contentBlocks: [],
      };
      return [...messages, msg];
    }
    case 'text':
      return updateLastAssistant(messages, (m) => appendText(m, chunk.content));
    case 'thinking':
      return updateLastAssistant(messages, (m) => appendThinking(m, chunk.content));
    case 'tool_use':
      return updateLastAssistant(messages, (m) =>
        registerToolUse(m, chunk.id, chunk.name, chunk.input)
      );
    case 'tool_result':
      return updateLastAssistant(messages, (m) =>
        attachToolResult(m, chunk.id, chunk.content, chunk.isError)
      );
    case 'tool_output':
      return updateLastAssistant(messages, (m) =>
        appendToolOutput(m, chunk.id, chunk.content)
      );
    case 'subagent_text':
      return updateToolCall(messages, chunk.subagentId, (tc) => {
        const sub = ensureSubagent(tc, chunk.subagentId);
        sub.output = (sub.output || '') + chunk.content;
        return tc;
      });
    case 'subagent_tool_use':
      return updateToolCall(messages, chunk.subagentId, (tc) => {
        const sub = ensureSubagent(tc, chunk.subagentId);
        if (!sub.toolCalls.some((t) => t.id === chunk.id)) {
          sub.toolCalls.push({
            id: chunk.id,
            name: chunk.name,
            input: chunk.input,
            status: 'running',
          });
        }
        return tc;
      });
    case 'subagent_tool_result':
      return updateToolCall(messages, chunk.subagentId, (tc) => {
        const sub = ensureSubagent(tc, chunk.subagentId);
        sub.toolCalls = sub.toolCalls.map((t) =>
          t.id === chunk.id
            ? {
                ...t,
                result: chunk.content,
                status: (chunk.isError ? 'error' : 'completed') as ToolCallInfo['status'],
              }
            : t
        );
        return tc;
      });
    case 'context_compacted':
      return updateLastAssistant(messages, (m) => ({
        ...m,
        contentBlocks: [...(m.contentBlocks ?? []), { type: 'context_compacted' }],
      }));
    case 'usage':
    case 'done':
    case 'notice':
    case 'error':
      return messages; // handled by the hook (usage/streaming/error flags)
    default:
      return messages;
  }
}

/** Convenience: fold a whole chunk sequence (used by tests). */
export function accumulate(
  chunks: StreamChunk[],
  seed: ChatMessage[] = []
): ChatMessage[] {
  return chunks.reduce(applyChunk, seed);
}
