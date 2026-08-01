import type { AiSettingsSnapshot } from '../../../shared/ai-types';
import type { SettingsState } from '-/reducers/settings';

/** Clamp an agent-loop turn cap to the SDK-safe range [1, 1000]. The SDK's
 *  `query()` requires maxTurns >= 1; the upper bound just guards typos.
 *  Non-finite / NaN falls back to the default (200). Truncated to an integer.
 *  Pure; exported for tests. */
export function clampMaxTurns(n: number): number {
  return Number.isFinite(n) ? Math.max(1, Math.min(1000, Math.trunc(n))) : 200;
}

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
    maxTurns: clampMaxTurns(s.aiMaxTurns),
  };
}
