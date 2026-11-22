import globalJsdom from 'global-jsdom';

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

const require_ = createRequire(__filename);
const savedModules = new Map<string, NodeJS.Module | undefined>();
let cleanupDom: (() => void) | undefined;
let RevisionHistoryDialog: typeof import('./RevisionHistoryDialog').default;
let confirmMessage: unknown;

const revision = {
  path: 'revision-1',
  timestamp: '2026-07-02T12:00:00.000Z',
  size: 1024,
};

function inject(spec: string, exports: unknown): void {
  const id = require_.resolve(spec);
  if (!savedModules.has(id)) savedModules.set(id, require_.cache[id]);
  require_.cache[id] = {
    id,
    filename: id,
    loaded: true,
    exports,
    children: [],
    paths: [],
  } as unknown as NodeJS.Module;
}

before(async () => {
  cleanupDom = globalJsdom();
  await i18next.use(initReactI18next).init({
    lng: 'zh',
    fallbackLng: 'en',
    resources: {
      zh: {
        translation: {
          revisionHistory: 'Revision history',
          revisionRestoreConfirm: 'Restore the revision from {{time}}?',
          restore: 'Restore',
          delete: 'Delete',
          loading: 'Loading',
          noRevisions: 'No revisions',
          revisionSize: '{{size}}',
        },
      },
    },
    interpolation: { escapeValue: false },
  });

  inject('-/services/ipc-api', {
    ipcApi: {
      listRevisions: async () => [revision],
      restoreRevision: async () => undefined,
      deleteRevision: async () => undefined,
    },
  });
  inject('./ConfirmDialogProvider', {
    useConfirmOptional: () => async (options: { message: unknown }) => {
      confirmMessage = options.message;
      return false;
    },
  });

  RevisionHistoryDialog = (await import('./RevisionHistoryDialog')).default;
});

beforeEach(() => {
  confirmMessage = undefined;
});

afterEach(cleanup);

after(() => {
  cleanupDom?.();
  for (const [id, mod] of savedModules) {
    if (mod) require_.cache[id] = mod;
    else delete require_.cache[id];
  }
});

describe('RevisionHistoryDialog locale dates', () => {
  it('uses the active i18n language in both list and restore confirmation', async () => {
    const expected = new Date(revision.timestamp).toLocaleString('zh');
    const { getByText } = render(
      <I18nextProvider i18n={i18next}>
        <RevisionHistoryDialog
          filePath="D:/notes.txt"
          open
          onClose={() => undefined}
          onRestored={() => undefined}
        />
      </I18nextProvider>
    );

    await waitFor(() => getByText(expected));

    // The first row action is Restore; its Tooltip is not relied on as an
    // accessible name here.
    const restoreButton = document.querySelector('li button');
    assert.ok(restoreButton instanceof HTMLButtonElement);
    fireEvent.click(restoreButton);

    await waitFor(() => {
      assert.equal(confirmMessage, `Restore the revision from ${expected}?`);
    });
  });
});
