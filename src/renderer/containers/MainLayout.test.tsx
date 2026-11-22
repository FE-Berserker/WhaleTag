import globalJsdom from 'global-jsdom';

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import type { ReactNode } from 'react';

type TestingLibrary = typeof import('@testing-library/react');
let cleanup: TestingLibrary['cleanup'];
let fireEvent: TestingLibrary['fireEvent'];
let render: TestingLibrary['render'];
let waitFor: TestingLibrary['waitFor'];

const require_ = createRequire(__filename);
const savedModules = new Map<string, NodeJS.Module | undefined>();
let cleanupDom: (() => void) | undefined;
let componentId = '';
let MainLayout: typeof import('./MainLayout').default;
let panelShouldFail = true;
const activated: string[] = [];
const closed: string[] = [];
const extensionState = {
  activeView: { filePath: '/one.excalidraw' } as { filePath: string } | null,
  activeTabId: 'one' as string | null,
  tabs: [
    { id: 'one', title: 'One', filePath: '/one.excalidraw', manifest: {} },
    { id: 'two', title: 'Two', filePath: '/two.excalidraw', manifest: {} },
  ],
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

function PassChildren({ children }: { children: ReactNode }) {
  return children;
}

function Empty(): null {
  return null;
}

before(async () => {
  cleanupDom = globalJsdom();
  ({ cleanup, fireEvent, render, waitFor } = await import(
    '@testing-library/react'
  ));
  inject('react-redux', {
    useDispatch: () => () => undefined,
    useSelector: (
      selector: (state: {
        settings: { themeMode: string };
        extensions: { editState: Record<string, { dirty: boolean }> };
      }) => unknown
    ) =>
      selector({
        settings: { themeMode: 'light' },
        extensions: { editState: {} },
      }),
  });
  inject('react-i18next', {
    useTranslation: () => ({ t: (key: string) => key }),
  });
  inject('-/hooks/CurrentLocationContextProvider', {
    useCurrentLocationContext: () => ({ currentLocation: { path: '/root' } }),
  });
  inject('-/hooks/ExtensionContextProvider', {
    useExtensionContext: () => ({
      ...extensionState,
      activateTab: (id: string) => {
        activated.push(id);
        extensionState.activeTabId = id;
      },
      closeTab: async (id: string) => {
        closed.push(id);
        return 'closed';
      },
    }),
  });
  inject('-/hooks/FileSelectionContextProvider', {
    FileSelectionProvider: PassChildren,
  });
  inject('-/components/PeriodTagDialog', {
    PeriodTagDialogProvider: PassChildren,
  });
  inject('-/components/SettingsDialogProvider', {
    SettingsDialogProvider: PassChildren,
  });
  inject('-/theme/useResolvedThemeMode', {
    useResolvedThemeMode: () => 'light',
  });
  inject('-/components/Sidebar', {
    __esModule: true,
    default: Empty,
    SidebarActionsBar: Empty,
  });
  for (const spec of [
    '-/components/DirectoryTree',
    '-/components/FileToolbar',
    '-/components/TitleBar',
    '-/components/WelcomePanel',
    '-/components/AddLocationDialog',
    '-/components/McpApprovalDialog',
  ]) {
    inject(spec, { __esModule: true, default: Empty });
  }
  inject('-/components/FileList', {
    __esModule: true,
    default: () => <div>FileList mounted</div>,
  });
  inject('-/components/ExtensionTabBar', {
    __esModule: true,
    default: ({
      onActivate,
      onClose,
    }: {
      onActivate: (id: string) => void;
      onClose: (id: string) => void;
    }) => (
      <>
        <button type="button" onClick={() => onActivate('two')}>
          Switch extension tab
        </button>
        <button type="button" onClick={() => onClose('one')}>
          Close extension tab
        </button>
      </>
    ),
  });
  inject('-/components/ExtensionViewPanel', {
    __esModule: true,
    default: () => {
      if (panelShouldFail) throw new Error('extension chunk failed');
      return <div>Extension panel recovered</div>;
    },
  });

  componentId = require_.resolve('./MainLayout');
  delete require_.cache[componentId];
  MainLayout = require_('./MainLayout').default as typeof import('./MainLayout').default;
});

beforeEach(() => {
  panelShouldFail = true;
  extensionState.activeView = { filePath: '/one.excalidraw' };
  extensionState.activeTabId = 'one';
  activated.length = 0;
  closed.length = 0;
});

afterEach(() => cleanup());
after(() => {
  if (componentId) delete require_.cache[componentId];
  for (const [id, original] of savedModules) {
    if (original) require_.cache[id] = original;
    else delete require_.cache[id];
  }
  cleanupDom?.();
});

describe('MainLayout extension lazy recovery', () => {
  it('keeps tab controls reachable without remounting healthy tabs on a switch', async (t) => {
    t.mock.method(console, 'error', () => undefined);
    const view = render(<MainLayout />);
    await waitFor(() => assert.ok(view.getByText('errorOccurred')));
    assert.ok(view.getByText('FileList mounted'));

    fireEvent.click(view.getByRole('button', { name: 'Close extension tab' }));
    assert.deepEqual(closed, ['one']);

    panelShouldFail = false;
    fireEvent.click(view.getByRole('button', { name: 'Switch extension tab' }));
    // The real provider rerenders consumers after activateTab updates its state.
    view.rerender(<MainLayout />);
    assert.deepEqual(activated, ['two']);
    assert.ok(view.getByText('errorOccurred'));
    assert.equal(view.queryByText('Extension panel recovered'), null);
    assert.ok(view.getByText('FileList mounted'));
  });

  it('rearms the lazy panel after the last tab is closed', async (t) => {
    t.mock.method(console, 'error', () => undefined);
    const view = render(<MainLayout />);
    await waitFor(() => assert.ok(view.getByText('errorOccurred')));

    panelShouldFail = false;
    extensionState.activeTabId = null;
    view.rerender(<MainLayout />);

    await waitFor(() =>
      assert.ok(view.getByText('Extension panel recovered'))
    );
    assert.equal(view.queryByText('errorOccurred'), null);
  });

  it('retries the lazy panel from the local fallback', async (t) => {
    t.mock.method(console, 'error', () => undefined);
    const view = render(<MainLayout />);
    await waitFor(() => assert.ok(view.getByText('errorOccurred')));

    panelShouldFail = false;
    fireEvent.click(view.getByRole('button', { name: 'retry' }));
    await waitFor(() =>
      assert.ok(view.getByText('Extension panel recovered'))
    );
  });
});
