import type { AnyAction } from 'redux';

import {
  migrateAppearance,
  reduceAppearance,
  appearanceInitial,
  type AppearanceFields,
} from './settings/appearance';
import {
  migrateBrowser,
  reduceBrowser,
  browserInitial,
  type BrowserFields,
} from './settings/browser';
import {
  migrateIntegrations,
  reduceIntegrations,
  integrationsInitial,
  type IntegrationsFields,
} from './settings/integrations';
import {
  migrateSystem,
  reduceSystem,
  systemInitial,
  type SystemFields,
} from './settings/system';

/**
 * Persisted UI/user preferences — the composition of the per-domain field
 * interfaces in `./settings/` (docs/01 §12: the 1.2k-line god-slice was
 * split by domain with the state shape frozen, so every selector and the
 * redux-persist rehydration keep working unchanged; this file re-exports
 * the full public surface so consumers' imports are untouched).
 */
export interface SettingsState
  extends AppearanceFields,
    BrowserFields,
    IntegrationsFields,
    SystemFields {}

export const initialState: SettingsState = {
  ...appearanceInitial,
  ...browserInitial,
  ...integrationsInitial,
  ...systemInitial,
};

/**
 * Strips the persisted `ai*` fields written by the removed built-in AI
 * assistant (0.5.0). redux-persist rehydrates whatever keys are in the
 * storage JSON; without this the stale keys would linger in storage forever.
 * The `ai` conversation slice key is dropped by the persist migrate step in
 * `configureStore.ts`.
 */
const REMOVED_AI_FIELDS = [
  'aiProvider',
  'aiOllamaUrl',
  'aiOpenaiUrl',
  'aiAnthropicBaseUrl',
  'aiAnthropicAuthMode',
  'aiEnabled',
  'aiPanelOpen',
  'aiPanelWidth',
  'aiModel',
  'aiPermissionMode',
  'aiEffort',
  'aiSafeMode',
  'aiCustomSystemPrompt',
  'aiEnvVarOverrides',
  'aiCliPath',
  'aiLoadUserSettings',
  'aiMcpServers',
  'aiHttpTools',
  'aiMaxTurns',
] as const;

function stripRemovedAiFields(base: SettingsState): SettingsState {
  let changed = false;
  const next: Record<string, unknown> = { ...base };
  for (const key of REMOVED_AI_FIELDS) {
    if (key in next) {
      delete next[key];
      changed = true;
    }
  }
  return changed ? (next as unknown as SettingsState) : base;
}

export default function settingsReducer(
  state = initialState,
  action: AnyAction
): SettingsState {
  // Migration backfill (redux-persist backfill for fields added after the
  // user's first run) — per domain, in the original single-file order. Each
  // `migrateX` only allocates a new object when it actually changes a field,
  // which the `autoMergeLevel1` reconciler depends on (see the keybindings
  // note in system.ts).
  let base: SettingsState = state;
  base = migrateAppearance(base);
  base = migrateBrowser(base);
  base = migrateIntegrations(base);
  base = stripRemovedAiFields(base);
  base = migrateSystem(base);

  base = reduceAppearance(base, action);
  base = reduceBrowser(base, action);
  base = reduceIntegrations(base, action);
  return reduceSystem(base, action);
}

export * from './settings/types';
export * from './settings/appearance';
export * from './settings/browser';
export * from './settings/integrations';
export * from './settings/system';
