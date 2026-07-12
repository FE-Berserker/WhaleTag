/**
 * AI assistant — portable type contract shared between the main process and
 * the renderer (via preload). No Node-only or DOM-only imports here: this file
 * is imported by both `src/main/ai/*` and `src/renderer/*`.
 *
 * The design mirrors Claudian's provider-neutral boundary: a provider runtime
 * emits a normalized `StreamChunk` stream, the renderer accumulates chunks into
 * `ChatMessage`s with ordered `ContentBlock`s. Whale's first (and currently
 * only) provider is the Claude Code CLI (embedded via
 * `@anthropic-ai/claude-agent-sdk` in the main process); the abstraction leaves
 * room for future Ollama / OpenAI-compatible HTTP providers.
 */

/** Provider identifier (open-ended so future providers need no union change). */
export type ProviderId = string;

/** Supported image media types for attachments. */
export type ImageMediaType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp';

/** Image attachment metadata. `data` is base64 (single source of truth). */
export interface ImageAttachment {
  id: string;
  name: string;
  mediaType: ImageMediaType;
  data: string;
  width?: number;
  height?: number;
  size: number;
  source: 'file' | 'paste' | 'drop';
}

/**
 * Ordered content block preserved while streaming so a message can be replayed
 * in the right sequence (text, then a tool call, then more text, …). The
 * `toolId` in a `tool_use` block references an entry in
 * {@link ChatMessage.toolCalls}.
 */
export type ContentBlock =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; toolId: string }
  | { type: 'thinking'; content: string; durationSeconds?: number }
  | { type: 'context_compacted' };

/** Tool call tracking with status and result. */
export interface ToolCallInfo {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: 'running' | 'completed' | 'error' | 'blocked';
  result?: string;
  isExpanded?: boolean;
  /**
   * Present when this tool call spawned a subagent (e.g. the Task/Agent tool).
   * Nested tool calls + streamed output from the subagent are collected here,
   * keyed by the parent tool-use id (the SDK's `parent_tool_use_id`).
   */
  subagent?: SubagentInfo;
}

/** A subagent run, nested under its spawning tool call. */
export interface SubagentInfo {
  /** The parent tool-use id (= SDK `parent_tool_use_id` on nested messages). */
  id: string;
  description?: string;
  status: 'running' | 'completed' | 'error';
  /** Streamed text output from the subagent. */
  output?: string;
  /** Tool calls made BY the subagent. */
  toolCalls: ToolCallInfo[];
}

/** A single chat message (user or assistant). */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Display-only content (e.g. a slash command shown verbatim). */
  displayContent?: string;
  timestamp: number;
  toolCalls?: ToolCallInfo[];
  contentBlocks?: ContentBlock[];
  currentNote?: string;
  images?: ImageAttachment[];
  /** Seconds from user send to response completion. */
  durationSeconds?: number;
}

/** Context-window usage reported at the end of a turn. */
export interface UsageInfo {
  model?: string;
  inputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /** Total context-window size in tokens for the active model. */
  contextWindow: number;
  contextWindowIsAuthoritative?: boolean;
  /** Tokens currently in the context window (what the gauge shows). */
  contextTokens: number;
  /** 0–100 share of the context window in use. */
  percentage: number;
}

/** A persisted conversation. */
export interface Conversation {
  id: string;
  providerId: ProviderId;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastResponseAt?: number;
  /** Provider-native session id (Claude Code session) used for resume. */
  sessionId: string | null;
  messages: ChatMessage[];
  currentNote?: string;
  externalContextPaths?: string[];
  usage?: UsageInfo;
  /** Auto-title status so we generate at most once per conversation. */
  titleGenerationStatus?: 'pending' | 'success' | 'failed';
}

/** Lightweight conversation metadata for the history list. */
export interface ConversationMeta {
  id: string;
  providerId: ProviderId;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastResponseAt?: number;
  messageCount: number;
  preview: string;
}

/**
 * Normalized stream chunk emitted by the active provider runtime. Every
 * provider must emit at least: `text`, `tool_use`, `tool_result`, `error`,
 * `done`, `usage`. Provider-specific wire formats are normalized to this
 * contract before crossing the IPC boundary into the renderer.
 */
export type StreamChunk =
  | { type: 'user_message_start'; content: string; itemId?: string }
  | { type: 'assistant_message_start'; itemId?: string }
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      id: string;
      content: string;
      isError?: boolean;
    }
  | { type: 'tool_output'; id: string; content: string }
  | {
      type: 'subagent_text';
      /** Parent tool-use id that spawned the subagent. */
      subagentId: string;
      content: string;
    }
  | {
      type: 'subagent_tool_use';
      subagentId: string;
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'subagent_tool_result';
      subagentId: string;
      id: string;
      content: string;
      isError?: boolean;
    }
  | { type: 'error'; content: string }
  | { type: 'notice'; content: string; level?: 'info' | 'warning' }
  | { type: 'done' }
  | { type: 'usage'; usage: UsageInfo; sessionId?: string | null }
  | { type: 'context_compacted' };

/** User's approval decision for a tool call that needs confirmation. */
export type ApprovalDecision =
  | 'allow'
  | 'allow-always'
  | 'deny'
  | 'cancel';

/**
 * A request pushed to the renderer asking the user to approve a tool call.
 * The renderer resolves it via `ai:resolveApproval` keyed by `reqId`.
 */
export interface AiApprovalRequest {
  reqId: string;
  conversationId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Human-readable summary of what the tool will do. */
  description: string;
}

/** A turn to send to the model. */
export interface ChatTurnRequest {
  text: string;
  images?: ImageAttachment[];
  /** Absolute path of the "current" file attached as context. */
  currentNotePath?: string;
  /** Optional text-selection context for the current file. */
  editorSelection?: { path: string; text: string } | null;
  /** Effective perspective of the folder the user is currently looking at.
   *  Injected into the system prompt so the agent can anchor advice to the
   *  active view (e.g. Gantt → suggest `period:` tags). `undefined` when the
   *  folder's viewMode is unrecognized / legacy-migrated — the prompt then
   *  omits the Perspectives section entirely (graceful). */
  viewMode?: import('./whale-meta').ViewMode;
  /** Active Task sub-view (only meaningful when `viewMode === 'task'`). */
  subview?: 'kanban' | 'matrix' | 'gantt';
  /** Global recursive depth the user set on the perspective toolbar (1–5). */
  viewDepth?: number;
  /** Non-single selections: the full list of selected file PATHS when the user
   *  has 2+ files (or a folder + files) selected. Empty/omitted for single
   *  file selection (that goes through `currentNotePath`) and no selection.
   *  Paths only — never contents — so a multi-select doesn't blow up the token
   *  budget; the agent can `read_file` / `list_tags` / `apply_tag` per path as
   *  it sees fit. */
  selectedPaths?: string[];
  /** Extra directories the agent may access beyond the cwd. */
  externalContextPaths?: string[];
}

/** Which backend runs the model. */
export type AiProviderId = 'claude-cli' | 'ollama' | 'openai';

/**
 * MCP (Model Context Protocol) server config. Mirrors the standard MCP /
 * Claude Code config shape; the main process passes enabled servers to the
 * SDK's `options.mcpServers` (the SDK spawns stdio servers itself).
 *
 * NOTE: stdio `env` may carry secrets (API keys). They are persisted in
 * redux-persist (localStorage) as plaintext, like most MCP clients' config
 * files — don't put secrets here you wouldn't put in a config file on disk.
 */
export type McpServerConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string }
  | { type: 'http'; url: string };

/** A configured MCP server with Whale-side UI metadata. */
export interface ManagedMcpServer {
  name: string;
  config: McpServerConfig;
  enabled: boolean;
}

/** Snapshot of the AI settings passed with each turn (single source = redux). */
export interface AiSettingsSnapshot {
  /** Active provider — selects the runtime in the main process. */
  provider: AiProviderId;
  model: string;
  permissionMode: 'yolo' | 'plan' | 'normal';
  effort: 'low' | 'medium' | 'high';
  safeMode: 'auto' | 'acceptEdits';
  customSystemPrompt: string;
  /** Non-secret environment overrides (KEY=value lines). */
  envVarOverrides: string;
  cliPath: string | null;
  loadUserSettings: boolean;
  /** Ollama base URL (provider='ollama'). Default http://localhost:11434. */
  ollamaUrl: string;
  /** OpenAI-compatible base URL (provider='openai'). Default https://api.openai.com/v1. */
  openaiUrl: string;
  /** Anthropic base URL for the Claude Code CLI (env ANTHROPIC_BASE_URL).
   *  Empty = official api.anthropic.com; set for relay/proxy providers. */
  anthropicBaseUrl: string;
  /** Which env var the stored API key is written to. 'authToken' = ANTHROPIC_AUTH_TOKEN
   *  (relay/proxy default), 'apiKey' = ANTHROPIC_API_KEY (official). */
  anthropicAuthMode: 'apiKey' | 'authToken';
  /** Configured MCP servers (Claude CLI provider only). */
  mcpServers: ManagedMcpServer[];
  /**
   * Advertise Whale-defined tools (read/list/write, confined to allowedRoots)
   * to HTTP providers so Ollama/OpenAI can operate on files — the original
   * roadmap's constrained-tool model. Writes are gated by the approval modal.
   */
  aiHttpTools: boolean;
}

/** Payload for `ai:query`. */
export interface AiQueryPayload {
  conversationId: string;
  /** Absolute path to use as the agent working directory (a location root). */
  cwd: string;
  /** All configured location roots, tagged read-only, for additionalDirectories. */
  locationRoots: Array<{ path: string; readOnly: boolean }>;
  turn: ChatTurnRequest;
  settings: AiSettingsSnapshot;
  /**
   * Persisted Claude Code session id for `resume` (multi-turn memory). Null on
   * the first turn of a conversation; the renderer captures it from the
   * `usage` chunk and stores it on the Conversation so resume survives restart.
   */
  sessionId: string | null;
  /**
   * Full conversation history (prior turns, NOT including the new user turn).
   * The Claude CLI provider ignores this (it resumes by `sessionId`); HTTP
   * providers are stateless and send the whole history each turn.
   */
  history: ChatMessage[];
}

// ---------------------------------------------------------------------------
// Optional AI component (user-installed `.whaleai` → <userData>/components/ai).
// The Claude Code CLI + Agent SDK are NOT shipped in the main installer; users
// install this component on demand. These types cross the main/preload/renderer
// boundary so the renderer can show install status and drive install/uninstall.
// ---------------------------------------------------------------------------

/** Snapshot of the installed AI component (or `{ installed: false }`). */
export interface AiComponentState {
  installed: boolean;
  version?: string;
  /** `@anthropic-ai/claude-code` version shipped in the component. */
  claudeCodeVersion?: string;
  /** `@anthropic-ai/claude-agent-sdk` version shipped in the component. */
  sdkVersion?: string;
  /** Absolute path to the installed component dir. */
  path?: string;
}

/** Result of installing the AI component from a `.whaleai` archive. */
export interface AiComponentInstallResult {
  ok: boolean;
  state?: AiComponentState;
  error?: string;
}

/** Result of uninstalling the AI component. */
export interface AiComponentUninstallResult {
  ok: boolean;
  error?: string;
}
