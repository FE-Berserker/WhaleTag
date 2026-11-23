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
import { createStore } from 'redux';

let Provider: typeof import('react-redux').Provider;

import type { DirEntry } from '../../shared/ipc-types';

const require_ = createRequire(__filename);
const savedModules = new Map<string, NodeJS.Module | undefined>();
let componentId = '';
let cleanupDom: (() => void) | undefined;
let PropertiesTrayComponent: typeof import('./PropertiesTray').default;
const renameCalls: [string, string][] = [];
const saveMetaCalls: { entry: DirEntry; meta: unknown }[] = [];
const getSaveMetaCalls = (): { entry: DirEntry; meta: unknown }[] =>
  saveMetaCalls;
const directoryContent = {
  tagsByName: new Map<string, string[]>(),
  descByName: new Map<string, string>(),
};
let renameEntryImpl: (path: string, name: string) => Promise<void> = async () =>
  undefined;

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
  ({ cleanup, fireEvent, render, waitFor } = await import(
    '@testing-library/react'
  ));
  ({ Provider } = await import('react-redux'));
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: {
      en: {
        translation: {
          fileProperties: 'File properties',
          columnResizeHandle: 'Resize {{column}} column',
          modified: 'Modified',
          justNow: 'just now',
          nMinutesAgo: '{{count}} minutes ago',
          nHoursAgo: '{{count}} hours ago',
          nDaysAgo: '{{count}} days ago',
        },
      },
    },
    interpolation: { escapeValue: false },
  });

  // The resize contract does not depend on tag metadata or child viewers.
  // Keep this focused by replacing their context requirements, while the real
  // PropertiesTray, Redux selectors, and MUI width styles remain under test.
  inject('-/hooks/DirectoryContentContextProvider', {
    useDirectoryContent: () => directoryContent,
  });
  inject('-/hooks/TagMetaContextProvider', {
    useTagMetaContext: () => ({
      save: async (entry: DirEntry, meta: unknown) => {
        saveMetaCalls.push({ entry, meta });
      },
      saveMany: async () => undefined,
    }),
  });
  inject('-/hooks/IOActionsContextProvider', {
    useIOActionsContext: () => ({
      renameEntry: (path: string, name: string) => {
        renameCalls.push([path, name]);
        return renameEntryImpl(path, name);
      },
    }),
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

afterEach(() => {
  cleanup();
  renameCalls.length = 0;
  saveMetaCalls.length = 0;
  renameEntryImpl = async () => undefined;
});
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

interface RenderTrayOptions {
  entries?: DirEntry[];
  readOnly?: boolean;
  onError?: (message: string) => void;
  /** `settings.listDateFormat` — the P2-7 fix reads it for the modified row. */
  listDateFormat?: 'absolute' | 'relative';
}

function renderTray(
  width = 320,
  captureFails = false,
  options: RenderTrayOptions = {}
) {
  const commits: number[] = [];
  const store = createStore(() => ({
    settings: {
      tagColors: {},
      tagShape: 'rounded',
      listDateFormat: options.listDateFormat,
    },
    taglibrary: { groups: [] },
    workflow: { stages: [] },
  }));
  const view = render(
    <Provider store={store}>
      <I18nextProvider i18n={i18next}>
        <PropertiesTrayComponent
          entries={options.entries ?? entries}
          thumbCache={new Map()}
          readOnly={options.readOnly ?? true}
          width={width}
          onClose={() => undefined}
          onWidthChange={(nextWidth) => commits.push(nextWidth)}
          onOpen={() => undefined}
          onDelete={() => undefined}
          onError={options.onError}
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
    return original.call(document, type, listener, options);
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
    return originalAdd.call(window, type, listener, options);
  } as typeof window.addEventListener;
  window.removeEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ) {
    if (types.has(type)) active -= 1;
    return originalRemove.call(window, type, listener, options);
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

function startRename(view: ReturnType<typeof render>): HTMLInputElement {
  const button = view.getByTestId('EditIcon').closest('button');
  assert.ok(button);
  fireEvent.click(button);
  return view.getByDisplayValue('a.txt') as HTMLInputElement;
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

describe('PropertiesTray keyboard resizing', () => {
  it('exposes separator semantics and adjusts width with arrow keys', () => {
    const { handle, commits } = renderTray();
    assert.equal(handle.getAttribute('role'), 'separator');
    assert.equal(handle.getAttribute('tabindex'), '0');
    assert.equal(handle.getAttribute('aria-orientation'), 'vertical');
    assert.equal(handle.getAttribute('aria-valuemin'), '260');
    assert.equal(handle.getAttribute('aria-valuemax'), '600');
    assert.equal(handle.getAttribute('aria-valuenow'), '320');
    assert.equal(
      handle.getAttribute('aria-label'),
      'Resize File properties column'
    );

    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    assert.deepEqual(commits, []);
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    assert.deepEqual(commits, [330, 310]);
  });

  it('does not bubble list shortcuts from the focused separator', () => {
    const { handle, commits } = renderTray();
    const parentKeys: string[] = [];
    const onParentKeyDown = (event: KeyboardEvent) => parentKeys.push(event.key);
    document.addEventListener('keydown', onParentKeyDown);
    try {
      for (const key of ['ArrowRight', 'Delete', 'F2', 'Tab', 'Enter']) {
        fireEvent.keyDown(handle, { key });
      }
      assert.deepEqual(commits, [310]);
      assert.deepEqual(parentKeys, []);

      fireEvent.keyDown(handle, { key: ',', ctrlKey: true });
      assert.deepEqual(parentKeys, [','], 'Ctrl+, must reach window shortcuts');
      assert.deepEqual(commits, [310]);
    } finally {
      document.removeEventListener('keydown', onParentKeyDown);
    }
  });

  it('clamps keyboard resizing to the existing width limits', () => {
    const minimum = renderTray(260);
    fireEvent.keyDown(minimum.handle, { key: 'ArrowRight' });
    assert.deepEqual(minimum.commits, [260]);
    minimum.view.unmount();

    const maximum = renderTray(600);
    fireEvent.keyDown(maximum.handle, { key: 'ArrowLeft' });
    assert.deepEqual(maximum.commits, [600]);
  });
});

describe('PropertiesTray IME commits and errors', () => {
  it('ignores composing rename commits and reports a real failure', async () => {
    const errors: string[] = [];
    const { view } = renderTray(320, false, {
      entries: [entries[0]],
      readOnly: false,
      onError: (message) => errors.push(message),
    });
    const input = startRename(view);
    fireEvent.change(input, { target: { value: 'renamed.txt' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    assert.deepEqual(renameCalls, []);

    renameEntryImpl = async () => {
      throw new Error('rename failed');
    };
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => assert.deepEqual(errors, ['rename failed']));
    assert.deepEqual(renameCalls, [['/root/a.txt', 'renamed.txt']]);
  });

  it('ignores composing Ctrl+Enter description saves', async () => {
    const { view } = renderTray(320, false, {
      entries: [entries[0]],
      readOnly: false,
    });
    const input = view.getByPlaceholderText('No description');
    fireEvent.change(input, { target: { value: 'Notes' } });
    fireEvent.keyDown(input, {
      key: 'Enter',
      ctrlKey: true,
      isComposing: true,
    });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, keyCode: 229 });
    assert.deepEqual(getSaveMetaCalls(), []);

    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    await waitFor(() => assert.equal(getSaveMetaCalls().length, 1));
    assert.deepEqual(getSaveMetaCalls().map((call) => call.meta), [
      { description: 'Notes' },
    ]);
  });
});

describe('PropertiesTray list date format', () => {

  // P2-7: GridCell and PropertiesTray used to hard-code the absolute form,
  // so a user who picked "relative" in Settings saw it in Row/Calendar but
  // not here. The tray must read `settings.listDateFormat`.
  it('renders the relative form when the setting asks for it', () => {
    const twoDaysAgo = { ...entries[0], modified: new Date(Date.now() - 2 * 86_400_000).toISOString() };
    const { view } = renderTray(320, false, {
      entries: [twoDaysAgo],
      listDateFormat: 'relative',
    });
    assert.ok(
      view.getByText('2 days ago'),
      'the modified row follows the relative setting'
    );
  });

  it('keeps the absolute form when the setting is absolute or unset', () => {
    // `formatDate` is external state (it reads the app's i18n language), so
    // assert on the year instead of a locale-specific rendering.
    const unset = renderTray(320, false, { entries: [entries[0]] });
    assert.equal(unset.view.queryByText(/days ago/), null, 'absolute by default');
    assert.ok(unset.view.getByText(/2026/));
    unset.view.unmount();

    const explicit = renderTray(320, false, {
      entries: [entries[0]],
      listDateFormat: 'absolute',
    });
    assert.equal(explicit.view.queryByText(/days ago/), null);
    assert.ok(explicit.view.getByText(/2026/));
  });
});
