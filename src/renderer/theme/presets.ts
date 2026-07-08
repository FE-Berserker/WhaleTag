/**
 * Theme presets — complete color sets (primary + secondary + both backgrounds)
 * for each of light and dark. Selected via `settings.themePreset` (a string id)
 * and threaded into {@link createWhaleTheme}.
 *
 * The registry mirrors the `SUPPORTED_LANGUAGES` idiom in `i18n.ts`: a
 * `as const` array + a derived id union. Add a preset by appending here only.
 *
 * The first entry (`whale`) is the default and reuses the exact colors the app
 * shipped with before presets existed, so existing users see zero visual change.
 * `getPreset` falls back to it for any unknown / corrupt persisted id.
 */

/**
 * Palette tokens a preset overrides, for a single light/dark variant.
 *
 * The full set mirrors the WhaleTag design language (`docs/UI.md` §3): every
 * token here is emitted by {@link createWhaleTheme} onto a concrete MUI palette
 * slot, so the ~30 components reading `divider` / `text.*` / `action.hover` /
 * `primary.light` follow the spec exactly instead of MUI's auto-derived values.
 *
 * | field          | MUI slot            | UI.md token   |
 * |----------------|---------------------|---------------|
 * | primary        | `primary.main`      | Primary       |
 * | primaryLight   | `primary.light`     | Primary Light |
 * | secondary      | `secondary.main`    | —             |
 * | backgroundDefault | `background.default` | Background |
 * | backgroundPaper   | `background.paper`   | Surface    |
 * | border         | `divider`           | Border        |
 * | text           | `text.primary`      | Text Primary  |
 * | textSecondary  | `text.secondary`    | Text Secondary|
 * | hover          | `action.hover`      | Hover         |
 *
 * `primaryLight` may be an 8-digit `#rrggbbaa` hex (the design uses a
 * translucent primary tint for the active-location background in dark mode).
 */
export interface PresetPaletteVariant {
  primary: string;
  /** Active-location / selected background; may carry alpha (`#rrggbbaa`). */
  primaryLight: string;
  secondary: string;
  backgroundDefault: string;
  backgroundPaper: string;
  /** Dividers, card/input borders → `palette.divider`. */
  border: string;
  /** Titles, file names → `palette.text.primary`. */
  text: string;
  /** Metadata, icons, placeholders → `palette.text.secondary`. */
  textSecondary: string;
  /** List/tree hover + selected row background → `palette.action.hover`. */
  hover: string;
}

/** A full theme preset: colors for both light and dark, plus a preview swatch. */
export interface ThemePreset {
  id: string;
  /** Flat top-level i18n key, e.g. `presetWhale`. */
  labelKey: string;
  /** Two-dot preview shown in the settings picker (typically the primary). */
  swatch: { light: string; dark: string };
  light: PresetPaletteVariant;
  dark: PresetPaletteVariant;
}

/** Persisted preset id that means "no change from pre-preset defaults". */
export const DEFAULT_PRESET_ID = 'whale';

/** Curated full-theme modes map to a fixed (mode, preset) pair. */
export const THEME_MODE_PRESET_MAP: Record<
  | 'warm-paper'
  | 'midnight-plum'
  | 'frosted-mint'
  | 'deep-ocean'
  | 'dawn-blush'
  | 'forest-ink'
  | 'soft-amber'
  | 'high-contrast',
  { mode: 'light' | 'dark'; presetId: string }
> = {
  'warm-paper': { mode: 'light', presetId: 'warm-paper' },
  'midnight-plum': { mode: 'dark', presetId: 'midnight-plum' },
  'frosted-mint': { mode: 'light', presetId: 'frosted-mint' },
  'deep-ocean': { mode: 'dark', presetId: 'deep-ocean' },
  'dawn-blush': { mode: 'light', presetId: 'dawn-blush' },
  'forest-ink': { mode: 'dark', presetId: 'forest-ink' },
  'soft-amber': { mode: 'light', presetId: 'soft-amber' },
  'high-contrast': { mode: 'light', presetId: 'high-contrast' },
};

export type CuratedThemeMode = keyof typeof THEME_MODE_PRESET_MAP;

/**
 * Shared neutral ramp for light variants — the "Clean Professional" slate set
 * from `docs/UI.md` §3.1. Reused across every preset: the neutrals read well on
 * all of the (near-white) light backgrounds, so only `primary`/`primaryLight`
 * change per preset. `whale` matches UI.md's light theme exactly.
 */
const LIGHT_NEUTRALS = {
  border: '#e2e8f0',
  text: '#0f172a',
  textSecondary: '#64748b',
  hover: '#f1f5f9',
} as const;

/**
 * Shared neutral ramp for dark variants — the "Dark Geek" zinc set from
 * `docs/UI.md` §3.2. Reused across presets on top of each preset's own
 * background; `whale` matches UI.md's dark theme exactly.
 */
const DARK_NEUTRALS = {
  border: '#27272a',
  text: '#fafafa',
  textSecondary: '#a1a1aa',
  hover: '#27272a',
} as const;

export const PRESETS = [
  {
    id: 'whale',
    labelKey: 'presetWhale',
    // Light = UI.md "Clean Professional"; dark = UI.md "Dark Geek".
    swatch: { light: '#0ea5e9', dark: '#818cf8' },
    light: {
      primary: '#0ea5e9',
      primaryLight: '#e0f2fe',
      secondary: '#6366f1',
      backgroundDefault: '#f8fafc',
      backgroundPaper: '#ffffff',
      ...LIGHT_NEUTRALS,
    },
    dark: {
      primary: '#818cf8',
      primaryLight: '#818cf820', // 16% tint for active-location bg (UI.md §3.2)
      secondary: '#6366f1',
      backgroundDefault: '#0f0f10',
      backgroundPaper: '#18181b',
      ...DARK_NEUTRALS,
    },
  },
  {
    id: 'ocean',
    labelKey: 'presetOcean',
    swatch: { light: '#0284c7', dark: '#38bdf8' },
    light: {
      primary: '#0284c7',
      primaryLight: '#e0f2fe',
      secondary: '#0891b2',
      backgroundDefault: '#f0f9ff',
      backgroundPaper: '#ffffff',
      ...LIGHT_NEUTRALS,
    },
    dark: {
      primary: '#38bdf8',
      primaryLight: '#38bdf820',
      secondary: '#22d3ee',
      backgroundDefault: '#08141f',
      backgroundPaper: '#0f2233',
      ...DARK_NEUTRALS,
    },
  },
  {
    id: 'forest',
    labelKey: 'presetForest',
    swatch: { light: '#16a34a', dark: '#4ade80' },
    light: {
      primary: '#16a34a',
      primaryLight: '#dcfce7',
      secondary: '#65a30d',
      backgroundDefault: '#f6fef8',
      backgroundPaper: '#ffffff',
      ...LIGHT_NEUTRALS,
    },
    dark: {
      primary: '#4ade80',
      primaryLight: '#4ade8020',
      secondary: '#a3e635',
      backgroundDefault: '#0a1410',
      backgroundPaper: '#102018',
      ...DARK_NEUTRALS,
    },
  },
  {
    id: 'sunset',
    labelKey: 'presetSunset',
    swatch: { light: '#ea580c', dark: '#fb923c' },
    light: {
      primary: '#ea580c',
      primaryLight: '#ffedd5',
      secondary: '#db2777',
      backgroundDefault: '#fff7ed',
      backgroundPaper: '#ffffff',
      ...LIGHT_NEUTRALS,
    },
    dark: {
      primary: '#fb923c',
      primaryLight: '#fb923c20',
      secondary: '#f472b6',
      backgroundDefault: '#1a0f0a',
      backgroundPaper: '#2a1810',
      ...DARK_NEUTRALS,
    },
  },
  {
    id: 'mono',
    labelKey: 'presetMono',
    swatch: { light: '#1f2937', dark: '#e5e7eb' },
    light: {
      primary: '#1f2937',
      primaryLight: '#e5e7eb',
      secondary: '#475569',
      backgroundDefault: '#fafafa',
      backgroundPaper: '#ffffff',
      ...LIGHT_NEUTRALS,
    },
    dark: {
      primary: '#e5e7eb',
      primaryLight: '#e5e7eb20',
      secondary: '#9ca3af',
      backgroundDefault: '#0a0a0a',
      backgroundPaper: '#161616',
      ...DARK_NEUTRALS,
    },
  },
  {
    id: 'warm-paper',
    labelKey: 'presetWarmPaper',
    swatch: { light: '#b45309', dark: '#fb923c' },
    light: {
      primary: '#b45309',
      primaryLight: '#fff7ed',
      secondary: '#d97706',
      backgroundDefault: '#f5f1e8',
      backgroundPaper: '#faf8f2',
      border: '#e7e5e4',
      text: '#292524',
      textSecondary: '#78716c',
      hover: '#efeae0',
    },
    dark: {
      primary: '#fb923c',
      primaryLight: '#fb923c20',
      secondary: '#fbbf24',
      backgroundDefault: '#1a1714',
      backgroundPaper: '#24201c',
      border: '#3f382f',
      text: '#fafaf9',
      textSecondary: '#a8a29e',
      hover: '#3f382f',
    },
  },
  {
    id: 'midnight-plum',
    labelKey: 'presetMidnightPlum',
    swatch: { light: '#9333ea', dark: '#c084fc' },
    light: {
      primary: '#9333ea',
      primaryLight: '#f3e8ff',
      secondary: '#c026d3',
      backgroundDefault: '#faf8ff',
      backgroundPaper: '#ffffff',
      border: '#e9d5ff',
      text: '#3b0764',
      textSecondary: '#7e22ce',
      hover: '#f3e8ff',
    },
    dark: {
      primary: '#c084fc',
      primaryLight: '#c084fc20',
      secondary: '#e879f9',
      backgroundDefault: '#0f0a14',
      backgroundPaper: '#1a1421',
      border: '#2d2438',
      text: '#f5f3ff',
      textSecondary: '#a8a3b3',
      hover: '#2a2035',
    },
  },
  {
    id: 'frosted-mint',
    labelKey: 'presetFrostedMint',
    swatch: { light: '#14b8a6', dark: '#2dd4bf' },
    light: {
      primary: '#14b8a6',
      primaryLight: '#ccfbf1',
      secondary: '#06b6d4',
      backgroundDefault: '#f0fdfa',
      backgroundPaper: '#ffffff',
      border: '#ccfbf1',
      text: '#134e4a',
      textSecondary: '#5f7774',
      hover: '#d6f5f0',
    },
    dark: {
      primary: '#2dd4bf',
      primaryLight: '#2dd4bf20',
      secondary: '#22d3ee',
      backgroundDefault: '#0a1614',
      backgroundPaper: '#112826',
      border: '#1f423e',
      text: '#f0fdfa',
      textSecondary: '#94a3b8',
      hover: '#1f423e',
    },
  },
  {
    id: 'deep-ocean',
    labelKey: 'presetDeepOcean',
    swatch: { light: '#0284c7', dark: '#38bdf8' },
    light: {
      primary: '#0284c7',
      primaryLight: '#e0f2fe',
      secondary: '#0891b2',
      backgroundDefault: '#f0f9ff',
      backgroundPaper: '#ffffff',
      border: '#bae6fd',
      text: '#082f49',
      textSecondary: '#0369a1',
      hover: '#e0f2fe',
    },
    dark: {
      primary: '#38bdf8',
      primaryLight: '#38bdf820',
      secondary: '#22d3ee',
      backgroundDefault: '#0a1929',
      backgroundPaper: '#112a3f',
      border: '#1e3a5f',
      text: '#e6f7ff',
      textSecondary: '#8fb8d9',
      hover: '#1e3a5f',
    },
  },
  {
    id: 'dawn-blush',
    labelKey: 'presetDawnBlush',
    swatch: { light: '#db2777', dark: '#f472b6' },
    light: {
      primary: '#db2777',
      primaryLight: '#fce7f3',
      secondary: '#e11d48',
      backgroundDefault: '#fff5f7',
      backgroundPaper: '#ffffff',
      border: '#fce7eb',
      text: '#4a1423',
      textSecondary: '#9d5b6e',
      hover: '#fce7eb',
    },
    dark: {
      primary: '#f472b6',
      primaryLight: '#f472b620',
      secondary: '#fb7185',
      backgroundDefault: '#2a0a14',
      backgroundPaper: '#3d1020',
      border: '#5c2535',
      text: '#fff1f2',
      textSecondary: '#d48ba0',
      hover: '#5c2535',
    },
  },
  {
    id: 'forest-ink',
    labelKey: 'presetForestInk',
    swatch: { light: '#16a34a', dark: '#34d399' },
    light: {
      primary: '#16a34a',
      primaryLight: '#dcfce7',
      secondary: '#65a30d',
      backgroundDefault: '#f0fdf4',
      backgroundPaper: '#ffffff',
      border: '#bbf7d0',
      text: '#052e16',
      textSecondary: '#3f6212',
      hover: '#dcfce7',
    },
    dark: {
      primary: '#34d399',
      primaryLight: '#34d39920',
      secondary: '#a3e635',
      backgroundDefault: '#0a1f15',
      backgroundPaper: '#112b1e',
      border: '#1f4232',
      text: '#ecfdf5',
      textSecondary: '#86b8a0',
      hover: '#1f4232',
    },
  },
  {
    id: 'soft-amber',
    labelKey: 'presetSoftAmber',
    swatch: { light: '#7c6f46', dark: '#e8dca0' },
    light: {
      primary: '#7c6f46',
      primaryLight: '#f4f1e8',
      secondary: '#9c8b5e',
      backgroundDefault: '#f7f5ee',
      backgroundPaper: '#fcfaf5',
      border: '#e5e2d9',
      text: '#2d2a22',
      textSecondary: '#7a756a',
      hover: '#edeae0',
    },
    dark: {
      primary: '#e8dca0',
      primaryLight: '#e8dca020',
      secondary: '#d4c88c',
      backgroundDefault: '#1a1812',
      backgroundPaper: '#242218',
      border: '#3d382b',
      text: '#f5f3eb',
      textSecondary: '#a8a39a',
      hover: '#3d382b',
    },
  },
  {
    id: 'high-contrast',
    labelKey: 'presetHighContrast',
    swatch: { light: '#000000', dark: '#ffffff' },
    light: {
      primary: '#000000',
      primaryLight: '#f0f0f0',
      secondary: '#000000',
      backgroundDefault: '#ffffff',
      backgroundPaper: '#ffffff',
      border: '#000000',
      text: '#000000',
      textSecondary: '#4d4d4d',
      hover: '#e6e6e6',
    },
    dark: {
      primary: '#ffffff',
      primaryLight: '#ffffff30',
      secondary: '#ffff00',
      backgroundDefault: '#000000',
      backgroundPaper: '#000000',
      border: '#ffffff',
      text: '#ffffff',
      textSecondary: '#ffff00',
      hover: '#1a1a1a',
    },
  },
] as const satisfies readonly ThemePreset[];

export type ThemePresetId = (typeof PRESETS)[number]['id'];

/**
 * Resolve a preset by id, falling back to the default (`whale`) for unknown /
 * undefined ids. Centralizing the fallback means a corrupt or removed preset
 * id in persisted state can never crash the theme factory.
 */
export function getPreset(id: string | undefined): ThemePreset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}
