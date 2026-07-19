import type { SupportedLanguage } from '-/i18n';
import type { ViewMode } from '../../../shared/whale-meta';
import type { TagShape } from '../../domain/tag-colors';
import type { CustomCallout } from '../../../shared/callout-types';
import type { MdRenderThemePref, MdImageSaveMode } from '../../../shared/extension-types';
import type { KeyAction } from '../../domain/keybindings';

/**
 * Shared settings types/constants — the composed `SettingsState` is the
 * union of the per-domain field interfaces in this directory (docs/01 §12:
 * the 1.2k-line god-slice was split BY DOMAIN with the state shape frozen,
 * so every selector / redux-persist rehydration keeps working unchanged).
 */

/**
 * Persisted UI theme choice. The first three are the classic appearance modes;
 * the additional values are curated full-theme presets that fix both the color
 * palette and the effective light/dark mode (so they render consistently rather
 * than following the OS).
 *
 * `'system'` follows the OS via `matchMedia('(prefers-color-scheme: dark)')`;
 * it is resolved to an effective `'light' | 'dark'` by the theme resolution hook
 * before reaching the theme factory (MUI's `palette.mode` only accepts those two
 * values).
 */
export type ThemeMode =
  | 'light'
  | 'dark'
  | 'system'
  | 'warm-paper'
  | 'midnight-plum'
  | 'frosted-mint'
  | 'deep-ocean'
  | 'dawn-blush'
  | 'forest-ink'
  | 'soft-amber'
  | 'high-contrast';

/** Map tile source for the Mapique perspective. */
export type MapProvider = 'gaode' | 'osm';

/**
 * H.23 P1-3 row-density preset (3 stops). Stored verbatim — the reducer
 * doesn't validate the literal; UI callers pick from this enum. New preset
 * additions must update the helper mapping in FileList (`rowHeightFromDensity`).
 */
export type ListRowDensity = 'compact' | 'normal' | 'comfortable';

/** Fallback grid cell edge (px) used when neither a folder nor settings sets one. */
export const DEFAULT_ENTRY_SIZE = 160;

/**
 * Inclusive bounds for the global view-depth setting. The depth controls how
 * many directory levels `DirectoryContentContextProvider` recurses into when
 * collecting entries (1 = current dir only, 5 = up to 5 levels of
 * subdirectories). The shared slider in `FileToolbar` and any view-local
 * callers (none as of H.24) should clamp to this range.
 */
export const MIN_VIEW_DEPTH = 1;
export const MAX_VIEW_DEPTH = 5;
export const DEFAULT_VIEW_DEPTH = 1;

/** Clamp a candidate depth value into the [1, 5] range. */
export function clampViewDepth(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_VIEW_DEPTH;
  return Math.max(MIN_VIEW_DEPTH, Math.min(MAX_VIEW_DEPTH, Math.trunc(n)));
}

/**
 * Normalizes a filesystem path for comparison/dedup: forward slashes, no
 * trailing slash, lowercased (Whale is Windows-primary, where paths are
 * case-insensitive). Used for the full-text path set.
 */
export function normalizeFsPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Re-export the leaf types the domain field interfaces reference, so each
 *  domain module can import them from one place. */
export type {
  SupportedLanguage,
  ViewMode,
  TagShape,
  CustomCallout,
  MdRenderThemePref,
  MdImageSaveMode,
  KeyAction,
};
