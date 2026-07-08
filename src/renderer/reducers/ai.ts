import type { AnyAction } from 'redux';
import type { ChatMessage, Conversation, StreamChunk } from '../../shared/ai-types';

/**
 * AI conversation state — multi-tab + persisted history.
 *
 * Persisted wholesale via redux-persist (see `store/configureStore.ts`
 * whitelist). localStorage size is bounded by the conversation-count cap
 * ({@link MAX_CONVERSATIONS}); message bodies within a conversation are not
 * trimmed (the CLI's native session holds the full memory; trimming our local
 * mirror would diverge from what the model remembers).
 */
export const MAX_CONVERSATIONS = 50;
const TITLE_MAX = 40;
export const DEFAULT_CONVERSATION_TITLE = '';

export interface AiState {
  /** All known conversations (open + history), keyed by id. */
  conversations: Record<string, Conversation>;
  /** Open tab order (ids). History conversations need not be open. */
  openTabs: string[];
  /** The currently visible conversation id, or null. */
  activeId: string | null;
}

export const initialState: AiState = {
  conversations: {},
  openTabs: [],
  activeId: null,
};

export const AI_NEW_CONVERSATION = 'ai/NEW_CONVERSATION';
export const AI_OPEN_CONVERSATION = 'ai/OPEN_CONVERSATION';
export const AI_CLOSE_TAB = 'ai/CLOSE_TAB';
export const AI_SET_ACTIVE = 'ai/SET_ACTIVE';
export const AI_SET_MESSAGES = 'ai/SET_MESSAGES';
export const AI_SET_META = 'ai/SET_META';
export const AI_RENAME = 'ai/RENAME';
export const AI_DELETE = 'ai/DELETE';
export const AI_REWIND = 'ai/REWIND';

export interface AiNewConversationAction extends AnyAction {
  type: typeof AI_NEW_CONVERSATION;
  payload: { id: string; createdAt: number };
}
export interface AiOpenConversationAction extends AnyAction {
  type: typeof AI_OPEN_CONVERSATION;
  payload: { id: string };
}
export interface AiCloseTabAction extends AnyAction {
  type: typeof AI_CLOSE_TAB;
  payload: { id: string };
}
export interface AiSetActiveAction extends AnyAction {
  type: typeof AI_SET_ACTIVE;
  payload: { id: string };
}
export interface AiSetMessagesAction extends AnyAction {
  type: typeof AI_SET_MESSAGES;
  payload: { id: string; messages: ChatMessage[] };
}
export interface AiSetMetaAction extends AnyAction {
  type: typeof AI_SET_META;
  payload: { id: string; patch: Partial<Conversation> };
}
export interface AiRenameAction extends AnyAction {
  type: typeof AI_RENAME;
  payload: { id: string; title: string };
}
export interface AiDeleteAction extends AnyAction {
  type: typeof AI_DELETE;
  payload: { id: string };
}
export interface AiRewindAction extends AnyAction {
  type: typeof AI_REWIND;
  payload: { id: string; fromMessageId: string };
}

/** Derive a title from the first user message (first TITLE_MAX chars). */
function titleFromMessages(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return DEFAULT_CONVERSATION_TITLE;
  const text = (first.displayContent || first.content || '').replace(/\s+/g, ' ').trim();
  return text ? (text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text) : DEFAULT_CONVERSATION_TITLE;
}

function newNeighbor(openTabs: string[], removedId: string): string | null {
  const idx = openTabs.indexOf(removedId);
  if (idx === -1) return openTabs[openTabs.length - 1] ?? null;
  return openTabs[idx + 1] ?? openTabs[idx - 1] ?? null;
}

/** Drop the oldest CLOSED conversation when at the cap. */
function enforceCap(state: AiState): AiState {
  const ids = Object.keys(state.conversations);
  if (ids.length <= MAX_CONVERSATIONS) return state;
  const open = new Set(state.openTabs);
  const closable = ids
    .filter((id) => !open.has(id))
    .map((id) => ({ id, updatedAt: state.conversations[id].updatedAt }))
    .sort((a, b) => a.updatedAt - b.updatedAt);
  if (closable.length === 0) return state;
  const dropId = closable[0].id;
  const conversations = { ...state.conversations };
  delete conversations[dropId];
  return { ...state, conversations };
}

export function newConversation(id: string): AiNewConversationAction {
  return { type: AI_NEW_CONVERSATION, payload: { id, createdAt: Date.now() } };
}
export function openConversation(id: string): AiOpenConversationAction {
  return { type: AI_OPEN_CONVERSATION, payload: { id } };
}
export function closeTab(id: string): AiCloseTabAction {
  return { type: AI_CLOSE_TAB, payload: { id } };
}
export function setActiveConversation(id: string): AiSetActiveAction {
  return { type: AI_SET_ACTIVE, payload: { id } };
}
export function setConversationMessages(
  id: string,
  messages: ChatMessage[]
): AiSetMessagesAction {
  return { type: AI_SET_MESSAGES, payload: { id, messages } };
}
export function setConversationMeta(
  id: string,
  patch: Partial<Conversation>
): AiSetMetaAction {
  return { type: AI_SET_META, payload: { id, patch } };
}
export function renameConversation(id: string, title: string): AiRenameAction {
  return { type: AI_RENAME, payload: { id, title } };
}
export function deleteConversation(id: string): AiDeleteAction {
  return { type: AI_DELETE, payload: { id } };
}
/**
 * Rewind the conversation: drop the message `fromMessageId` and everything
 * after it, and clear the provider session id (so the next turn starts fresh
 * rather than resuming a session that still holds the truncated-away turns).
 */
export function rewindConversation(
  id: string,
  fromMessageId: string
): AiRewindAction {
  return { type: AI_REWIND, payload: { id, fromMessageId } };
}

// `StreamChunk` is re-exported so callers typing chunk payloads share one type.
export type { StreamChunk };

export default function aiReducer(
  state = initialState,
  action:
    | AiNewConversationAction
    | AiOpenConversationAction
    | AiCloseTabAction
    | AiSetActiveAction
    | AiSetMessagesAction
    | AiSetMetaAction
    | AiRenameAction
    | AiDeleteAction
    | AiRewindAction
    | AnyAction
): AiState {
  switch (action.type) {
    case AI_NEW_CONVERSATION: {
      const { id, createdAt } = (action as AiNewConversationAction).payload;
      if (state.conversations[id]) {
        // Already exists — just surface it as a tab.
        const openTabs = state.openTabs.includes(id)
          ? state.openTabs
          : [id, ...state.openTabs];
        return { ...state, openTabs, activeId: id };
      }
      const conv: Conversation = {
        id,
        providerId: 'claude',
        title: DEFAULT_CONVERSATION_TITLE,
        createdAt,
        updatedAt: createdAt,
        sessionId: null,
        messages: [],
      };
      const next: AiState = {
        ...state,
        conversations: { ...state.conversations, [id]: conv },
        openTabs: [id, ...state.openTabs],
        activeId: id,
      };
      return enforceCap(next);
    }
    case AI_OPEN_CONVERSATION: {
      const { id } = (action as AiOpenConversationAction).payload;
      if (!state.conversations[id]) return state;
      const openTabs = state.openTabs.includes(id)
        ? state.openTabs
        : [id, ...state.openTabs];
      return { ...state, openTabs, activeId: id };
    }
    case AI_CLOSE_TAB: {
      const { id } = (action as AiCloseTabAction).payload;
      const openTabs = state.openTabs.filter((t) => t !== id);
      const activeId =
        state.activeId === id ? newNeighbor(state.openTabs, id) : state.activeId;
      return { ...state, openTabs, activeId };
    }
    case AI_SET_ACTIVE: {
      const { id } = (action as AiSetActiveAction).payload;
      return state.conversations[id] ? { ...state, activeId: id } : state;
    }
    case AI_SET_MESSAGES: {
      const { id, messages } = (action as AiSetMessagesAction).payload;
      const conv = state.conversations[id];
      if (!conv) return state;
      const title =
        conv.title && conv.title !== DEFAULT_CONVERSATION_TITLE
          ? conv.title
          : titleFromMessages(messages);
      return {
        ...state,
        conversations: {
          ...state.conversations,
          [id]: { ...conv, messages, title, updatedAt: Date.now() },
        },
      };
    }
    case AI_SET_META: {
      const { id, patch } = (action as AiSetMetaAction).payload;
      const conv = state.conversations[id];
      if (!conv) return state;
      return {
        ...state,
        conversations: {
          ...state.conversations,
          [id]: { ...conv, ...patch, updatedAt: Date.now() },
        },
      };
    }
    case AI_RENAME: {
      const { id, title } = (action as AiRenameAction).payload;
      const conv = state.conversations[id];
      if (!conv) return state;
      return {
        ...state,
        conversations: { ...state.conversations, [id]: { ...conv, title } },
      };
    }
    case AI_DELETE: {
      const { id } = (action as AiDeleteAction).payload;
      if (!state.conversations[id]) return state;
      const conversations = { ...state.conversations };
      delete conversations[id];
      const openTabs = state.openTabs.filter((t) => t !== id);
      const activeId =
        state.activeId === id ? newNeighbor(state.openTabs, id) : state.activeId;
      return { ...state, conversations, openTabs, activeId };
    }
    case AI_REWIND: {
      const { id, fromMessageId } = (action as AiRewindAction).payload;
      const conv = state.conversations[id];
      if (!conv) return state;
      const idx = conv.messages.findIndex((m) => m.id === fromMessageId);
      if (idx <= 0) return state; // nothing before the message to keep
      return {
        ...state,
        conversations: {
          ...state.conversations,
          [id]: {
            ...conv,
            messages: conv.messages.slice(0, idx),
            // Clear the session id: a resumed session would replay the
            // truncated-away turns. HTTP has no session and just sends the
            // shorter history next turn.
            sessionId: null,
            updatedAt: Date.now(),
          },
        },
      };
    }
    default:
      return state;
  }
}
