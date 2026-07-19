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
  migrateAi,
  reduceAi,
  aiInitial,
  type AiFields,
} from './settings/ai';
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
    AiFields,
    SystemFields {}

export const initialState: SettingsState = {
  ...appearanceInitial,
  ...browserInitial,
  ...integrationsInitial,
  ...aiInitial,
  ...systemInitial,
};

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
  base = migrateAi(base);
  base = migrateSystem(base);

  base = reduceAppearance(base, action);
  base = reduceBrowser(base, action);
  base = reduceIntegrations(base, action);
  base = reduceAi(base, action);
  return reduceSystem(base, action);
}

export * from './settings/types';
export * from './settings/appearance';
export * from './settings/browser';
export * from './settings/integrations';
export * from './settings/ai';
export * from './settings/system';
