import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from '-/locales/en/common.json';
import zh from '-/locales/zh/common.json';
import zhTW from '-/locales/zh-TW/common.json';
import ja from '-/locales/ja/common.json';
import ko from '-/locales/ko/common.json';

export const SUPPORTED_LANGUAGES = ['en', 'zh', 'zh-TW', 'ja', 'ko'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * i18next setup with the `common` namespace bundled inline (no HTTP backend
 * needed for a desktop app). To add a language: create locales/<lng>/common.json
 * and register it below + in SUPPORTED_LANGUAGES. Plural forms follow
 * i18next v4 suffixes (`_one`/`_other`/...); ja/ko/zh* only need `_other`.
 * scripts/check-locales.test.ts enforces key parity with `en`.
 */
void i18n.use(initReactI18next).init({
  resources: {
    en: { common: en },
    zh: { common: zh },
    'zh-TW': { common: zhTW },
    ja: { common: ja },
    ko: { common: ko },
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
