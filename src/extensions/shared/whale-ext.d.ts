/**
 * Ambient global type for the `window.whaleExt` API that extension-api.js injects
 * into every extension iframe. Declared once here so all extensions share the
 * same shape (including the locale helpers); individual extension entry files no
 * longer redeclare it.
 */
import type { HostMessage } from '../../shared/extension-types';

declare global {
  interface Window {
    whaleExt: {
      postMessage: (msg: { type: string; [key: string]: unknown }) => void;
      onMessage: (handler: (msg: HostMessage) => void) => () => void;
      manifest: Record<string, unknown>;
      /** Current host UI locale (e.g. 'en', 'zh'); 'en' until the first setLocale. */
      locale: string;
      /** Subscribe to locale changes; fires immediately with the current locale. */
      onLocale: (handler: (locale: string) => void) => () => void;
      /** Pick a catalog entry for the current locale, falling back to the base
       *  language tag then to `en`. catalog = { en: {...}, zh: {...} }. */
      t: <T>(catalog: Record<string, T>) => T;
    };
  }
}

export {};
