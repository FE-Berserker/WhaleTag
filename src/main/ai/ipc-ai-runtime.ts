/**
 * AI IPC — SDK-backed RUNTIME handlers. Registered on-demand by
 * `maybeRegisterAiRuntimeHandlers` (in ipc-ai-core.ts) once the AI component
 * is detected. Covers the streaming chat path + inline edit:
 *
 *  - `ai:query` (streaming, pushes `ai:chunk`)
 *  - `ai:cancel` / `ai:prewarm` / `ai:resolveApproval`
 *  - `ai:generateTitle` / `ai:inlineEdit`
 *
 * `ClaudeChatRuntime` pulls the SDK lazily via `loadClaudeSdk()` at first use,
 * so merely importing this module does not require the SDK to be resolvable
 * yet — but it is still dynamically imported so the code path is absent from
 * component-less installs.
 */
import { randomUUID } from 'crypto';
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';

import type {
  AiProviderId,
  AiQueryPayload,
  ApprovalDecision,
} from '../../shared/ai-types';
import type { AiProvider } from './provider';
import type { ApprovalCallback } from './providers/claude/approvalHandler';
import { ClaudeChatRuntime } from './providers/claude/ClaudeChatRuntime';
import { HttpChatProvider } from './providers/http/HttpChatProvider';
import { generateTitle } from './titleGen';
import { generateInlineEdit } from './inlineEdit';

/** Pending approval requests, keyed by reqId; resolved by `ai:resolveApproval`. */
const pendingApprovals = new Map<
  string,
  (decision: ApprovalDecision) => void
>();

/** Tools the user marked "allow-always" — skip the modal thereafter (process lifetime). */
const allowAlwaysTools = new Set<string>();

// Lazy singletons — instantiated on first real use, NOT at module load. This
// keeps `ai:cancel` cheap when no turn has run yet (null-guarded below).
let claudeRuntime: ClaudeChatRuntime | null = null;
let httpProvider: HttpChatProvider | null = null;

function getClaudeRuntime(): ClaudeChatRuntime {
  if (!claudeRuntime) claudeRuntime = new ClaudeChatRuntime();
  return claudeRuntime;
}

function providerFor(id: AiProviderId): AiProvider {
  if (id === 'ollama' || id === 'openai') {
    if (!httpProvider) httpProvider = new HttpChatProvider();
    return httpProvider;
  }
  return getClaudeRuntime();
}

function pushChunk(
  event: IpcMainInvokeEvent,
  conversationId: string,
  chunk: unknown
): void {
  event.sender.send('ai:chunk', { conversationId, chunk });
}

/**
 * Build a per-turn approval callback bound to the webContents that started the
 * query. Each tool call that survives the read-only guard pushes
 * `ai:approvalRequest` (with a fresh reqId) and awaits the matching
 * `ai:resolveApproval`. The promise rejects cleanly if the renderer goes away
 * (destroyed handler) — the SDK then sees a denied tool.
 */
function makeApprovalCallback(
  sender: WebContents,
  conversationId: string
): ApprovalCallback {
  return async (toolName, input, description) => {
    if (allowAlwaysTools.has(toolName)) return 'allow';
    const reqId = randomUUID();
    return new Promise<ApprovalDecision>((resolve) => {
      pendingApprovals.set(reqId, (decision) => {
        if (decision === 'allow-always') {
          allowAlwaysTools.add(toolName);
          resolve('allow');
        } else {
          resolve(decision);
        }
      });
      try {
        sender.send('ai:approvalRequest', {
          reqId,
          conversationId,
          toolName,
          input,
          description,
        });
      } catch {
        // Sender gone — auto-deny so the turn doesn't hang.
        pendingApprovals.delete(reqId);
        resolve('deny');
      }
    });
  };
}

/**
 * Run a turn in the background, streaming chunks to the sender. Returns
 * immediately; the renderer follows progress via the `ai:chunk` subscription.
 */
function streamTurn(event: IpcMainInvokeEvent, payload: AiQueryPayload): void {
  const approvalCallback = makeApprovalCallback(event.sender, payload.conversationId);
  const provider = providerFor(payload.settings.provider);
  void (async () => {
    try {
      for await (const chunk of provider.runTurn(payload, approvalCallback)) {
        pushChunk(event, payload.conversationId, chunk);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      event.sender.send('ai:error', {
        conversationId: payload.conversationId,
        message,
      });
    }
  })();
}

export function registerAiRuntimeHandlers(): void {
  ipcMain.handle('ai:query', async (event, payload: AiQueryPayload) => {
    streamTurn(event, payload);
    return { ok: true };
  });

  ipcMain.handle('ai:cancel', (_event, conversationId: string) => {
    // Fan out — only the active provider has this conversation in flight.
    // Null-guarded: a cancel before any turn ran is a harmless no-op.
    claudeRuntime?.cancel(conversationId);
    httpProvider?.cancel(conversationId);
    return { ok: true };
  });

  // Pre-warm the Claude CLI subprocess (panel-open / conversation-switch) so
  // the first turn isn't cold. Ignored for non-Claude providers.
  ipcMain.handle('ai:prewarm', (event, payload: AiQueryPayload) => {
    if (payload.settings.provider === 'claude-cli') {
      const approvalCallback = makeApprovalCallback(
        event.sender,
        payload.conversationId
      );
      getClaudeRuntime().prewarm(payload, approvalCallback);
    }
    return { ok: true };
  });

  ipcMain.handle(
    'ai:resolveApproval',
    (_event, args: { reqId: string; decision: ApprovalDecision }) => {
      const resolver = pendingApprovals.get(args.reqId);
      if (resolver) {
        pendingApprovals.delete(args.reqId);
        resolver(args.decision);
      }
      return { ok: true };
    }
  );

  // Auto conversation title (HTTP providers; Claude CLI returns '' in main).
  ipcMain.handle(
    'ai:generateTitle',
    async (
      _event,
      args: {
        settings: AiQueryPayload['settings'];
        history: AiQueryPayload['history'];
      }
    ) => ({ title: await generateTitle(args) })
  );

  // Inline edit: rewrite an editor selection per an instruction (HTTP only).
  ipcMain.handle(
    'ai:inlineEdit',
    async (
      _event,
      args: {
        settings: AiQueryPayload['settings'];
        selection: string;
        instruction: string;
      }
    ) => ({ replacement: await generateInlineEdit(args) })
  );
}
