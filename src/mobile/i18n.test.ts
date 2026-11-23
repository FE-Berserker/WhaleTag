import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, dictionaries, languages, translate } from './i18n';

describe('mobile i18n', () => {
  it('keeps all five dictionaries aligned with the English messages', () => {
    assert.deepEqual(languages, ['en', 'zh', 'zh-TW', 'ja', 'ko']);
    const keys = Object.keys(dictionaries.en).sort();
    for (const language of languages) {
      assert.deepEqual(Object.keys(dictionaries[language]).sort(), keys, language);
    }
  });

  it('detects supported locales and interpolates messages', () => {
    assert.equal(detectLanguage('zh-CN'), 'zh');
    assert.equal(detectLanguage('zh-Hant-HK'), 'zh-TW');
    assert.equal(detectLanguage('ja-JP'), 'ja');
    assert.equal(detectLanguage('ko-KR'), 'ko');
    assert.equal(detectLanguage('fr-FR'), 'en');
    assert.equal(translate('en', 'items', { count: 3 }), '3 items');
    assert.equal(translate('ko', 'items', { count: 3 }), '항목 3개');
  });
});
