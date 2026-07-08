import type { AiSettingsSnapshot } from '../../../shared/ai-types';
import type { SettingsState } from '-/reducers/settings';

/**
 * Build the {@link AiSettingsSnapshot} carried on each AI payload, from the
 * persisted settings slice. Shared by the chat hook and the inline-edit modal
 * so the snapshot stays in one place.
 */
export function buildAiSnapshot(s: SettingsState): AiSettingsSnapshot {
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
