import { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { ipcApi } from '-/services/ipc-api';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import type { RootState } from '-/reducers';
import {
  newConversation,
  setConversationMessages,
  setConversationMeta,
} from '-/reducers/ai';
import type {
  AiQueryPayload,
  AiSettingsSnapshot,
  ChatMessage,
  Conversation,
  ImageAttachment,
  StreamChunk,
  UsageInfo,
} from '../../../shared/ai-types';
import type { ViewMode } from '../../../shared/whale-meta';
import { applyChunk } from './streamAccumulator';

/**
 * Phase-B.7 chat hook bound to the redux `ai` slice (multi-tab + persisted
 * history). Messages live on the active `Conversation`; chunks route by the
 * envelope's conversationId so they land correctly even if the user switched
 * tabs mid-stream.
 */
export interface AiStreamState {
  activeId: string | null;
  messages: ChatMessage[];
  /** True while any conversation is streaming (the CLI is serial). */
  streaming: boolean;
  error: string | null;
  /** Dismiss the current error banner (user clicked the Alert's close). */
  clearError: () => void;
  usage: UsageInfo | null;
  send: (
    text: string,
    attachment?: { path: string; content?: string } | null,
    perspective?: PerspectiveState,
    selectedPaths?: string[],
    images?: ImageAttachment[]
  ) => Promise<void>;
  cancel: () => void;
}

/**
 * Effective perspective of the folder the user is viewing, attached to each
 * turn so the main process can inject a Perspectives section into the system
 * prompt. `viewMode` undefined → prompt omits that section (legacy/graceful).
 */
export interface PerspectiveState {
  viewMode?: ViewMode;
  subview?: 'kanban' | 'matrix' | 'gantt';
  viewDepth?: number;
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  }
}

function buildSnapshot(s: RootState['settings']): AiSettingsSnapshot {
  return {
    provider: s.aiProvider,
    model: s.aiModel,
    permissionMode: s.aiPermissionMode,
    effort: s.aiEffort,
    safeMode: s.aiSafeMode,
    customSystemPrompt: s.aiCustomSystemPrompt,
    envVarOverrides: s.aiEnvVarOverrides,
    cliPath: s.aiCliPath,
    loadUserSettings: s.aiLoadUserSettings,
    ollamaUrl: s.aiOllamaUrl,
    openaiUrl: s.aiOpenaiUrl,
    anthropicBaseUrl: s.aiAnthropicBaseUrl,
    anthropicAuthMode: s.aiAnthropicAuthMode,
    mcpServers: s.aiMcpServers,
    aiHttpTools: s.aiHttpTools,
  };
}

export function useAiStream(): AiStreamState {
  const dispatch = useDispatch();
  const settings = useSelector((s: RootState) => s.settings);
  const locations = useSelector((s: RootState) => s.locations.items);
  const conversations = useSelector((s: RootState) => s.ai.conversations);
  const activeId = useSelector((s: RootState) => s.ai.activeId);
  const { currentLocation } = useCurrentLocationContext();

  // Latest-conversations ref so the streaming subscription reads current
  // messages without a stale closure.
  const convsRef = useRef<Record<string, Conversation>>(conversations);
  useEffect(() => {
    convsRef.current = conversations;
  }, [conversations]);

  // Latest-settings ref for the title-gen trigger (which fires from the
  // streaming subscription and must not close over a stale provider).
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const [streamingConvId, setStreamingConvId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active = activeId ? conversations[activeId] : undefined;
  const messages = active?.messages ?? [];
  const usage = (active?.usage as UsageInfo | undefined) ?? null;

  /**
   * After a turn completes, generate an AI title for the conversation once
   * (HTTP providers only — Claude CLI is skipped server-side to avoid a CLI
   * spawn for a title). Idempotent via `titleGenerationStatus`.
   */
  const maybeGenerateTitle = useCallback(
    (conversationId: string) => {
      const conv = convsRef.current[conversationId];
      if (!conv) return;
      if (settingsRef.current.aiProvider === 'claude-cli') return;
      if (
        conv.titleGenerationStatus === 'pending' ||
        conv.titleGenerationStatus === 'success'
      ) {
        return;
      }
      const hasAssistant = conv.messages.some(
        (m) =>
          m.role === 'assistant' &&
          (!!m.content || (m.contentBlocks?.length ?? 0) > 0)
      );
      if (!hasAssistant) return;
      dispatch(
        setConversationMeta(conversationId, { titleGenerationStatus: 'pending' })
      );
      void ipcApi
        .aiGenerateTitle({
          settings: buildSnapshot(settingsRef.current),
          history: conv.messages,
        })
        .then(({ title }) => {
          dispatch(
            setConversationMeta(conversationId, {
              title,
              titleGenerationStatus: title ? 'success' : 'failed',
            })
          );
        })
        .catch(() => {
          dispatch(
            setConversationMeta(conversationId, { titleGenerationStatus: 'failed' })
          );
        });
    },
    [dispatch]
  );

  // Pre-warm the Claude CLI subprocess when the active conversation / location
  // / model is established, so the first turn isn't cold. Best-effort + no-op
  // for HTTP providers (the main process ignores it).
  useEffect(() => {
    if (settings.aiProvider !== 'claude-cli' || !currentLocation || !activeId) {
      return;
    }
    const payload: AiQueryPayload = {
      conversationId: activeId,
      cwd: currentLocation.path,
      locationRoots: locations.map((l) => ({
        path: l.path,
        readOnly: l.isReadOnly,
      })),
      turn: { text: '' },
      settings: buildSnapshot(settings),
      sessionId: active?.sessionId ?? null,
      history: [],
    };
    void ipcApi.aiPrewarm(payload).catch(() => undefined);
  }, [
    activeId,
    active?.sessionId,
    currentLocation,
    locations,
    settings,
  ]);

  useEffect(() => {
    const offChunk = ipcApi.onAiChunk(({ conversationId, chunk }) => {
      const c = chunk as StreamChunk;
      if (c.type === 'usage') {
        if (c.sessionId) {
          dispatch(
            setConversationMeta(conversationId, {
              sessionId: c.sessionId,
              usage: c.usage,
            })
          );
        }
        return;
      }
      if (c.type === 'done') {
        setStreamingConvId((cur) => (cur === conversationId ? null : cur));
        maybeGenerateTitle(conversationId);
        return;
      }
      if (c.type === 'error') {
        setError(c.content);
        setStreamingConvId((cur) => (cur === conversationId ? null : cur));
        return;
      }
      const cur = convsRef.current[conversationId]?.messages ?? [];
      dispatch(setConversationMessages(conversationId, applyChunk(cur, c)));
    });
    const offError = ipcApi.onAiError(({ conversationId, message }) => {
      setError(message);
      setStreamingConvId((cur) => (cur === conversationId ? null : cur));
    });
    return () => {
      offChunk();
      offError();
    };
  }, [dispatch, maybeGenerateTitle]);

  const send = useCallback(
    async (
      text: string,
      attachment?: { path: string; content?: string } | null,
      perspective?: PerspectiveState,
      selectedPaths?: string[],
      images?: ImageAttachment[]
    ) => {
      if (!text.trim() || !currentLocation || streamingConvId) return;
      // Ensure there's an active conversation.
      let id = activeId;
      if (!id || !conversations[id]) {
        id = newId();
        dispatch(newConversation(id));
      }
      setError(null);
      // Capture prior messages BEFORE echoing — HTTP providers replay the full
      // history each turn (excluding the new user message).
      const prior = conversations[id]?.messages ?? [];
      const userMsg: ChatMessage = {
        id: newId(),
        role: 'user',
        content: text,
        timestamp: Date.now(),
        currentNote: attachment?.path,
        ...(images && images.length > 0 ? { images } : {}),
      };
      dispatch(setConversationMessages(id, [...prior, userMsg]));

      setStreamingConvId(id);
      const payload: AiQueryPayload = {
        conversationId: id,
        cwd: currentLocation.path,
        locationRoots: locations.map((l) => ({ path: l.path, readOnly: l.isReadOnly })),
        turn: {
          text,
          currentNotePath: attachment?.path,
          editorSelection:
            attachment?.path && attachment.content
              ? { path: attachment.path, text: attachment.content }
              : null,
          viewMode: perspective?.viewMode,
          subview: perspective?.subview,
          viewDepth: perspective?.viewDepth,
          selectedPaths: selectedPaths && selectedPaths.length > 0 ? selectedPaths : undefined,
          images: images && images.length > 0 ? images : undefined,
        },
        settings: buildSnapshot(settings),
        sessionId: conversations[id]?.sessionId ?? null,
        history: prior,
      };
      try {
        await ipcApi.aiQuery(payload);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStreamingConvId(null);
      }
    },
    [activeId, conversations, currentLocation, dispatch, locations, settings, streamingConvId]
  );

  const cancel = useCallback(() => {
    if (!streamingConvId) return;
    ipcApi.aiCancel(streamingConvId).catch(() => undefined);
    setStreamingConvId(null);
  }, [streamingConvId]);

  const clearError = useCallback(() => setError(null), []);

  return {
    activeId,
    messages,
    streaming: streamingConvId !== null,
    error,
    clearError,
    usage,
    send,
    cancel,
  };
}
