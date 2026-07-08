import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from '-/locales/en/common.json';
import zh from '-/locales/zh/common.json';

export const SUPPORTED_LANGUAGES = ['en', 'zh'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * i18next setup with the `common` namespace bundled inline (no HTTP backend
 * needed for a desktop app). To add a language: create locales/<lng>/common.json
 * and register it below + in SUPPORTED_LANGUAGES.
 */
void i18n.use(initReactI18next).init({
  resources: {
    en: { common: en },
    zh: { common: zh },
  },
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'common',
  ns: ['common'],
  interpolation: {
    escapeValue: false, // React already escapes.
  },
});

export default i18n;
