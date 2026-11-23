/**
 * Theme plumbing shared by every extension bundle.
 *
 * Each extension is webpack-built on its own and paints its own document, but
 * they all follow the same two conventions:
 *  - the OS colour-scheme preference seeds the very first frame, so a dark host
 *    never flashes a white viewer before the host's `setTheme` envelope lands;
 *  - the live theme is mirrored on `<body data-theme="light|dark">`, which every
 *    extension stylesheet keys off.
 *
 * Both live here so a new viewer needs one import instead of its own copy of
 * the same matchMedia block (this file used to be duplicated across six
 * viewers, and one of them shipped a hardcoded `light` first paint by
 * accident).
 */

export type ThemeMode = 'light' | 'dark';

/** `<body>` attribute the extension stylesheets use for theming. */
export const THEME_ATTRIBUTE = 'data-theme';

/**
 * Guess the host's colour scheme for the first paint, before the host's
 * `setTheme` envelope arrives (a few milliseconds later). `matchMedia` is
 * absent in plain jsdom / very old engines — fall back to light there instead
 * of crashing the viewer.
 */
export function detectInitialTheme(): ThemeMode {
  try {
    if (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    ) {
      return 'dark';
    }
  } catch {
    // jsdom / older engines: fall through to 'light'
  }
  return 'light';
}

/**
 * Paint a theme validated by the caller (the host envelope type guarantees
 * `'light' | 'dark'`) onto the document. Kept tiny on purpose: any viewer that
 * needs more than the attribute — text-editor also reconfigures its CodeMirror
 * highlight theme — wraps this call instead of forking the logic.
 */
export function applyThemeToDocument(theme: ThemeMode): void {
  document.body.setAttribute(THEME_ATTRIBUTE, theme);
}
