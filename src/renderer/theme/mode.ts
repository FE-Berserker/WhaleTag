import type { ThemeMode } from '-/reducers/settings';
import { THEME_MODE_PRESET_MAP } from '-/theme/presets';

/**
 * Runtime guard for persisted theme values. This module is intentionally not
 * re-exported from the theme barrel: it is shared internally by the resolver
 * and settings migration without widening the public theme API.
 */
export function isThemeMode(value: unknown): value is ThemeMode {
  return (
    value === 'light' ||
    value === 'dark' ||
    value === 'system' ||
    (typeof value === 'string' &&
      Object.prototype.hasOwnProperty.call(THEME_MODE_PRESET_MAP, value))
  );
}
