import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import { createRequire } from 'module';
import assert from 'node:assert/strict';
type TestingLibrary = typeof import('@testing-library/react');
let cleanup: TestingLibrary['cleanup'];
let fireEvent: TestingLibrary['fireEvent'];
let render: TestingLibrary['render'];
let waitFor: TestingLibrary['waitFor'];
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

const require_ = createRequire(__filename);
const ipcPath = require_.resolve('-/services/ipc-api');
const savedIpcModule = require_.cache[ipcPath];
let AddLocationDialog: typeof import('./AddLocationDialog').default;
let cleanupDom: (() => void) | undefined;
before(async () => {
  cleanupDom = globalJsdom();
  ({ cleanup, fireEvent, render, waitFor } = await import(
    '@testing-library/react'
  ));
  require_.cache[ipcPath] = {
    id: ipcPath,
    filename: ipcPath,
    loaded: true,
    exports: { ipcApi: { openDirectoryDialog: async () => '/docs' } },
    children: [],
    paths: [],
  } as unknown as NodeJS.Module;
  AddLocationDialog = (await import('./AddLocationDialog')).default;
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
after(() => {
  cleanupDom?.();
  if (savedIpcModule) require_.cache[ipcPath] = savedIpcModule;
  else delete require_.cache[ipcPath];
});

describe('AddLocationDialog IME commit', () => {
  it('does not add a location for a composing Enter', async () => {
    const additions: [string, string, boolean][] = [];
    const view = render(
      <I18nextProvider i18n={i18next}>
        <AddLocationDialog
          open
          onClose={() => undefined}
          onAdd={(name, path, readOnly) =>
            additions.push([name, path, readOnly])
          }
        />
      </I18nextProvider>
    );
    const name = view.getByLabelText('locationName');
    const path = view.getByLabelText('locationPath');
    fireEvent.click(view.getByRole('button', { name: 'browse' }));
    await waitFor(() =>
      assert.equal((path as HTMLInputElement).value, '/docs')
    );
    fireEvent.change(name, { target: { value: 'Documents' } });
    fireEvent.keyDown(name, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(name, { key: 'Enter', keyCode: 229 });
    assert.deepEqual(additions, []);

    fireEvent.keyDown(name, { key: 'Enter' });
    assert.deepEqual(additions, [['Documents', '/docs', false]]);
  });
});
