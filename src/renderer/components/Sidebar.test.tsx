import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
type TestingLibrary = typeof import('@testing-library/react');
let cleanup: TestingLibrary['cleanup'];
let fireEvent: TestingLibrary['fireEvent'];
let render: TestingLibrary['render'];
let waitFor: TestingLibrary['waitFor'];
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
let Provider: typeof import('react-redux').Provider;
import { createStore } from 'redux';

import type { WhaleLocation } from '../../shared/ipc-types';

const require_ = createRequire(__filename);
const savedModules = new Map<string, NodeJS.Module | undefined>();
const notices: string[] = [];
const revealCalls: string[] = [];
let componentId = '';
let cleanupDom: (() => void) | undefined;
let SidebarComponent: typeof import('./Sidebar').default;
let createExcalidraw: () => Promise<void> = async () => undefined;
let createDrawio: () => Promise<void> = async () => undefined;
let revealPath: (path: string) => Promise<void> = async () => undefined;

const location: WhaleLocation = {
  id: 'loc-1',
  name: 'Docs',
  path: '/docs',
  type: 'local',
  isReadOnly: false,
  createdAt: '2026-01-01T00:00:00.000Z',
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
  ({ Provider } = await import('react-redux'));
  ({ cleanup, fireEvent, render, waitFor } = await import(
    '@testing-library/react'
  ));
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: {
      en: {
        translation: {
          operationFailed: 'Operation failed: {{message}}',
          newExcalidraw: 'New Excalidraw',
          newDrawio: 'New Draw.io',
          addLocation: 'Add Location',
          revealInExplorer: 'Reveal in Explorer',
        },
      },
    },
  });
  inject('react-dnd', {
    useDrop: () => [{}, (node: unknown) => node],
    useDrag: () => [{ isDragging: false }, (node: unknown) => node],
  });
  inject('-/hooks/CurrentLocationContextProvider', {
    useCurrentLocationContext: () => ({
      currentLocation: location,
      openLocation: () => undefined,
    }),
  });
  inject('-/hooks/useNewExcalidraw', {
    useNewExcalidraw: () => ({
      available: true,
      canCreate: true,
      create: () => createExcalidraw(),
    }),
  });
  inject('-/hooks/useNewDrawio', {
    useNewDrawio: () => ({
      available: true,
      canCreate: true,
      create: () => createDrawio(),
    }),
  });
  inject('-/services/ipc-api', {
    ipcApi: {
      openTrash: async () => undefined,
      revealPath: (path: string) => {
        revealCalls.push(path);
        return revealPath(path);
      },
    },
  });
  inject('-/services/app-notice', {
    notifyApp: (message: string) => notices.push(message),
  });
  inject('-/components/SettingsDialogProvider', {
    useSettingsDialog: () => ({ openSettings: () => undefined }),
  });
  inject('-/components/ConfirmDialogProvider', {
    useConfirm: () => async () => true,
  });
  inject('-/components/TagGroups', { __esModule: true, default: () => null });
  inject('-/components/TagLibrary', { __esModule: true, default: () => null });

  componentId = require_.resolve('./Sidebar');
  delete require_.cache[componentId];
  SidebarComponent = require_('./Sidebar')
    .default as typeof import('./Sidebar').default;
});

afterEach(() => {
  cleanup();
  notices.length = 0;
  revealCalls.length = 0;
  createExcalidraw = async () => undefined;
  createDrawio = async () => undefined;
  revealPath = async () => undefined;
});
after(() => {
  if (componentId) delete require_.cache[componentId];
  for (const [id, original] of savedModules) {
    if (original) require_.cache[id] = original;
    else delete require_.cache[id];
  }
  cleanupDom?.();
});

function renderSidebar() {
  const store = createStore(() => ({
    locations: { items: [location] },
    settings: {
      defaultLocationId: null,
      taskReminderLocationId: null,
      taskReminderEnabled: false,
    },
  }));
  return render(
    <Provider store={store}>
      <I18nextProvider i18n={i18next}>
        <SidebarComponent onAddLocation={() => undefined} />
      </I18nextProvider>
    </Provider>
  );
}

describe('Sidebar actions', () => {
  it('names creation buttons and surfaces new-file failures', async () => {
    const view = renderSidebar();
    view.getByRole('button', { name: 'Add Location' });
    const excalidraw = view.getByRole('button', { name: 'New Excalidraw' });
    const drawio = view.getByRole('button', { name: 'New Draw.io' });

    createExcalidraw = async () => {
      throw new Error('excalidraw failed');
    };
    fireEvent.click(excalidraw);
    await waitFor(() =>
      assert.deepEqual(notices, ['Operation failed: excalidraw failed'])
    );

    notices.length = 0;
    createDrawio = async () => {
      throw new Error('drawio failed');
    };
    fireEvent.click(drawio);
    await waitFor(() =>
      assert.deepEqual(notices, ['Operation failed: drawio failed'])
    );
  });

  it('surfaces reveal failures from the location menu', async () => {
    const view = renderSidebar();
    const row = view.getByText('Docs').closest('[data-loc-row]');
    assert.ok(row);
    fireEvent.contextMenu(row, { clientX: 20, clientY: 20 });
    const reveal = await view.findByText('Reveal in Explorer');
    revealPath = async () => {
      throw new Error('reveal failed');
    };
    fireEvent.click(reveal);
    await waitFor(() =>
      assert.deepEqual(notices, ['Operation failed: reveal failed'])
    );
    assert.deepEqual(revealCalls, ['/docs']);
  });
});
