import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRESETS,
  getPreset,
  DEFAULT_PRESET_ID,
  THEME_MODE_PRESET_MAP,
} from './presets';

describe('theme presets registry', () => {
  it('ships at least the default set of presets', () => {
    const ids = PRESETS.map((p) => p.id);
    assert.ok(ids.includes('whale'));
    assert.ok(ids.includes('ocean'));
    assert.ok(ids.includes('forest'));
    assert.ok(ids.includes('sunset'));
    assert.ok(ids.includes('mono'));
    assert.ok(ids.includes('warm-paper'));
    assert.ok(ids.includes('midnight-plum'));
    assert.ok(ids.includes('frosted-mint'));
    assert.ok(ids.includes('deep-ocean'));
    assert.ok(ids.includes('dawn-blush'));
    assert.ok(ids.includes('forest-ink'));
    assert.ok(ids.includes('soft-amber'));
    assert.ok(ids.includes('high-contrast'));
  });

  it('all preset ids are unique', () => {
    const ids = PRESETS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('default preset id is the first entry', () => {
    assert.equal(DEFAULT_PRESET_ID, PRESETS[0].id);
    assert.equal(DEFAULT_PRESET_ID, 'whale');
  });

  it('every preset has complete light + dark variants', () => {
    const keys = [
      'primary',
      'primaryLight',
      'secondary',
      'backgroundDefault',
      'backgroundPaper',
      'border',
      'text',
      'textSecondary',
      'hover',
    ] as const;
    for (const p of PRESETS) {
      for (const k of keys) {
        assert.ok(p.light[k], `${p.id}.light.${k} missing`);
        assert.ok(p.dark[k], `${p.id}.dark.${k} missing`);
      }
      assert.ok(p.swatch.light, `${p.id}.swatch.light missing`);
      assert.ok(p.swatch.dark, `${p.id}.swatch.dark missing`);
      assert.ok(p.labelKey, `${p.id}.labelKey missing`);
    }
  });

  it('all colors are valid hex (#rrggbb, or #rrggbbaa for primaryLight)', () => {
    const hex = /^#[0-9a-f]{6}$/i;
    // primaryLight may carry alpha for the translucent dark active-location bg.
    const hexWithAlpha = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
    for (const p of PRESETS) {
      assert.match(p.swatch.light, hex);
      assert.match(p.swatch.dark, hex);
      for (const v of [p.light, p.dark]) {
        assert.match(v.primary, hex);
        assert.match(v.primaryLight, hexWithAlpha);
        assert.match(v.secondary, hex);
        assert.match(v.backgroundDefault, hex);
        assert.match(v.backgroundPaper, hex);
        assert.match(v.border, hex);
        assert.match(v.text, hex);
        assert.match(v.textSecondary, hex);
        assert.match(v.hover, hex);
      }
    }
  });

  it('every labelKey is unique', () => {
    const keys = PRESETS.map((p) => p.labelKey);
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe('getPreset fallback', () => {
  it('returns the matching preset for a known id', () => {
    assert.equal(getPreset('forest').id, 'forest');
  });

  it('returns the default preset for an unknown id', () => {
    assert.equal(getPreset('does-not-exist').id, DEFAULT_PRESET_ID);
  });

  it('returns the default preset for undefined', () => {
    assert.equal(getPreset(undefined).id, DEFAULT_PRESET_ID);
  });

  it('whale light matches UI.md "Clean Professional" (unchanged for existing users)', () => {
    const d = getPreset('whale');
    assert.equal(d.light.primary, '#0ea5e9');
    assert.equal(d.light.secondary, '#6366f1');
    assert.equal(d.light.backgroundDefault, '#f8fafc');
    assert.equal(d.light.backgroundPaper, '#ffffff');
    assert.equal(d.light.border, '#e2e8f0');
    assert.equal(d.light.text, '#0f172a');
    assert.equal(d.light.textSecondary, '#64748b');
    assert.equal(d.light.hover, '#f1f5f9');
    assert.equal(d.light.primaryLight, '#e0f2fe');
  });

  it('whale dark matches UI.md "Dark Geek"', () => {
    const d = getPreset('whale');
    assert.equal(d.dark.primary, '#818cf8');
    assert.equal(d.dark.backgroundDefault, '#0f0f10');
    assert.equal(d.dark.backgroundPaper, '#18181b');
    assert.equal(d.dark.border, '#27272a');
    assert.equal(d.dark.text, '#fafafa');
    assert.equal(d.dark.textSecondary, '#a1a1aa');
    assert.equal(d.dark.hover, '#27272a');
    assert.equal(d.dark.primaryLight, '#818cf820');
  });

  it('curated full-theme modes map to fixed mode + preset pairs', () => {
    assert.deepEqual(THEME_MODE_PRESET_MAP['warm-paper'], {
      mode: 'light',
      presetId: 'warm-paper',
    });
    assert.deepEqual(THEME_MODE_PRESET_MAP['midnight-plum'], {
      mode: 'dark',
      presetId: 'midnight-plum',
    });
    assert.deepEqual(THEME_MODE_PRESET_MAP['frosted-mint'], {
      mode: 'light',
      presetId: 'frosted-mint',
    });
    assert.deepEqual(THEME_MODE_PRESET_MAP['deep-ocean'], {
      mode: 'dark',
      presetId: 'deep-ocean',
    });
    assert.deepEqual(THEME_MODE_PRESET_MAP['dawn-blush'], {
      mode: 'light',
      presetId: 'dawn-blush',
    });
    assert.deepEqual(THEME_MODE_PRESET_MAP['forest-ink'], {
      mode: 'dark',
      presetId: 'forest-ink',
    });
    assert.deepEqual(THEME_MODE_PRESET_MAP['soft-amber'], {
      mode: 'light',
      presetId: 'soft-amber',
    });
    assert.deepEqual(THEME_MODE_PRESET_MAP['high-contrast'], {
      mode: 'light',
      presetId: 'high-contrast',
    });
  });
});
