import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
type TestingLibrary = typeof import('@testing-library/react');
let cleanup: TestingLibrary['cleanup'];
let fireEvent: TestingLibrary['fireEvent'];
let render: TestingLibrary['render'];
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

let PromptDialog: typeof import('./PromptDialog').default;
let cleanupDom: (() => void) | undefined;
before(async () => {
  cleanupDom = globalJsdom();
  ({ cleanup, fireEvent, render } = await import('@testing-library/react'));
  PromptDialog = (await import('./PromptDialog')).default;
  if (typeof document !== 'undefined' && !document.body) {
    const body = document.createElement('body');
    document.documentElement?.appendChild(body);
  }
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: {} } },
  });
});
afterEach(() => cleanup());
after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  cleanupDom?.();
});

describe('PromptDialog IME commit', () => {
  it('ignores composing Enter and keyCode 229', () => {
    const confirmed: string[] = [];
    const view = render(
      <I18nextProvider i18n={i18next}>
        <PromptDialog
          open
          title="Rename"
          label="Name"
          onConfirm={(value) => confirmed.push(value)}
          onClose={() => undefined}
        />
      </I18nextProvider>
    );
    const input = view.getByLabelText('Name');
    fireEvent.change(input, { target: { value: 'draft' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    assert.deepEqual(confirmed, []);

    fireEvent.keyDown(input, { key: 'Enter' });
    assert.deepEqual(confirmed, ['draft']);
  });
});
