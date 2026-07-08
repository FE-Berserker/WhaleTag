import { useEffect, useState } from 'react';
import type { ThemeMode } from '-/reducers/settings';
import { DEFAULT_PRESET_ID, THEME_MODE_PRESET_MAP } from '-/theme/presets';

/**
 * The effective palette mode — always `'light' | 'dark'`, never `'system'` or
 * one of the curated full-theme modes.
 *
 * This is what MUI's `palette.mode` (and thus `createWhaleTheme`) accepts.
 */
export type ResolvedThemeMode = 'light' | 'dark';

/**
 * The effective theme parameters derived from a persisted {@link ThemeMode}:
 * - `mode`: concrete `'light' | 'dark'` for MUI.
 * - `presetId`: the color preset to render (`whale` for classic modes, or the
 *   matching preset for curated full-theme modes).
 */
export interface ResolvedTheme {
  mode: ResolvedThemeMode;
  presetId: string;
}

const MEDIA_QUERY = '(prefers-color-scheme: dark)';

/** Fixed mapping from curated full-theme modes to their preset + mode. */
const THEME_MODE_PRESETS = THEME_MODE_PRESET_MAP;

/**
 * Resolves a persisted {@link ThemeMode} into the effective MUI mode and the
 * color preset id that should be used.
 *
 * For `'system'`, subscribes to `matchMedia('(prefers-color-scheme: dark)')`
 * and re-renders live as the OS theme changes. The subscription is established
 * only while `'system'` is active, so fixed-mode users pay no ongoing listener
 * cost.
 *
 * The resolved values are **derived only — never persisted**. Persisting them
 * would make `'system'` sticky on whichever mode was active at quit time.
 */
export function useResolvedTheme(mode: ThemeMode): ResolvedTheme {
  const [systemDark, setSystemDark] = useState<boolean>(() => readSystemDark());

  useEffect(() => {
    if (mode !== 'system') return; // subscribe only when actually needed
    const mql = safeMatchMedia(MEDIA_QUERY);
    if (!mql) return;
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [mode]);

  if (mode === 'light') return { mode: 'light', presetId: DEFAULT_PRESET_ID };
  if (mode === 'dark') return { mode: 'dark', presetId: DEFAULT_PRESET_ID };
  if (mode === 'system')
    return { mode: systemDark ? 'dark' : 'light', presetId: DEFAULT_PRESET_ID };

  return THEME_MODE_PRESETS[mode];
}

/**
 * Backward-compatible shorthand that returns only the effective MUI mode.
 * Extension views and other consumers that only need `'light' | 'dark'` can
 * continue using this.
 */
export function useResolvedThemeMode(mode: ThemeMode): ResolvedThemeMode {
  return useResolvedTheme(mode).mode;
}

function readSystemDark(): boolean {
  const mql = safeMatchMedia(MEDIA_QUERY);
  return mql ? mql.matches : false;
}

function safeMatchMedia(query: string): MediaQueryList | null {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return null;
    }
    return window.matchMedia(query);
  } catch {
    return null;
  }
}
