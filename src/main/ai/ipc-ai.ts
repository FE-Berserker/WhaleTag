/**
 * AI IPC handlers — the main-process half of the AI feature. Registered from
 * `main.ts` (alongside `registerIpcHandlers`). Mirrors the rest of Whale's
 * `ipcMain.handle` pattern, with ONE addition: streaming + approval both push
 * main→renderer.
 *
 * Whale had no main→renderer push channel before this feature; every call was
 * `ipcRenderer.invoke`. The AI stream uses `event.sender.send('ai:chunk', …)`
 * and approvals use `event.sender.send('ai:approvalRequest', …)` — both pushed
 * to the webContents that invoked `ai:query`. Channels are fixed `ai:*` names.
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
import { findClaudeCLIPath } from './providers/claude/cli/findClaudeCliPath';
import {
  SECRET_NAMES,
  clearApiKey,
  clearSecret,
  hasApiKey,
  hasSecret,
  setApiKey,
  setSecret,
} from './security/secretStore';
import { generateTitle } from './titleGen';
import { generateInlineEdit } from './inlineEdit';

/** Pending approval requests, keyed by reqId; resolved by `ai:resolveApproval`. */
const pendingApprovals = new Map<
  string,
  (decision: ApprovalDecision) => void
>();

// Both providers are cheap to keep around; the active one is picked per turn
// from `payload.settings.provider`. `cancel` fans out to both (the inactive is
// a no-op for that conversation id).
const claudeRuntime = new ClaudeChatRuntime();
const httpProvider = new HttpChatProvider();

function providerFor(id: AiProviderId): AiProvider {
  return id === 'ollama' || id === 'openai' ? httpProvider : claudeRuntime;
}

/** Push one chunk to the renderer that started this conversation. */
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
/** Tools the user marked "allow-always" — skip the modal thereafter (in-memory,
 *  for the process lifetime). Stops per-call prompts for repetitive tools. */
const allowAlwaysTools = new Set<string>();

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
 *
 * The provider is picked from `payload.settings.provider`. For the Claude CLI
 * provider, `payload.sessionId` drives multi-turn resume; HTTP providers are
 * stateless and replay `payload.history`.
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

export function registerAiHandlers(): void {
  ipcMain.handle('ai:query', async (event, payload: AiQueryPayload) => {
    streamTurn(event, payload);
    return { ok: true };
  });

  ipcMain.handle('ai:cancel', (_event, conversationId: string) => {
    // Fan out — only the active provider has this conversation in flight.
    claudeRuntime.cancel(conversationId);
    httpProvider.cancel(conversationId);
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
      claudeRuntime.prewarm(payload, approvalCallback);
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

  ipcMain.handle('ai:setApiKey', (_event, key: string) => {
    setApiKey(key);
    return { ok: true };
  });

  ipcMain.handle('ai:clearApiKey', () => {
    clearApiKey();
    return { ok: true };
  });

  ipcMain.handle('ai:hasApiKey', () => hasApiKey());

  // OpenAI-compatible provider key (stored encrypted alongside the Anthropic key).
  ipcMain.handle('ai:setOpenaiKey', (_event, key: string) => {
    setSecret(SECRET_NAMES.openai, key);
    return { ok: true };
  });
  ipcMain.handle('ai:clearOpenaiKey', () => {
    clearSecret(SECRET_NAMES.openai);
    return { ok: true };
  });
  ipcMain.handle('ai:hasOpenaiKey', () => hasSecret(SECRET_NAMES.openai));

  ipcMain.handle('ai:discoverCli', (_event, override: string | null) => ({
    path: findClaudeCLIPath(override || undefined),
  }));

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
