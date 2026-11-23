import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ConfirmRequest } from './ConfirmDialogProvider';

let cleanupDom: (() => void) | undefined;
let cleanup: typeof import('@testing-library/react').cleanup;
let fireEvent: typeof import('@testing-library/react').fireEvent;
let render: typeof import('@testing-library/react').render;
let I18nextProvider: typeof import('react-i18next').I18nextProvider;
let initReactI18next: typeof import('react-i18next').initReactI18next;
let ConfirmDialogProvider: typeof import('./ConfirmDialogProvider').ConfirmDialogProvider;
let useConfirm: typeof import('./ConfirmDialogProvider').useConfirm;
let i18next: typeof import('i18next').default;

function Trigger({
  request,
  onAsk,
}: {
  request: ConfirmRequest;
  onAsk: (pending: Promise<boolean>) => void;
}) {
  const confirm = useConfirm();
  return (
    <button type="button" onClick={() => onAsk(confirm(request))}>
      ask
    </button>
  );
}

function renderProvider(
  request: ConfirmRequest,
  onAsk: (p: Promise<boolean>) => void
): ReturnType<typeof render> {
  return render(
    <I18nextProvider i18n={i18next}>
      <ConfirmDialogProvider>
        <Trigger request={request} onAsk={onAsk} />
      </ConfirmDialogProvider>
    </I18nextProvider>
  );
}

before(async () => {
  cleanupDom = globalJsdom();
  // Everything that touches the DOM or MUI must load *after* jsdom exists:
  // react-dom's event system captures `window` at import time.
  ({ cleanup, fireEvent, render } = await import('@testing-library/react'));
  ({ I18nextProvider, initReactI18next } = await import('react-i18next'));
  ({ default: i18next } = await import('i18next'));
  ({ ConfirmDialogProvider, useConfirm } = await import('./ConfirmDialogProvider'));

  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: {
      en: {
        translation: {
          confirmTitle: 'Please confirm',
          confirm: 'OK',
          cancel: 'Cancel',
        },
      },
    },
    interpolation: { escapeValue: false },
  });
});

afterEach(() => {
  cleanup();
});

after(() => {
  cleanupDom?.();
});

describe('ConfirmDialogProvider title', () => {
  it('names a title-less confirm with the generic localized title', async () => {
    let pending: Promise<boolean> | null = null;
    const view = renderProvider({ message: 'Remove the folder?' }, (p) => {
      pending = p;
    });

    fireEvent.click(view.getByRole('button', { name: 'ask' }));
    // MUI only wires `aria-labelledby` when a DialogTitle exists, so a
    // title-less confirm used to reach screen readers unnamed.
    const dialog = await view.findByRole('dialog', { name: 'Please confirm' });
    assert.ok(dialog.getAttribute('aria-labelledby'));
    view.getByRole('button', { name: 'Cancel' });
    view.getByRole('button', { name: 'OK' });

    fireEvent.click(view.getByRole('button', { name: 'OK' }));
    assert.equal(await pending, true);
  });

  it('keeps an explicit title when the caller passes one', async () => {
    const view = renderProvider(
      {
        title: 'Delete this?',
        message: 'This cannot be undone.',
        danger: true,
      },
      () => undefined
    );
    fireEvent.click(view.getByRole('button', { name: 'ask' }));
    const dialog = await view.findByRole('dialog', { name: 'Delete this?' });
    assert.ok(dialog.textContent?.includes('This cannot be undone.'));
  });
});
