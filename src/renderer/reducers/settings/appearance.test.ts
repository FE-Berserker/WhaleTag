import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  appearanceInitial,
  migrateAppearance,
  type AppearanceFields,
} from './appearance';
import type { ThemeMode } from './types';

const VALID_MODES: ThemeMode[] = [
  'light',
  'dark',
  'system',
  'warm-paper',
  'midnight-plum',
  'frosted-mint',
  'deep-ocean',
  'dawn-blush',
  'forest-ink',
  'soft-amber',
  'high-contrast',
];

describe('appearance themeMode migration', () => {
  it('normalizes corrupt, missing, future, and prototype-like values to light', () => {
    for (const themeMode of [
      'future-theme',
      '__proto__',
      'constructor',
      '',
      undefined,
      null,
      42,
    ]) {
      const persisted = {
        ...appearanceInitial,
        themeMode,
      } as unknown as AppearanceFields;
      const migrated = migrateAppearance(persisted);
      assert.equal(migrated.themeMode, 'light', String(themeMode));
      assert.notEqual(migrated, persisted);
    }
  });

  it('preserves every supported mode without allocating during a no-op migration', () => {
    for (const themeMode of VALID_MODES) {
      const persisted = { ...appearanceInitial, themeMode };
      assert.equal(migrateAppearance(persisted), persisted, themeMode);
      assert.equal(migrateAppearance(persisted).themeMode, themeMode);
    }
  });
});
