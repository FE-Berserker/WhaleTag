/**
 * HTTP chat provider covering both **Ollama** and any **OpenAI-compatible**
 * endpoint, because Ollama implements the OpenAI `/v1/chat/completions` API.
 *
 * Two modes:
 *  - **Chat-only** (`settings.aiHttpTools === false`): one streaming request,
 *    SSE text deltas → `StreamChunk`. The original Phase-C.1 behavior.
 *  - **With tools** (default): a multi-round agent loop. The model emits
 *    `tool_calls`; Whale DEFINES + EXECUTES the tools itself (read/list/write,
 *    confined to `allowedRoots`), feeds results back, and re-requests until the
 *    model produces a final answer with no further tool calls. Writes are gated
 *    by the shared `decideToolCall` (read-only guard + approval modal) — the
 *    original roadmap's "Whale-constrained tools" model, which the Claude CLI
 *    path (CLI touches disk itself) can't offer.
 *
 * Stateless across turns: the full history is sent each turn via `payload.history`.
 */
import type { AiProvider } from '../../provider';
import type {
  AiQueryPayload,
  ChatTurnRequest,
  StreamChunk,
  UsageInfo,
} from '../../../../shared/ai-types';
import type { ApprovalCallback } from '../claude/approvalHandler';
import { decideToolCall } from '../claude/approvalHandler';
import type { ReadOnlyGuardContext } from '../../security/readOnlyGuard';
import { buildSystemPrompt } from '../../prompt';
import { SECRET_NAMES, getSecret } from '../../security/secretStore';
import {
  READ_TOOLS,
  TOOL_DESCRIPTORS,
  executeTool,
  parseArguments,
  type ParsedToolCall,
  type ToolDescriptor,
} from './tools';

interface OpenAiDelta {
  role?: string;
  content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}
interface OpenAiChunk {
  choices?: Array<{ delta?: OpenAiDelta }>;
}

const MAX_TOOL_ROUNDS = 12;

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

type ChatMessageLike = { role: string; content: string | null } & Record<
  string,
  unknown
>;

/** Build the OpenAI `messages` array: system + history + current user turn. */
export function buildMessages(
  payload: AiQueryPayload
): ChatMessageLike[] {
  const system = buildSystemPrompt({
    cwd: payload.cwd,
    locationRoots: payload.locationRoots,
    customInstructions: payload.settings.customSystemPrompt,
    viewMode: payload.turn.viewMode,
    subview: payload.turn.subview,
    viewDepth: payload.turn.viewDepth,
  });
  const messages: ChatMessageLike[] = [{ role: 'system', content: system }];
  for (const m of payload.history) {
    const content = (m.role === 'user' ? m.displayContent || m.content : m.content) || '';
    if (content) messages.push({ role: m.role, content });
  }
  messages.push({ role: 'user', content: buildUserContent(payload.turn) });
  return messages;
}

/** Inline the attached file content into the user message. */
function buildUserContent(turn: ChatTurnRequest): string {
  const parts: string[] = [];
  if (turn.currentNotePath) {
    const body = turn.editorSelection?.text ?? '';
    parts.push(
      `<current_note path="${turn.currentNotePath}">${body}</current_note>`
    );
  }
  if (turn.selectedPaths && turn.selectedPaths.length > 0) {
    const count = turn.selectedPaths.length;
    const body = turn.selectedPaths.map((p) => `  - ${p}`).join('\n');
    parts.push(`<selected_files count="${count}">\n${body}\n</selected_files>`);
  }
  parts.push(turn.text);
  return parts.join('\n\n');
}

/** Parse an SSE byte stream into JSON payloads, ending at `data: [DONE]`. */
export async function* parseSse(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<OpenAiChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || line.startsWith(':') || !line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data) as OpenAiChunk;
      } catch {
        // Skip malformed frame.
      }
    }
  }
}

export class HttpChatProvider implements AiProvider {
  private active = new Map<string, AbortController>();

  async *runTurn(
    payload: AiQueryPayload,
    approvalCallback: ApprovalCallback
  ): AsyncGenerator<StreamChunk> {
    const { settings } = payload;
    const isOllama = settings.provider === 'ollama';
    const base = (isOllama ? settings.ollamaUrl : settings.openaiUrl).replace(
      /\/+$/,
      ''
    );
    const url = `${base}/chat/completions`;
    const apiKey = isOllama ? '' : getSecret(SECRET_NAMES.openai);
    const tools: ToolDescriptor[] | undefined = settings.aiHttpTools
      ? TOOL_DESCRIPTORS
      : undefined;
    const guardCtx: ReadOnlyGuardContext = {
      readOnlyRoots: payload.locationRoots
        .filter((r) => r.readOnly)
        .map((r) => r.path),
      cwd: payload.cwd,
    };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
    const messages = buildMessages(payload);

    yield {
      type: 'assistant_message_start',
      itemId: `${payload.conversationId}-a`,
    };

    const abortController = new AbortController();
    this.active.set(payload.conversationId, abortController);

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        // streamRound yields text chunks live AND returns the round's tool calls.
        const toolCalls = yield* this.streamRound(
          url,
          headers,
          settings.model,
          messages,
          tools,
          abortController.signal
        );
        if (toolCalls.length === 0) break; // final answer (no further tool calls)

        // Record the assistant turn with its tool_calls, then execute + feed back.
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments || '{}' },
          })),
        });
        for (const call of toolCalls) {
          const input = parseArguments(call.arguments);
          yield { type: 'tool_use', id: call.id, name: call.name, input };
          let result: { content: string; isError: boolean };
          if (READ_TOOLS.has(call.name)) {
            result = await executeTool(call);
          } else {
            const decision = await decideToolCall(
              call.name,
              input,
              guardCtx,
              approvalCallback
            );
            result =
              decision.behavior === 'allow'
                ? await executeTool(call)
                : { content: decision.message, isError: true };
          }
          yield {
            type: 'tool_result',
            id: call.id,
            content: result.content,
            isError: result.isError,
          };
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: result.content,
          });
        }
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        yield { type: 'done' };
        this.active.delete(payload.conversationId);
        return;
      }
      yield { type: 'error', content: errorMessage(e) };
    } finally {
      this.active.delete(payload.conversationId);
    }

    // OpenAI SSE doesn't reliably carry token counts; emit a zero usage chunk so
    // the UI finalizes the turn.
    const usage: UsageInfo = {
      inputTokens: 0,
      contextWindow: 0,
      contextTokens: 0,
      percentage: 0,
    };
    yield { type: 'usage', usage, sessionId: null };
    yield { type: 'done' };
  }

  /**
   * One streaming request round. Yields `text` chunks live (token streaming)
   * and returns the model's tool calls for this round (empty = final answer).
   */
  private async *streamRound(
    url: string,
    headers: Record<string, string>,
    model: string,
    messages: ChatMessageLike[],
    tools: ToolDescriptor[] | undefined,
    signal: AbortSignal
  ): AsyncGenerator<StreamChunk, ParsedToolCall[]> {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        ...(tools ? { tools } : {}),
      }),
      signal,
    });
    if (!resp.ok || !resp.body) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`${resp.status}: ${detail.slice(0, 200)}`);
    }

    const toolByIndex = new Map<number, ParsedToolCall>();
    for await (const chunk of parseSse(resp.body)) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content) {
        yield { type: 'text', content: delta.content };
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolByIndex.get(tc.index);
          const id = tc.id ?? existing?.id ?? '';
          const name = tc.function?.name ?? existing?.name ?? '';
          const args =
            (existing?.arguments ?? '') + (tc.function?.arguments ?? '');
          toolByIndex.set(tc.index, { id, name, arguments: args });
        }
      }
    }
    return [...toolByIndex.values()];
  }

  cancel(conversationId: string): void {
    this.active.get(conversationId)?.abort();
  }
}
