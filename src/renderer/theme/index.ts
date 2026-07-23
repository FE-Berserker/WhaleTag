import { createTheme } from '@mui/material/styles';
import { getPreset } from '-/theme/presets';

export { PRESETS, getPreset, DEFAULT_PRESET_ID } from '-/theme/presets';
export type { ThemePreset, ThemePresetId, PresetPaletteVariant } from '-/theme/presets';

/**
 * Shared height for the three top column headers (locations / directory tree /
 * file toolbar). They live in separate components but must line up across the
 * window, so they all pin to this value — change it here and all three follow.
 */
export const COLUMN_HEADER_HEIGHT = 48;

/**
 * Whale MUI theme factory. Colors come from the selected preset
 * (`settings.themePreset`); `mode` + base font size are read from the persisted
 * `settings` slice (resolved in Root.tsx), so changing any of them re-creates
 * the theme object and re-renders instantly.
 *
 * `mode` MUST be the resolved `'light' | 'dark'` — never `'system'` or one of
 * the curated full-theme mode ids. MUI's `palette.mode` only accepts those two
 * values; passing anything else throws in MUI's contrast-text computation. Callers
 * resolve the original `ThemeMode` via {@link useResolvedTheme} before calling this.
 * The narrowed signature makes a forgotten resolution a compile error.
 *
 * `fontSize` is MUI's base typography size (default 14); all variants scale
 * proportionally from it.
 */
export function createWhaleTheme(
  mode: 'light' | 'dark',
  presetId: string,
  fontSize = 13,
) {
  const isDark = mode === 'dark';
  const preset = getPreset(presetId);
  const variant = isDark ? preset.dark : preset.light;
  return createTheme({
    palette: {
      mode,
      primary: { main: variant.primary, light: variant.primaryLight },
      secondary: { main: variant.secondary },
      background: {
        default: variant.backgroundDefault,
        paper: variant.backgroundPaper,
      },
      divider: variant.border,
      text: {
        primary: variant.text,
        secondary: variant.textSecondary,
      },
      // Opaque hover/selected background from the design language (UI.md §3):
      // list rows, tree rows, selected states. MUI merges this over its default
      // action tokens (hoverOpacity/selected/etc. stay intact).
      action: {
        hover: variant.hover,
        selected: variant.hover,
      },
    },
    shape: { borderRadius: 8 },
    typography: {
      fontSize,
      fontFamily:
        '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", Arial, sans-serif',
      // Section labels (LOCATIONS / TAG GROUPS / settings headers…) render as
      // `variant="overline"`. UI.md §4 specifies weight 600; MUI's overline
      // default is 400, so bump it here to match the design language.
      overline: { fontWeight: 600 },
    },
    components: {
      MuiButton: { defaultProps: { disableElevation: true } },
      // Global keyboard-focus indicator. MUI's default focus feedback is a
      // near-invisible ripple; only a few views hand-rolled outlines, so Tab
      // trails were lost across most of the app. One override covers every
      // ButtonBase descendant (buttons, icon buttons, toggles, list items…).
      MuiButtonBase: {
        styleOverrides: {
          root: {
            '&.Mui-focusVisible': {
              outline: `2px solid ${variant.primary}`,
              outlineOffset: -2,
            },
          },
        },
      },
    },
  });
}
