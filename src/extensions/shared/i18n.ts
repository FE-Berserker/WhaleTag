/**
 * Locale plumbing shared by extension bundles.
 *
 * `extension-api.js` owns the catalog fallback (locale → base language → `en`)
 * and re-broadcasts the host's `setLocale`; these helpers wrap the two lines
 * every viewer used to repeat by hand:
 *
 *     T = window.whaleExt.t(I18N);
 *     document.documentElement.lang = window.whaleExt.locale;
 *
 * Mirroring the locale onto `<html lang>` matters for a11y (screen readers pick
 * the right voice) and for `:lang()` rules in the shared stylesheets, so it is
 * easy to forget when hand-rolling a new viewer.
 */

/** The host's current UI locale (e.g. `en`, `zh`, `zh-CN`). */
export function currentLocale(): string {
  return window.whaleExt.locale;
}

/** Mirror the host locale onto `<html lang>` and return it. */
export function syncDocumentLocale(): string {
  const locale = currentLocale();
  document.documentElement.lang = locale;
  return locale;
}

/** Resolve a `{ en: {...}, zh: {...} }` catalog for the current locale. */
export function pickStrings<T>(catalog: Record<string, T>): T {
  return window.whaleExt.t(catalog);
}

/** Subscribe to host locale changes (fires immediately with the current one). */
export function onLocaleChange(handler: () => void): () => void {
  return window.whaleExt.onLocale(handler);
}
