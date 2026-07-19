import type { AnyAction } from 'redux';

/**
 * AI domain of the settings slice: provider / runtime / panel config. Split
 * out of the old god-slice `settings.ts` (docs/01 §12) — verbatim fields /
 * action / migrations / reducer case.
 *
 * All AI settings here are NON-SECRET (persisted via redux-persist). Secrets
 * (`ANTHROPIC_API_KEY`, OpenAI key) live encrypted in the main process via
 * Electron `safeStorage` (see `src/main/ai/security/`).
 */
export interface AiFields {
  aiProvider: 'claude-cli' | 'ollama' | 'openai';
  /** Ollama base URL (provider='ollama'). */
  aiOllamaUrl: string;
  /** OpenAI-compatible base URL (provider='openai'). */
  aiOpenaiUrl: string;
  /** Anthropic base URL for the Claude Code CLI (env ANTHROPIC_BASE_URL).
   *  Empty = official api.anthropic.com; set this for relay/proxy providers. */
  aiAnthropicBaseUrl: string;
  /** Which env var the stored API key is written to. 'authToken'
   *  (ANTHROPIC_AUTH_TOKEN, Bearer) is what most relay/proxy providers expect
   *  (cc-switch defaults to it); 'apiKey' (ANTHROPIC_API_KEY, x-api-key) is the
   *  official Anthropic auth. */
  aiAnthropicAuthMode: 'apiKey' | 'authToken';
  aiEnabled: boolean;
  aiPanelOpen: boolean;
  aiPanelWidth: number;
  aiModel: string;
  aiPermissionMode: 'yolo' | 'plan' | 'normal';
  aiEffort: 'low' | 'medium' | 'high';
  aiSafeMode: 'auto' | 'acceptEdits';
  aiCustomSystemPrompt: string;
  /** Multiline `KEY=value` block (non-secret env overrides for the CLI). */
  aiEnvVarOverrides: string;
  /** Explicit Claude Code CLI path override; null = auto-discover. */
  aiCliPath: string | null;
  /** Whether to load the user's `~/.claude/settings.json` into the CLI. */
  aiLoadUserSettings: boolean;
  /** Configured MCP servers (Claude CLI provider). See `shared/ai-types`. */
  aiMcpServers: import('../../../shared/ai-types').ManagedMcpServer[];
  /** Advertise Whale-defined tools to HTTP providers (read/list/write). */
  aiHttpTools: boolean;
}

export const aiInitial: AiFields = {
  aiProvider: 'claude-cli',
  aiOllamaUrl: 'http://localhost:11434',
  aiOpenaiUrl: 'https://api.openai.com/v1',
  aiAnthropicBaseUrl: '',
  aiAnthropicAuthMode: 'apiKey',
  aiEnabled: false,
  aiPanelOpen: false,
  aiPanelWidth: 380,
  aiModel: 'sonnet',
  aiPermissionMode: 'yolo',
  aiEffort: 'high',
  aiSafeMode: 'acceptEdits',
  aiCustomSystemPrompt: '',
  aiEnvVarOverrides: '',
  aiCliPath: null,
  aiLoadUserSettings: false,
  aiMcpServers: [],
  aiHttpTools: true,
};

/**
 * Partial update for the AI settings block. One action covers all `ai*` fields
 * (panel state + provider/runtime config) — they're never updated in ways that
 * need distinct reducer logic, so a single shallow-merge action keeps the file
 * from ballooning. The `ANTHROPIC_API_KEY` is intentionally absent (it lives
 * encrypted in the main process, not in redux).
 */
export const SET_AI_SETTINGS = 'settings/SET_AI_SETTINGS';

/** The subset of {@link AiFields} that the AI action may update. */
export type AiSettingsPatch = Pick<
  AiFields,
  | 'aiEnabled'
  | 'aiPanelOpen'
  | 'aiPanelWidth'
  | 'aiModel'
  | 'aiPermissionMode'
  | 'aiEffort'
  | 'aiSafeMode'
  | 'aiCustomSystemPrompt'
  | 'aiEnvVarOverrides'
  | 'aiCliPath'
  | 'aiLoadUserSettings'
  | 'aiProvider'
  | 'aiOllamaUrl'
  | 'aiOpenaiUrl'
  | 'aiAnthropicBaseUrl'
  | 'aiAnthropicAuthMode'
  | 'aiMcpServers'
  | 'aiHttpTools'
>;

export interface SetAiSettingsAction extends AnyAction {
  type: typeof SET_AI_SETTINGS;
  payload: Partial<AiSettingsPatch>;
}

/** Update one or more AI settings fields (shallow merge over the ai* block). */
export function setAiSettings(patch: Partial<AiSettingsPatch>): SetAiSettingsAction {
  return { type: SET_AI_SETTINGS, payload: patch };
}

// --- Migration (redux-persist backfill) --------------------------------------
export function migrateAi<T extends AiFields>(base: T): T {
  let next = base;
  // Phase 5 AI defaults — old persisted state predates the AI feature.
  if (next.aiProvider === undefined) next = { ...next, aiProvider: 'claude-cli' };
  if (next.aiOllamaUrl === undefined)
    next = { ...next, aiOllamaUrl: 'http://localhost:11434' };
  if (next.aiOpenaiUrl === undefined)
    next = { ...next, aiOpenaiUrl: 'https://api.openai.com/v1' };
  if (next.aiAnthropicBaseUrl === undefined)
    next = { ...next, aiAnthropicBaseUrl: '' };
  if (next.aiAnthropicAuthMode === undefined)
    next = { ...next, aiAnthropicAuthMode: 'apiKey' };
  if (next.aiEnabled === undefined) next = { ...next, aiEnabled: false };
  if (next.aiPanelOpen === undefined) next = { ...next, aiPanelOpen: false };
  // Slightly narrower default (was 420); migrate the old default to the new
  // one. Custom values (anything other than the old default) are preserved.
  if (next.aiPanelWidth === undefined || next.aiPanelWidth === 420) {
    next = { ...next, aiPanelWidth: 380 };
  }
  if (next.aiModel === undefined) next = { ...next, aiModel: 'sonnet' };
  // 'normal' has a deadlock: claude.exe blocks high-risk Bash (curl / python -c
  // / redirections) at the schema level, and Whale's canUseTool can't override
  // it (allowDangerouslySkipPermissions can't be on in non-yolo or it shadows
  // canUseTool entirely). Migrate undefined + 'normal' → 'yolo' so existing
  // users land on the working autonomous mode; 'plan' (read-only planning) is
  // preserved as a deliberate choice.
  if (next.aiPermissionMode === undefined || next.aiPermissionMode === 'normal') {
    next = { ...next, aiPermissionMode: 'yolo' };
  }
  if (next.aiEffort === undefined) next = { ...next, aiEffort: 'high' };
  if (next.aiSafeMode === undefined) next = { ...next, aiSafeMode: 'acceptEdits' };
  if (next.aiCustomSystemPrompt === undefined)
    next = { ...next, aiCustomSystemPrompt: '' };
  if (next.aiEnvVarOverrides === undefined)
    next = { ...next, aiEnvVarOverrides: '' };
  if (next.aiCliPath === undefined) next = { ...next, aiCliPath: null };
  if (next.aiLoadUserSettings === undefined)
    next = { ...next, aiLoadUserSettings: false };
  if (next.aiMcpServers === undefined) next = { ...next, aiMcpServers: [] };
  if (next.aiHttpTools === undefined) next = { ...next, aiHttpTools: true };
  return next;
}

// --- Reducer (this domain's cases only) --------------------------------------
export function reduceAi<T extends AiFields>(state: T, action: AnyAction): T {
  switch (action.type) {
    case SET_AI_SETTINGS:
      return { ...state, ...action.payload };
    default:
      return state;
  }
}
