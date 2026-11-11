import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import type { SidecarIssue } from '../../shared/ipc-types';

const require_ = createRequire(__filename);
const i18n = i18next.createInstance();
let cleanupDom: (() => void) | undefined;
let SidecarIssuesAlert!: typeof import('./FileList').SidecarIssuesAlert;
let confirmMock: () => Promise<boolean> = async () => false;
let savedConfirmModule: NodeJS.Module | undefined;

const corrupt: SidecarIssue = {
  kind: 'corrupt',
  reason: 'invalid-json',
  dirPath: 'C:\\photos',
  sidecarPath: 'C:\\photos\\.whale\\wsd.json',
  sha256: 'a'.repeat(64),
  size: 10,
};
const unreadable: SidecarIssue = {
  kind: 'unreadable',
  reason: 'io',
  dirPath: 'C:\\shape',
  sidecarPath: 'C:\\shape\\.whale\\wsd.json',
};

before(async () => {
  cleanupDom = globalJsdom();
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: {
      en: {
        translation: {
          sidecarIssuesWarning_one: '{{count}} directory needs attention',
          sidecarIssuesWarning_other: '{{count}} directories need attention',
          sidecarRecoverTitle: 'Back up and clear?',
          sidecarRecoverAction: 'Back up and clear',
          sidecarRecoverMessage: 'Reset only {{dirPath}}; back up original bytes.',
          cancel: 'Cancel',
        },
      },
    },
  });
  const confirmPath = require_.resolve('-/components/ConfirmDialogProvider');
  savedConfirmModule = require_.cache[confirmPath];
  require_.cache[confirmPath] = {
    id: confirmPath,
    filename: confirmPath,
    loaded: true,
    exports: { useConfirm: () => confirmMock },
    children: [],
    paths: [],
  } as NodeJS.Module;
  SidecarIssuesAlert = require_('./FileList').SidecarIssuesAlert;
});

afterEach(() => {
  cleanup();
  confirmMock = async () => false;
});
after(() => {
  const confirmPath = require_.resolve('-/components/ConfirmDialogProvider');
  if (savedConfirmModule) require_.cache[confirmPath] = savedConfirmModule;
  else delete require_.cache[confirmPath];
  cleanupDom?.();
});

function renderAlert({
  issues = [corrupt],
  readOnly = false,
  onNavigate = () => undefined,
  onRecover = async () => undefined,
}: {
  issues?: SidecarIssue[];
  readOnly?: boolean;
  onNavigate?: (dir: string) => void;
  onRecover?: (issue: SidecarIssue) => Promise<void>;
} = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <SidecarIssuesAlert
        issues={issues}
        readOnly={readOnly}
        onNavigate={onNavigate}
        onRecover={onRecover}
      />
    </I18nextProvider>
  );
}

describe('FileList sidecar issue alert', () => {
  it('persists count/directories and navigates without recovery for unreadable/read-only issues', () => {
    const navigated: string[] = [];
    const view = renderAlert({
      issues: [corrupt, unreadable],
      readOnly: true,
      onNavigate: (dir) => navigated.push(dir),
    });
    assert.ok(view.getByTestId('sidecar-issues-warning'));
    assert.ok(view.getByText('2 directories need attention'));
    assert.equal(view.queryByRole('button', { name: 'Back up and clear' }), null);
    fireEvent.click(view.getByRole('button', { name: corrupt.dirPath }));
    assert.deepEqual(navigated, [corrupt.dirPath]);
  });

  it('never offers corrupt-only recovery for an unreadable IO issue', () => {
    const view = renderAlert({ issues: [unreadable], readOnly: false });
    assert.ok(view.getByTestId('sidecar-issues-warning'));
    assert.ok(view.getByText('1 directory needs attention'));
    assert.equal(view.queryByRole('button', { name: 'Back up and clear' }), null);
  });

  it('does not invoke recovery when the confirmation dialog is cancelled', async () => {
    const recovered: SidecarIssue[] = [];
    let confirmations = 0;
    confirmMock = async () => {
      confirmations += 1;
      return false;
    };
    const view = renderAlert({
      onRecover: async (issue) => {
        recovered.push(issue);
      },
    });
    fireEvent.click(view.getByRole('button', { name: 'Back up and clear' }));
    await waitFor(() => assert.equal(confirmations, 1));
    assert.deepEqual(recovered, []);
  });

  it('invokes recovery only after explicit confirmation', async () => {
    const recovered: SidecarIssue[] = [];
    let confirmations = 0;
    confirmMock = async () => {
      confirmations += 1;
      return true;
    };
    const view = renderAlert({
      onRecover: async (issue) => {
        recovered.push(issue);
      },
    });
    fireEvent.click(view.getByRole('button', { name: 'Back up and clear' }));
    await waitFor(() => assert.deepEqual(recovered, [corrupt]));
    assert.equal(confirmations, 1);
  });
});
