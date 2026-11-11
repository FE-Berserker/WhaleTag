import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { cleanup, fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { Provider } from 'react-redux';
import { createStore } from 'redux';

import type { DirEntry } from '../../shared/ipc-types';

const require_ = createRequire(__filename);
const savedModules = new Map<string, NodeJS.Module | undefined>();
let componentId = '';
let cleanupDom: (() => void) | undefined;
let PropertiesTrayComponent: typeof import('./PropertiesTray').default;

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
  } as NodeJS.Module;
}

before(async () => {
  cleanupDom = globalJsdom();
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: {} } },
    interpolation: { escapeValue: false },
  });

  // The resize contract does not depend on tag metadata or child viewers.
  // Keep this focused by replacing their context requirements, while the real
  // PropertiesTray, Redux selectors, and MUI width styles remain under test.
  inject('-/hooks/DirectoryContentContextProvider', {
    useDirectoryContent: () => ({
      tagsByName: new Map<string, string[]>(),
      descByName: new Map<string, string>(),
    }),
  });
  inject('-/hooks/TagMetaContextProvider', {
    useTagMetaContext: () => ({
      save: async () => undefined,
      saveMany: async () => undefined,
    }),
  });
  inject('-/hooks/IOActionsContextProvider', {
    useIOActionsContext: () => ({ renameEntry: async () => undefined }),
  });
  inject('-/components/PeriodTagDialog', {
    usePeriodTagDialog: () => ({ openDialog: () => undefined }),
  });
  inject('-/hooks/useTagDisplayLabels', {
    useTagDisplayLabels: (tags: string[]) => tags,
  });
  inject('-/hooks/useNow', { useNow: () => new Date('2026-01-01T00:00:00Z') });
  inject('-/components/ThumbIcon', {
    __esModule: true,
    default: () => null,
  });
  inject('-/components/InlineTagInput', {
    __esModule: true,
    default: () => null,
  });
  inject('-/components/TagMetaDialog', {
    __esModule: true,
    default: () => null,
  });
  inject('-/components/QuickTagChips', {
    SmartTagChip: () => null,
    StageChip: () => null,
    PeriodChip: () => null,
  });

  componentId = require_.resolve('./PropertiesTray');
  delete require_.cache[componentId];
  PropertiesTrayComponent = require_('./PropertiesTray')
    .default as typeof import('./PropertiesTray').default;
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

const entries = ['/root/a.txt', '/root/b.txt'].map(
  (path) =>
    ({
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      isDirectory: false,
      isFile: true,
      size: 1,
      extension: 'txt',
      modified: '2026-01-01T00:00:00.000Z',
    }) as DirEntry
);

function renderTray(width = 320, captureFails = false) {
  const commits: number[] = [];
  const store = createStore(() => ({
    settings: { tagColors: {}, tagShape: 'rounded' },
    taglibrary: { groups: [] },
    workflow: { stages: [] },
  }));
  const view = render(
    <Provider store={store}>
      <I18nextProvider i18n={i18next}>
        <PropertiesTrayComponent
          entries={entries}
          thumbCache={new Map()}
          readOnly
          width={width}
          onClose={() => undefined}
          onWidthChange={(nextWidth) => commits.push(nextWidth)}
          onOpen={() => undefined}
          onDelete={() => undefined}
        />
      </I18nextProvider>
    </Provider>
  );
  const root = view.container.firstElementChild as HTMLElement;
  const handle = view.getByTestId('properties-tray-resize-handle');
  const capture = { set: 0, release: 0 };
  handle.setPointerCapture = () => {
    capture.set += 1;
    if (captureFails) throw new Error('pointer capture unavailable');
  };
  handle.releasePointerCapture = () => {
    capture.release += 1;
  };
  return { view, root, handle, commits, capture };
}

function watchDocumentDragListeners() {
  const original = document.addEventListener;
  const types = new Set([
    'mousemove',
    'mouseup',
    'pointermove',
    'pointerup',
    'pointercancel',
    'lostpointercapture',
  ]);
  let additions = 0;
  document.addEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) {
    if (types.has(type)) additions += 1;
    return original.call(this, type, listener, options);
  } as typeof document.addEventListener;
  return {
    get additions() {
      return additions;
    },
    restore() {
      document.addEventListener = original;
    },
  };
}

function watchWindowFallbackListeners() {
  const originalAdd = window.addEventListener;
  const originalRemove = window.removeEventListener;
  const types = new Set(['pointerup', 'pointercancel']);
  let active = 0;
  window.addEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) {
    if (types.has(type)) active += 1;
    return originalAdd.call(this, type, listener, options);
  } as typeof window.addEventListener;
  window.removeEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ) {
    if (types.has(type)) active -= 1;
    return originalRemove.call(this, type, listener, options);
  } as typeof window.removeEventListener;
  return {
    get active() {
      return active;
    },
    restore() {
      window.addEventListener = originalAdd;
      window.removeEventListener = originalRemove;
    },
  };
}

describe('PropertiesTray pointer resizing', () => {
  it('previews moves locally, preserves the clamp, and commits once per drag', () => {
    const listeners = watchDocumentDragListeners();
    try {
      const { root, handle, commits, capture } = renderTray();
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 400 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 370 });
      assert.equal(window.getComputedStyle(root).width, '350px');
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 340 });
      assert.equal(window.getComputedStyle(root).width, '380px');
      assert.deepEqual(commits, [], 'pointermoves must not persist');
      fireEvent.pointerUp(handle, { pointerId: 1, clientX: 300 });
      assert.deepEqual(commits, [420]);
      assert.equal(window.getComputedStyle(root).width, '320px');
      assert.equal(capture.release, 1);

      // A second independent gesture exercises the unchanged 600px maximum.
      fireEvent.pointerDown(handle, { pointerId: 2, clientX: 400 });
      fireEvent.pointerMove(handle, { pointerId: 2, clientX: -500 });
      assert.equal(window.getComputedStyle(root).width, '600px');
      assert.deepEqual(commits, [420]);
      fireEvent.pointerUp(handle, { pointerId: 2, clientX: -500 });
      assert.deepEqual(commits, [420, 600]);
      assert.equal(capture.set, 2);
      assert.equal(capture.release, 2);
      assert.equal(listeners.additions, 0);
    } finally {
      listeners.restore();
    }
  });

  it('handles window up/cancel and unmount when pointer capture fails', () => {
    const { view, root, handle, commits } = renderTray(320, true);
    const listeners = watchWindowFallbackListeners();
    try {
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 400 });
      assert.equal(listeners.active, 2);
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 340 });
      assert.equal(window.getComputedStyle(root).width, '380px');
      assert.deepEqual(commits, []);

      fireEvent.pointerUp(window, { pointerId: 1, clientX: 300 });
      assert.deepEqual(commits, [420]);
      assert.equal(listeners.active, 0);
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 300 });
      assert.equal(commits.length, 1, 'a removed fallback cannot commit twice');

      fireEvent.pointerDown(handle, { pointerId: 2, clientX: 400 });
      assert.equal(listeners.active, 2);
      fireEvent.pointerCancel(window, { pointerId: 2, clientX: 300 });
      assert.equal(listeners.active, 0);
      assert.equal(commits.length, 1, 'window cancellation must not commit');

      fireEvent.pointerDown(handle, { pointerId: 3, clientX: 400 });
      assert.equal(listeners.active, 2);
      view.unmount();
      assert.equal(listeners.active, 0);
      fireEvent.pointerUp(window, { pointerId: 3, clientX: 300 });
      assert.equal(commits.length, 1, 'unmount must remove the fallback');
    } finally {
      listeners.restore();
    }
  });

  it('restores the controlled width on pointercancel and lost capture', () => {
    const listeners = watchDocumentDragListeners();
    try {
      const { root, handle, commits } = renderTray();
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 400 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 350 });
      assert.equal(window.getComputedStyle(root).width, '370px');
      fireEvent.pointerCancel(handle, { pointerId: 1, clientX: 350 });
      assert.equal(window.getComputedStyle(root).width, '320px');
      assert.deepEqual(commits, []);

      fireEvent.pointerDown(handle, { pointerId: 2, clientX: 400 });
      fireEvent.pointerMove(handle, { pointerId: 2, clientX: 360 });
      assert.equal(window.getComputedStyle(root).width, '360px');
      fireEvent.lostPointerCapture(handle, { pointerId: 2, clientX: 360 });
      assert.equal(window.getComputedStyle(root).width, '320px');
      assert.deepEqual(commits, []);
      assert.equal(listeners.additions, 0);
    } finally {
      listeners.restore();
    }
  });

  it('cancels an active drag on unmount without leaking listeners', () => {
    const listeners = watchDocumentDragListeners();
    try {
      const { view, handle, commits, capture } = renderTray();
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 400 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 350 });
      view.unmount();
      assert.deepEqual(commits, []);
      assert.equal(capture.release, 1);
      fireEvent.pointerUp(document, { pointerId: 1, clientX: 350 });
      assert.deepEqual(commits, []);
      assert.equal(listeners.additions, 0);
    } finally {
      listeners.restore();
    }
  });
});
