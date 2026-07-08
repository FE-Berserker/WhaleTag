import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import settingsReducer, {
  clampViewDepth,
  initialState,
  setViewDepth,
  setThemeMode,
  setThemePreset,
  setListRowDensity,
  setDwg2dxfPath,
  setOdaPath,
  setKeybinding,
  resetKeybindings,
  setGalleryShowTags,
  MAX_VIEW_DEPTH,
  MIN_VIEW_DEPTH,
} from './settings';
import type { SettingsState } from './settings';
import { DEFAULT_KEYBINDINGS } from '../../shared/keybindings';

describe('settings.viewDepth constants', () => {
  it('bounds are 1-5', () => {
    assert.equal(MIN_VIEW_DEPTH, 1);
    assert.equal(MAX_VIEW_DEPTH, 5);
  });

  it('clampViewDepth accepts in-range values', () => {
    assert.equal(clampViewDepth(1), 1);
    assert.equal(clampViewDepth(3), 3);
    assert.equal(clampViewDepth(5), 5);
  });

  it('clampViewDepth clamps below the minimum', () => {
    assert.equal(clampViewDepth(0), 1);
    assert.equal(clampViewDepth(-7), 1);
  });

  it('clampViewDepth clamps above the maximum', () => {
    assert.equal(clampViewDepth(6), 5);
    assert.equal(clampViewDepth(99), 5);
  });

  it('clampViewDepth truncates fractional values toward zero', () => {
    assert.equal(clampViewDepth(2.7), 2);
    assert.equal(clampViewDepth(4.99), 4);
  });

  it('clampViewDepth falls back to the default for non-finite input', () => {
    assert.equal(clampViewDepth(NaN), 1);
    assert.equal(clampViewDepth(Infinity), 1);
    assert.equal(clampViewDepth(-Infinity), 1);
  });
});

describe('settings.viewDepth action creator', () => {
  it('setViewDepth preserves in-range payloads', () => {
    assert.equal(setViewDepth(1).payload, 1);
    assert.equal(setViewDepth(4).payload, 4);
    assert.equal(setViewDepth(5).payload, 5);
  });

  it('setViewDepth clamps out-of-range payloads at the action boundary', () => {
    assert.equal(setViewDepth(0).payload, 1);
    assert.equal(setViewDepth(-3).payload, 1);
    assert.equal(setViewDepth(99).payload, 5);
  });
});

describe('settings.viewDepth initialState', () => {
  it('initialState.viewDepth is 1 (today behavior)', () => {
    assert.equal(initialState.viewDepth, 1);
  });
});

describe('settings.viewDepth reducer', () => {
  it('applies SET_VIEW_DEPTH to an in-range value', () => {
    const next = settingsReducer(initialState, setViewDepth(3));
    assert.equal(next.viewDepth, 3);
  });

  it('clamps an oversized payload through the reducer (belt-and-suspenders)', () => {
    // The creator already clamps, but the reducer's case re-clamps in case a
    // caller dispatches the action type directly without using the creator.
    const raw = { type: 'settings/SET_VIEW_DEPTH' as const, payload: 99 };
    const next = settingsReducer(initialState, raw);
    assert.equal(next.viewDepth, 5);
  });

  it('clamps an undersized payload through the reducer', () => {
    const raw = { type: 'settings/SET_VIEW_DEPTH' as const, payload: -2 };
    const next = settingsReducer(initialState, raw);
    assert.equal(next.viewDepth, 1);
  });

  it('migrates a state without viewDepth to the default (1)', () => {
    // Simulate a persisted state from before H.24 was released.
    const legacyState = { ...initialState, viewDepth: undefined } as unknown as SettingsState;
    const next = settingsReducer(legacyState, { type: 'no-op' });
    assert.equal(next.viewDepth, 1);
  });

  it('migrates an out-of-bounds persisted viewDepth back to the default', () => {
    // Defensive: a corrupt or future-schema write should snap back to 1.
    const corrupt = { ...initialState, viewDepth: 99 } as SettingsState;
    const next = settingsReducer(corrupt, { type: 'no-op' });
    assert.equal(next.viewDepth, 1);
  });

  it('migrates a NaN persisted viewDepth back to the default', () => {
    const corrupt = { ...initialState, viewDepth: NaN } as unknown as SettingsState;
    const next = settingsReducer(corrupt, { type: 'no-op' });
    assert.equal(next.viewDepth, 1);
  });

  it('preserves a valid in-range persisted viewDepth across no-op actions', () => {
    const seeded = { ...initialState, viewDepth: 4 } as SettingsState;
    const next = settingsReducer(seeded, { type: 'no-op' });
    assert.equal(next.viewDepth, 4);
  });

  it('returns a fresh state object on SET_VIEW_DEPTH (immutability)', () => {
    const next = settingsReducer(initialState, setViewDepth(2));
    assert.notEqual(next, initialState);
    assert.equal(initialState.viewDepth, 1); // unchanged
    assert.equal(next.viewDepth, 2);
  });

  it('does not touch other settings fields when SET_VIEW_DEPTH fires', () => {
    const next = settingsReducer(initialState, setViewDepth(3));
    assert.equal(next.themeMode, initialState.themeMode);
    assert.equal(next.language, initialState.language);
    assert.equal(next.trayWidth, initialState.trayWidth);
    assert.equal(next.defaultViewMode, initialState.defaultViewMode);
  });

  it('setViewDepth(1) followed by setViewDepth(5) ends at 5', () => {
    let s = settingsReducer(initialState, setViewDepth(1));
    s = settingsReducer(s, setViewDepth(5));
    assert.equal(s.viewDepth, 5);
  });
});

describe('settings.themeMode (system/auto mode)', () => {
  it('initialState.themeMode is light', () => {
    assert.equal(initialState.themeMode, 'light');
  });

  it('accepts system after the ThemeMode widening', () => {
    const next = settingsReducer(initialState, setThemeMode('system'));
    assert.equal(next.themeMode, 'system');
  });

  it('still accepts light and dark', () => {
    assert.equal(
      settingsReducer(initialState, setThemeMode('dark')).themeMode,
      'dark'
    );
    assert.equal(
      settingsReducer(initialState, setThemeMode('light')).themeMode,
      'light'
    );
  });

  it('accepts the new curated full-theme modes', () => {
    assert.equal(
      settingsReducer(initialState, setThemeMode('warm-paper')).themeMode,
      'warm-paper'
    );
    assert.equal(
      settingsReducer(initialState, setThemeMode('midnight-plum')).themeMode,
      'midnight-plum'
    );
    assert.equal(
      settingsReducer(initialState, setThemeMode('frosted-mint')).themeMode,
      'frosted-mint'
    );
    assert.equal(
      settingsReducer(initialState, setThemeMode('deep-ocean')).themeMode,
      'deep-ocean'
    );
    assert.equal(
      settingsReducer(initialState, setThemeMode('dawn-blush')).themeMode,
      'dawn-blush'
    );
    assert.equal(
      settingsReducer(initialState, setThemeMode('forest-ink')).themeMode,
      'forest-ink'
    );
    assert.equal(
      settingsReducer(initialState, setThemeMode('soft-amber')).themeMode,
      'soft-amber'
    );
    assert.equal(
      settingsReducer(initialState, setThemeMode('high-contrast')).themeMode,
      'high-contrast'
    );
  });

  it('preserves a persisted warm-paper themeMode across no-op actions', () => {
    const seeded = { ...initialState, themeMode: 'warm-paper' as const };
    const next = settingsReducer(seeded, { type: 'no-op' });
    assert.equal(next.themeMode, 'warm-paper');
  });

  it('preserves a persisted midnight-plum themeMode across no-op actions', () => {
    const seeded = { ...initialState, themeMode: 'midnight-plum' as const };
    const next = settingsReducer(seeded, { type: 'no-op' });
    assert.equal(next.themeMode, 'midnight-plum');
  });

  it('preserves a persisted frosted-mint themeMode across no-op actions', () => {
    const seeded = { ...initialState, themeMode: 'frosted-mint' as const };
    const next = settingsReducer(seeded, { type: 'no-op' });
    assert.equal(next.themeMode, 'frosted-mint');
  });

  it('preserves a persisted deep-ocean themeMode across no-op actions', () => {
    const seeded = { ...initialState, themeMode: 'deep-ocean' as const };
    const next = settingsReducer(seeded, { type: 'no-op' });
    assert.equal(next.themeMode, 'deep-ocean');
  });

  it('preserves a persisted dawn-blush themeMode across no-op actions', () => {
    const seeded = { ...initialState, themeMode: 'dawn-blush' as const };
    const next = settingsReducer(seeded, { type: 'no-op' });
    assert.equal(next.themeMode, 'dawn-blush');
  });

  it('preserves a persisted forest-ink themeMode across no-op actions', () => {
    const seeded = { ...initialState, themeMode: 'forest-ink' as const };
    const next = settingsReducer(seeded, { type: 'no-op' });
    assert.equal(next.themeMode, 'forest-ink');
  });

  it('preserves a persisted soft-amber themeMode across no-op actions', () => {
    const seeded = { ...initialState, themeMode: 'soft-amber' as const };
    const next = settingsReducer(seeded, { type: 'no-op' });
    assert.equal(next.themeMode, 'soft-amber');
  });

  it('preserves a persisted high-contrast themeMode across no-op actions', () => {
    const seeded = { ...initialState, themeMode: 'high-contrast' as const };
    const next = settingsReducer(seeded, { type: 'no-op' });
    assert.equal(next.themeMode, 'high-contrast');
  });

  it('old light/dark persisted values need no migration', () => {
    // Widening is backward-compatible: legacy values satisfy the new union.
    const legacy = { ...initialState, themeMode: 'dark' as const };
    assert.equal(settingsReducer(legacy, { type: 'no-op' }).themeMode, 'dark');
  });
});

describe('settings.themePreset', () => {
  it('initialState.themePreset is the default (whale)', () => {
    assert.equal(initialState.themePreset, 'whale');
  });

  it('applies SET_THEME_PRESET', () => {
    const next = settingsReducer(initialState, setThemePreset('ocean'));
    assert.equal(next.themePreset, 'ocean');
  });

  it('migrates a state without themePreset to the default', () => {
    // Simulate a persisted state from before presets shipped.
    const legacy = {
      ...initialState,
      themePreset: undefined,
    } as unknown as SettingsState;
    const next = settingsReducer(legacy, { type: 'no-op' });
    assert.equal(next.themePreset, 'whale');
  });

  it('stores an arbitrary unknown preset id verbatim (validation is at getPreset)', () => {
    const next = settingsReducer(
      initialState,
      setThemePreset('deleted-preset')
    );
    assert.equal(next.themePreset, 'deleted-preset');
  });

  it('does not touch themeMode when SET_THEME_PRESET fires', () => {
    const next = settingsReducer(initialState, setThemePreset('forest'));
    assert.equal(next.themeMode, initialState.themeMode);
  });

  it('returns a fresh state object on SET_THEME_PRESET (immutability)', () => {
    const next = settingsReducer(initialState, setThemePreset('sunset'));
    assert.notEqual(next, initialState);
    assert.equal(initialState.themePreset, 'whale');
    assert.equal(next.themePreset, 'sunset');
  });
});

describe('settings.listRowDensity', () => {
  it('initialState.listRowDensity is normal', () => {
    assert.equal(initialState.listRowDensity, 'normal');
  });

  it('applies SET_LIST_ROW_DENSITY', () => {
    const compact = settingsReducer(initialState, setListRowDensity('compact'));
    assert.equal(compact.listRowDensity, 'compact');
    const comfortable = settingsReducer(compact, setListRowDensity('comfortable'));
    assert.equal(comfortable.listRowDensity, 'comfortable');
  });

  it('migrates a state without listRowDensity to normal', () => {
    const legacy = {
      ...initialState,
      listRowDensity: undefined,
    } as unknown as SettingsState;
    const next = settingsReducer(legacy, { type: 'no-op' });
    assert.equal(next.listRowDensity, 'normal');
  });

  it('returns a fresh state object on SET_LIST_ROW_DENSITY (immutability)', () => {
    const next = settingsReducer(initialState, setListRowDensity('compact'));
    assert.notEqual(next, initialState);
    assert.equal(initialState.listRowDensity, 'normal');
    assert.equal(next.listRowDensity, 'compact');
  });

  it('does not touch other settings fields when SET_LIST_ROW_DENSITY fires', () => {
    const next = settingsReducer(initialState, setListRowDensity('comfortable'));
    assert.equal(next.themeMode, initialState.themeMode);
    assert.equal(next.viewDepth, initialState.viewDepth);
    assert.equal(next.defaultViewMode, initialState.defaultViewMode);
  });
});

describe('settings.keybindings', () => {
  it('initialState.keybindings matches DEFAULT_KEYBINDINGS (by value)', () => {
    assert.deepEqual(initialState.keybindings, DEFAULT_KEYBINDINGS);
  });

  it('initialState.keybindings is a copy, not the shared DEFAULT ref', () => {
    // Defense-in-depth: mutating initialState must not bleed into DEFAULT.
    assert.notEqual(initialState.keybindings, DEFAULT_KEYBINDINGS);
  });

  it('SET_KEYBINDING updates an existing token', () => {
    const next = settingsReducer(
      initialState,
      setKeybinding('ArrowLeft', 'jumpHome')
    );
    assert.equal(next.keybindings.ArrowLeft, 'jumpHome');
    // untouched tokens are preserved
    assert.equal(next.keybindings.ArrowRight, 'open');
  });

  it('SET_KEYBINDING returns a fresh keybindings object (immutability)', () => {
    const next = settingsReducer(initialState, setKeybinding('Tab', 'none'));
    assert.notEqual(next.keybindings, initialState.keybindings);
  });

  it("SET_KEYBINDING with action 'none' removes the token entirely", () => {
    const next = settingsReducer(initialState, setKeybinding('Tab', 'none'));
    assert.ok(!('Tab' in next.keybindings));
    // so the browser default (focus traversal) is restored for that key
  });

  it('RESET_KEYBINDINGS restores the defaults', () => {
    const changed = settingsReducer(
      initialState,
      setKeybinding('Tab', 'none')
    );
    const reset = settingsReducer(changed, resetKeybindings());
    assert.deepEqual(reset.keybindings, DEFAULT_KEYBINDINGS);
  });

  it('migrates a state without keybindings to the defaults', () => {
    const legacy = {
      ...initialState,
      keybindings: undefined,
    } as unknown as SettingsState;
    const next = settingsReducer(legacy, { type: 'no-op' });
    assert.deepEqual(next.keybindings, DEFAULT_KEYBINDINGS);
  });

  it('sanitizes a corrupt persisted token on load', () => {
    const corrupt = {
      ...initialState,
      keybindings: { ...DEFAULT_KEYBINDINGS, CtrlZ: 'open' },
    } as SettingsState;
    const next = settingsReducer(corrupt, { type: 'no-op' });
    assert.ok(!('CtrlZ' in next.keybindings));
    assert.equal(next.keybindings.Enter, 'open'); // valid entries survive
  });

  it('sanitizes a corrupt persisted action on load', () => {
    const corrupt = {
      ...initialState,
      keybindings: { Enter: 'fly' as never, Tab: 'switchView' },
    } as SettingsState;
    const next = settingsReducer(corrupt, { type: 'no-op' });
    assert.ok(!('Enter' in next.keybindings));
    assert.equal(next.keybindings.Tab, 'switchView');
  });

  it('does not touch other settings fields when SET_KEYBINDING fires', () => {
    const next = settingsReducer(initialState, setKeybinding('Tab', 'none'));
    assert.equal(next.themeMode, initialState.themeMode);
    assert.equal(next.viewDepth, initialState.viewDepth);
    assert.equal(next.defaultViewMode, initialState.defaultViewMode);
  });

  it('H.25: rehydration identity — clean keybindings keep the same object reference', () => {
    // redux-persist v5's `autoMergeLevel1` reconciler skips a whole slice's
    // rehydration whenever `originalState[key] !== reducedState[key]` (i.e.
    // the reducer allocated a new object for the slice during REHYDRATE).
    // When that happens, the persisted themeMode / language / viewDepth etc.
    // all silently revert to defaults on every restart — the original "settings
    // revert to defaults" bug. The fix in the settings reducer is to only
    // allocate a new settings object when sanitizeKeybindings actually drops
    // or rewrites an entry, so a clean rehydration round-trips identity.
    const persisted: SettingsState = {
      ...initialState,
      themeMode: 'dark',
      language: 'en',
      viewDepth: 3,
      // keybindings is a *valid* map (matches what the app would write).
      keybindings: { ...DEFAULT_KEYBINDINGS, Delete: 'delete' },
    };
    const next = settingsReducer(persisted, { type: 'persist/REHYDRATE' });
    // Identity preserved: the reconciler can detect "no change" and apply
    // the rehydrated slice (themeMode, viewDepth, etc.) on top.
    assert.equal(next, persisted, 'reducer should not allocate when nothing changed');
  });

  it('H.25: rehydration — dirty keybindings still get sanitized, new object expected', () => {
    // Counter-test: a hand-edited or corrupt persisted state with bogus tokens
    // and 'none' entries MUST be sanitized, and that sanitization IS a
    // behavior change so a new settings object is the right call here.
    const dirty: SettingsState = {
      ...initialState,
      themeMode: 'dark',
      keybindings: {
        ...DEFAULT_KEYBINDINGS,
        CtrlZ: 'open', // unknown token — must be dropped
        Tab: 'none', // 'none' — must be dropped
        Enter: 'fly' as never, // unknown action — must be dropped
      },
    };
    const next = settingsReducer(dirty, { type: 'persist/REHYDRATE' });
    assert.notEqual(next, dirty, 'reducer should allocate when sanitization drops entries');
    assert.ok(!('CtrlZ' in next.keybindings));
    assert.ok(!('Tab' in next.keybindings));
    assert.ok(!('Enter' in next.keybindings));
    // themeMode survived intact even though keybindings was rewritten.
    assert.equal(next.themeMode, 'dark');
  });
});

describe('settings.dwgConverterPaths', () => {
  it('initialState has null DWG converter paths', () => {
    assert.equal(initialState.dwg2dxfPath, null);
    assert.equal(initialState.odaPath, null);
  });

  it('applies SET_DWG_2DXF_PATH', () => {
    const next = settingsReducer(
      initialState,
      setDwg2dxfPath('C:\\libredwg\\dwg2dxf.exe')
    );
    assert.equal(next.dwg2dxfPath, 'C:\\libredwg\\dwg2dxf.exe');
  });

  it('applies SET_ODA_PATH', () => {
    const next = settingsReducer(
      initialState,
      setOdaPath('C:\\ODA\\ODAFileConverter.exe')
    );
    assert.equal(next.odaPath, 'C:\\ODA\\ODAFileConverter.exe');
  });

  it('clears path when empty string is passed', () => {
    const withPath = settingsReducer(
      initialState,
      setDwg2dxfPath('C:\\libredwg\\dwg2dxf.exe')
    );
    const cleared = settingsReducer(withPath, setDwg2dxfPath(''));
    assert.equal(cleared.dwg2dxfPath, null);
  });

  it('migrates a state without DWG path fields to null', () => {
    const legacy = {
      ...initialState,
      dwg2dxfPath: undefined,
      odaPath: undefined,
    } as unknown as SettingsState;
    const next = settingsReducer(legacy, { type: 'no-op' });
    assert.equal(next.dwg2dxfPath, null);
    assert.equal(next.odaPath, null);
  });

  it('returns a fresh state object on SET_DWG_2DXF_PATH (immutability)', () => {
    const next = settingsReducer(
      initialState,
      setDwg2dxfPath('C:\\libredwg\\dwg2dxf.exe')
    );
    assert.notEqual(next, initialState);
    assert.equal(initialState.dwg2dxfPath, null);
    assert.equal(next.dwg2dxfPath, 'C:\\libredwg\\dwg2dxf.exe');
  });

  it('does not touch other settings fields when DWG path actions fire', () => {
    const next = settingsReducer(
      initialState,
      setOdaPath('C:\\ODA\\ODAFileConverter.exe')
    );
    assert.equal(next.themeMode, initialState.themeMode);
    assert.equal(next.sofficePath, initialState.sofficePath);
    assert.equal(next.viewDepth, initialState.viewDepth);
  });
});

describe('settings.galleryShowTags', () => {
  it('defaults to true in initialState', () => {
    assert.equal(initialState.galleryShowTags, true);
  });

  it('toggles via setGalleryShowTags', () => {
    const off = settingsReducer(initialState, setGalleryShowTags(false));
    assert.equal(off.galleryShowTags, false);
    const on = settingsReducer(off, setGalleryShowTags(true));
    assert.equal(on.galleryShowTags, true);
  });

  it('migrates a legacy state without galleryShowTags to true', () => {
    const legacy = { ...initialState, galleryShowTags: undefined } as unknown as SettingsState;
    const next = settingsReducer(legacy, { type: 'no-op' });
    assert.equal(next.galleryShowTags, true);
  });
});
