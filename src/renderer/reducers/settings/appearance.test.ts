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

describe('appearance list-presentation migration', () => {
  /** A pre-H.23 persisted state: none of the four list fields exist yet. */
  function legacyState(): Record<string, unknown> {
    const persisted = { ...appearanceInitial } as Record<string, unknown>;
    delete persisted.listColumnWidths;
    delete persisted.listHiddenColumns;
    delete persisted.listZebra;
    delete persisted.listDateFormat;
    return persisted;
  }

  it('backfills all four list fields on a legacy profile', () => {
    const persisted = legacyState() as unknown as AppearanceFields;
    const migrated = migrateAppearance(persisted);
    assert.deepEqual(migrated.listColumnWidths, {
      name: 240,
      size: 64,
      modified: 96,
    });
    assert.deepEqual(migrated.listHiddenColumns, []);
    assert.equal(migrated.listZebra, false);
    assert.equal(migrated.listDateFormat, 'absolute');
    assert.notEqual(migrated, persisted, 'must allocate a migrated object');
  });

  it('does not share the default width map with appearanceInitial', () => {
    const persisted = legacyState() as unknown as AppearanceFields;
    const migrated = migrateAppearance(persisted);
    migrated.listColumnWidths.name = 999;
    assert.equal(appearanceInitial.listColumnWidths.name, 240);
  });

  it('normalizes corrupt list-field values instead of passing them through', () => {
    const corrupt: unknown[] = [
      null,
      '240,64,96',
      [240, 64, 96],
      { name: Number.NaN },
      { name: 'wide' },
      { name: -1 },
    ];
    for (const listColumnWidths of corrupt) {
      const persisted = {
        ...appearanceInitial,
        listColumnWidths,
        listHiddenColumns: 'name',
        listZebra: 'yes',
        listDateFormat: 'fuzzy',
      } as unknown as AppearanceFields;
      const migrated = migrateAppearance(persisted);
      assert.deepEqual(
        migrated.listColumnWidths,
        { name: 240, size: 64, modified: 96 },
        String(listColumnWidths)
      );
      assert.deepEqual(migrated.listHiddenColumns, []);
      assert.equal(migrated.listZebra, false);
      assert.equal(migrated.listDateFormat, 'absolute');
    }
  });

  it('keeps valid list-field values and does not allocate', () => {
    const persisted = {
      ...appearanceInitial,
      listColumnWidths: { name: 320, modified: 120 },
      listHiddenColumns: ['size'],
      listZebra: true,
      listDateFormat: 'relative' as const,
    };
    assert.equal(migrateAppearance(persisted), persisted);
    const migrated = migrateAppearance(persisted);
    assert.deepEqual(migrated.listColumnWidths, { name: 320, modified: 120 });
    assert.deepEqual(migrated.listHiddenColumns, ['size']);
    assert.equal(migrated.listZebra, true);
    assert.equal(migrated.listDateFormat, 'relative');
  });

  it('accepts an empty width override map as valid', () => {
    const persisted = { ...appearanceInitial, listColumnWidths: {} };
    assert.equal(migrateAppearance(persisted), persisted);
  });
});
