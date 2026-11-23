import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { cleanup, fireEvent, render } from '@testing-library/react';import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

const require_ = createRequire(__filename);
let settingsDialogId = '';
let savedSettingsDialog: NodeJS.Module | undefined;
let cleanupDom: (() => void) | undefined;

let SettingsDialogProvider: typeof import('./SettingsDialogProvider').SettingsDialogProvider;
let useSettingsDialog: typeof import('./SettingsDialogProvider').useSettingsDialog;

function StubSettingsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return open ? <button onClick={onClose}>stub-close</button> : null;
}

function Probe() {
  const { isOpen, openDialog } = useSettingsDialog();
  return (
    <>
      <span data-testid="settings-state">{isOpen ? 'open' : 'closed'}</span>
      <button onClick={() => openDialog()}>open-settings</button>
    </>
  );
}

before(async () => {
  cleanupDom = globalJsdom();
  settingsDialogId = require_.resolve('./SettingsDialog');
  savedSettingsDialog = require_.cache[settingsDialogId];
  // Replace the ~1900-line real dialog with a stub so this test exercises the
  // provider's lazy/Keyboard wiring, not SettingsDialog's own tree.
  require_.cache[settingsDialogId] = {
    id: settingsDialogId,
    filename: settingsDialogId,
    loaded: true,
    exports: { __esModule: true, default: StubSettingsDialog },
    children: [],
    paths: [],
  } as unknown as NodeJS.Module;

  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: { settings: 'Settings' } } },
    interpolation: { escapeValue: false },
  });

  ({ SettingsDialogProvider, useSettingsDialog } = await import(
    './SettingsDialogProvider'
  ));
});

afterEach(cleanup);

after(() => {
  cleanupDom?.();
  if (savedSettingsDialog) {
    require_.cache[settingsDialogId] = savedSettingsDialog;
  } else {
    delete require_.cache[settingsDialogId];
  }
});

describe('SettingsDialogProvider lazy dialog', () => {
  it('opens the lazily loaded dialog and closes it through onClose', async () => {
    const view = render(
      <I18nextProvider i18n={i18next}>
        <SettingsDialogProvider>
          <Probe />
        </SettingsDialogProvider>
      </I18nextProvider>
    );

    assert.equal(view.getByTestId('settings-state').textContent, 'closed');

    fireEvent.click(view.getByText('open-settings'));
    assert.equal(view.getByTestId('settings-state').textContent, 'open');
    await view.findByText('stub-close');

    fireEvent.click(view.getByText('stub-close'));
    assert.equal(view.getByTestId('settings-state').textContent, 'closed');
    assert.equal(view.queryByText('stub-close'), null);
  });
});
