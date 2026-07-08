import type { AiQueryPayload, StreamChunk } from '../../shared/ai-types';
import type { ApprovalCallback } from './providers/claude/approvalHandler';

/**
 * Provider-neutral turn runner. Each backend (Claude Code CLI, Ollama/OpenAI
 * HTTP) implements this; the IPC layer selects one from `payload.settings.provider`.
 *
 * `payload` carries everything (cwd, history, sessionId for resume, settings);
 * providers read the fields they need. The Claude CLI provider uses
 * `payload.sessionId` (resume); HTTP providers are stateless and use
 * `payload.history`. The approval callback only matters for providers that run
 * tools (Claude); HTTP chat ignores it.
 */
export interface AiProvider {
  runTurn(
    payload: AiQueryPayload,
    approvalCallback: ApprovalCallback
  ): AsyncGenerator<StreamChunk>;
  /** Abort the in-flight turn for a conversation (user clicked Stop). */
  cancel(conversationId: string): void;
}
