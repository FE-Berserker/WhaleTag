import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
type TestingLibrary = typeof import('@testing-library/react');
let cleanup: TestingLibrary['cleanup'];
let fireEvent: TestingLibrary['fireEvent'];
let render: TestingLibrary['render'];
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
let Provider: typeof import('react-redux').Provider;
import { createStore } from 'redux';

let InlineTagInput: typeof import('./InlineTagInput').default;
let cleanupDom: (() => void) | undefined;

before(async () => {
  cleanupDom = globalJsdom();
  ({ Provider } = await import('react-redux'));
  ({ cleanup, fireEvent, render } = await import('@testing-library/react'));
  InlineTagInput = (await import('./InlineTagInput')).default;
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: {} } },
  });
});

afterEach(() => cleanup());
after(() => cleanupDom?.());

describe('InlineTagInput IME commits', () => {
  for (const key of ['Enter', ' ']) {
    it(`ignores composition for ${key === ' ' ? 'Space' : key}`, () => {
      const added: string[] = [];
      const store = createStore(() => ({ settings: { tagShape: 'rounded' } }));
      const view = render(
        <Provider store={store}>
          <I18nextProvider i18n={i18next}>
            <InlineTagInput
              tags={[]}
              tagColors={{}}
              groups={[]}
              t={i18next.t}
              onAdd={(tag) => added.push(tag)}
              onRemove={() => undefined}
            />
          </I18nextProvider>
        </Provider>
      );
      const input = view.getByRole('textbox') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'new-tag' } });
      fireEvent.keyDown(input, { key, isComposing: true });
      fireEvent.keyDown(input, { key, keyCode: 229 });
      assert.deepEqual(added, []);
      assert.equal(input.value, 'new-tag');

      fireEvent.keyDown(input, { key });
      assert.deepEqual(added, ['new-tag']);
      assert.equal(input.value, '');
    });
  }
});
