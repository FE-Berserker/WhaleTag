import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRESETS,
  getPreset,
  DEFAULT_PRESET_ID,
  THEME_MODE_PRESET_MAP,
} from './presets';
import { createWhaleTheme } from './index';

/** WCAG 2.x relative luminance for an opaque #rrggbb color. */
function relativeLuminance(hex: string): number {
  const [red, green, blue] = [1, 3, 5].map((offset) => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

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

describe('preset WCAG contrast', () => {
  it('primary and secondary text meet 4.5:1 on default and paper in every variant', () => {
    for (const preset of PRESETS) {
      for (const mode of ['light', 'dark'] as const) {
        const variant = preset[mode];
        for (const token of ['primary', 'textSecondary'] as const) {
          for (const background of [
            'backgroundDefault',
            'backgroundPaper',
          ] as const) {
            const ratio = contrastRatio(variant[token], variant[background]);
            assert.ok(
              ratio >= 4.5,
              `${preset.id}.${mode}.${token} on ${background}: ${ratio.toFixed(3)}:1`
            );
          }
        }
      }
    }
  });

  it('the global focus indicator meets 3:1 against both preset backgrounds', () => {
    for (const preset of PRESETS) {
      for (const mode of ['light', 'dark'] as const) {
        const variant = preset[mode];
        const theme = createWhaleTheme(mode, preset.id);
        const overrides = theme.components?.MuiButtonBase?.styleOverrides
          ?.root as
          | { '&.Mui-focusVisible'?: { outline?: string } }
          | undefined;
        const outline = overrides?.['&.Mui-focusVisible']?.outline;
        assert.ok(outline, `${preset.id}.${mode} focus outline missing`);
        const focusColor = outline.match(/#[0-9a-f]{6}/i)?.[0];
        assert.ok(focusColor, `${preset.id}.${mode} focus color missing`);
        assert.equal(focusColor, variant.primary);
        for (const background of [
          variant.backgroundDefault,
          variant.backgroundPaper,
        ]) {
          const ratio = contrastRatio(focusColor, background);
          assert.ok(
            ratio >= 3,
            `${preset.id}.${mode} focus on ${background}: ${ratio.toFixed(3)}:1`
          );
        }
      }
    }
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

  it('whale light preserves the brand ramp with WCAG-safe foregrounds', () => {
    const d = getPreset('whale');
    assert.equal(d.light.primary, '#0a7bae');
    assert.equal(d.light.secondary, '#6366f1');
    assert.equal(d.light.backgroundDefault, '#f8fafc');
    assert.equal(d.light.backgroundPaper, '#ffffff');
    assert.equal(d.light.border, '#e2e8f0');
    assert.equal(d.light.text, '#0f172a');
    assert.equal(d.light.textSecondary, '#64738a');
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
