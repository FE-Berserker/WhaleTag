import globalJsdom from 'global-jsdom';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type {
  ExtensionManifest,
  ExtensionMessage,
  HostMessage,
} from '../../shared/extension-types';

const require_ = createRequire(__filename);
const IPC_API_MODULE = '-/services/ipc-api';
const HOST_MODULE = './ExtensionHost';
const BINARY_BASE64 = 'AAECf4D+/w==';

let readImageFileAsDataUrl: (filePath: string) => Promise<string>;
let readFileBase64Impl: (filePath: string) => Promise<string>;
let base64Calls: string[];
let legacyReadCalls: number;
let btoaCalls: number;
let originalBtoa: typeof globalThis.btoa | undefined;
let ExtensionHostComponent: typeof import('./ExtensionHost').default;
let jsdomCleanup: (() => void) | null = null;
let writeFileWithRevisionImpl: (filePath: string, content: string) => Promise<void>;
let renameImpl: (from: string, to: string) => Promise<void>;
let closeTabImpl: (tabId: string) => Promise<'closed' | 'cancelled'>;
let openWithExtensionImpl: (entry: { path: string }, manifest: { id: string }) => Promise<void>;
type SaveCurrent = () => Promise<boolean>;
const registeredSaveHandlers = new Map<string, SaveCurrent>();
const hostNotices: string[] = [];
const renameCalls: Array<{ from: string; to: string }> = [];
const closeTabCalls: string[] = [];
const openWithExtensionCalls: string[] = [];
const capturedSelectors: Array<(state: unknown) => unknown> = [];
type HostAction = {
  type: string;
  payload?: { state?: { dirty?: boolean; saving?: boolean } };
};
const dispatchedActions: HostAction[] = [];
const hostEditState = { dirty: true, saving: false };

const savedCache = new Map<string, NodeJS.Module | undefined>();
/** Contents `handleSave` handed back to the provider after a successful write. */
const markedSavedContent = new Map<string, string>();

function injectMock(moduleName: string, exports: unknown): void {
  const modulePath = require_.resolve(moduleName);
  savedCache.set(modulePath, require_.cache[modulePath]);
  const existing = require_.cache[modulePath];
  require_.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
    children: existing?.children ?? [],
    paths: existing?.paths ?? [],
  } as NodeJS.Module;
}

before(() => {
  jsdomCleanup = globalJsdom() as unknown as () => void;
  base64Calls = [];
  legacyReadCalls = 0;
  btoaCalls = 0;
  markedSavedContent.clear();
  readFileBase64Impl = async () => BINARY_BASE64;
  writeFileWithRevisionImpl = async () => {};
  renameImpl = async () => {};
  closeTabImpl = async () => 'closed';
  openWithExtensionImpl = async () => {};
  injectMock(IPC_API_MODULE, {
    ipcApi: {
      readFileBase64: (filePath: string) => readFileBase64Impl(filePath),
      readFile: async () => {
        legacyReadCalls += 1;
        throw new Error('legacy byte-array read must not be used');
      },
      writeFileWithRevision: (filePath: string, content: string) =>
        writeFileWithRevisionImpl(filePath, content),
      rename: (from: string, to: string) => {
        renameCalls.push({ from, to });
        return renameImpl(from, to);
      },
    },
  });
  injectMock('-/services/app-notice', {
    notifyApp: (message: string) => {
      hostNotices.push(message);
    },
  });
  injectMock('react-redux', {
    useDispatch: () => (action: HostAction) => {
      dispatchedActions.push(action);
      return action;
    },
    useSelector: (
      selector: (state: {
        extensions: { editState: Record<string, typeof hostEditState> };
      }) => unknown
    ) => {
      capturedSelectors.push(selector as (state: unknown) => unknown);
      return selector({
        extensions: { editState: { 'tab-1': hostEditState } },
      });
    },
  });
  injectMock('react-i18next', {
    useTranslation: () => ({
      t: (key: string, options?: { message?: string }) =>
        options?.message ? `${key}: ${options.message}` : key,
      i18n: { language: 'en' },
    }),
  });
  injectMock('-/hooks/ExtensionContextProvider', {
    useExtensionContext: () => ({
      openWithExtension: (entry: { path: string }, manifest: { id: string }) => {
        openWithExtensionCalls.push(entry.path);
        return openWithExtensionImpl(entry, manifest);
      },
      requestCloseCurrent: () => {},
      closeTab: (tabId: string) => {
        closeTabCalls.push(tabId);
        return closeTabImpl(tabId);
      },
      registerSaveCurrent: (tabId: string, handler: SaveCurrent | null) => {
        if (handler) registeredSaveHandlers.set(tabId, handler);
        else registeredSaveHandlers.delete(tabId);
      },
      markTabSavedContent: (tabId: string, content: string) => {
        markedSavedContent.set(tabId, content);
      },
    }),
  });
  injectMock('-/hooks/DirectoryContentContextProvider', {
    useDirectoryUI: () => ({ refresh: () => {} }),
  });
  injectMock('-/hooks/DirectoryTreeRefreshContextProvider', {
    useDirectoryTreeRefresh: () => ({ refreshTree: () => {} }),
  });
  injectMock('./extension-host/rpc-cases', {
    createRpcHandler: () => () => false,
  });
  injectMock('-/components/PromptDialog', {
    __esModule: true,
    default: (props: {
      open: boolean;
      onConfirm: (value: string) => void;
    }) =>
      props.open
        ? createElement(
            'button',
            {
              'data-testid': 'rename-confirm',
              onClick: () => props.onConfirm('renamed.txt'),
            },
            'confirm'
          )
        : null,
  });
  try {
    delete require_.cache[require_.resolve(HOST_MODULE)];
  } catch {
    // The host has not been loaded yet.
  }
  ({ readImageFileAsDataUrl, default: ExtensionHostComponent } = require_(HOST_MODULE));

  originalBtoa = globalThis.btoa;
  globalThis.btoa = () => {
    btoaCalls += 1;
    throw new Error('renderer base64 encoding must not be used');
  };
});

afterEach(() => {
  cleanup();
  dispatchedActions.length = 0;
  hostNotices.length = 0;
  registeredSaveHandlers.clear();
  writeFileWithRevisionImpl = async () => {};
  renameImpl = async () => {};
  closeTabImpl = async () => 'closed';
  openWithExtensionImpl = async () => {};
  renameCalls.length = 0;
  closeTabCalls.length = 0;
  openWithExtensionCalls.length = 0;
  capturedSelectors.length = 0;
  hostEditState.dirty = true;
});

after(() => {
  cleanup();
  jsdomCleanup?.();
  if (originalBtoa) globalThis.btoa = originalBtoa;
  else delete (globalThis as { btoa?: typeof globalThis.btoa }).btoa;
  for (const [modulePath, original] of savedCache.entries()) {
    if (original) require_.cache[modulePath] = original;
    else delete require_.cache[modulePath];
  }
  try {
    delete require_.cache[require_.resolve(HOST_MODULE)];
  } catch {
    // Nothing to clear.
  }
});

describe('ExtensionHost image embed base64 transport', () => {
  it('uses the Main base64 string verbatim, without byte reads or btoa', async () => {
    base64Calls = [];
    legacyReadCalls = 0;
    btoaCalls = 0;
    readFileBase64Impl = async (filePath) => {
      base64Calls.push(filePath);
      return BINARY_BASE64;
    };

    const result = await readImageFileAsDataUrl('/root/pixel.png');

    assert.equal(result, `data:image/png;base64,${BINARY_BASE64}`);
    assert.deepEqual(base64Calls, ['/root/pixel.png']);
    assert.equal(legacyReadCalls, 0);
    assert.equal(btoaCalls, 0);
  });

  it('maps every supported original-image extension to its actual MIME type', async () => {
    readFileBase64Impl = async () => BINARY_BASE64;
    const cases = [
      ['avif', 'image/avif'],
      ['tiff', 'image/tiff'],
      ['tif', 'image/tiff'],
      ['ico', 'image/x-icon'],
    ];
    for (const [extension, mime] of cases) {
      assert.equal(
        await readImageFileAsDataUrl(`/root/pixel.${extension}`),
        `data:${mime};base64,${BINARY_BASE64}`
      );
    }
  });

  it('keeps read failures rejecting into the existing generic-icon fallback', async () => {
    legacyReadCalls = 0;
    btoaCalls = 0;
    readFileBase64Impl = async () => {
      throw new Error('read denied');
    };

    await assert.rejects(readImageFileAsDataUrl('/root/pixel.png'), /read denied/);
    assert.equal(legacyReadCalls, 0);
    assert.equal(btoaCalls, 0);
  });
});

describe('ExtensionHost revision protocol', () => {
  const filePath = '/tmp/host.txt';
  const manifest: ExtensionManifest = {
    id: 'text-editor',
    name: 'Text Editor',
    type: 'editor',
    color: '#000000',
    fileTypes: ['txt'],
    entryPoint: 'index.html',
    enabled: true,
    isDefault: true,
  };

  function renderHost(
    overrides: { readOnly?: boolean; filePath?: string; fileContent?: string } = {}
  ) {
    const props = {
      tabId: 'tab-1',
      manifest,
      filePath: overrides.filePath ?? filePath,
      fileContent: overrides.fileContent ?? 'disk',
      encoding: 'utf8' as const,
      readOnly: overrides.readOnly ?? false,
      theme: 'light' as const,
      onRequestRevisionHistory: () => {},
    };
    const view = render(createElement(ExtensionHostComponent, props));
    const posted: HostMessage[] = [];
    let iframe: HTMLIFrameElement | null = null;
    const wireCurrentIframe = () => {
      const next = document.querySelector('iframe');
      assert.ok(next);
      if (next === iframe) return;
      iframe = next;
      Object.defineProperty(iframe.contentWindow, 'postMessage', {
        configurable: true,
        value: (envelope: { message: HostMessage }) => {
          posted.push(envelope.message);
        },
      });
    };
    wireCurrentIframe();
    const emit = (message: ExtensionMessage) => {
      wireCurrentIframe();
      act(() => {
        window.dispatchEvent(new window.MessageEvent('message', {
          source: iframe?.contentWindow,
          data: { protocolVersion: 1, source: 'extension', message },
        }));
      });
    };
    emit({ type: 'ready' });
    const saveCurrent = () => {
      const handler = registeredSaveHandlers.get(props.tabId);
      assert.ok(handler, 'host must register its close-save handler');
      return handler();
    };
    return { view, props, posted, emit, saveCurrent };
  }

  it('sends only setReadOnly when view permissions change', () => {
    const { view, props, posted } = renderHost();
    assert.equal(posted.filter((msg) => msg.type === 'fileContent').length, 1);
    posted.length = 0;

    view.rerender(createElement(ExtensionHostComponent, { ...props, readOnly: true }));

    assert.deepEqual(posted, [{ type: 'setReadOnly', readOnly: true }]);
    assert.equal(posted.some((msg) => msg.type === 'fileContent'), false);
  });

  it('skips the identical fs.watch readback after save but loads real external edits', async () => {
    const { view, props, posted, emit } = renderHost();
    posted.length = 0;

    emit({
      type: 'parentSaveDocument',
      path: filePath,
      content: 'saved locally',
      revision: 1,
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    view.rerender(createElement(ExtensionHostComponent, {
      ...props,
      fileContent: 'saved locally',
    }));
    assert.equal(
      posted.some((msg) => msg.type === 'fileContent'),
      false,
      'the host must not reload the editor for its own successful write'
    );

    view.rerender(createElement(ExtensionHostComponent, {
      ...props,
      fileContent: 'external edit',
    }));
    const reloads = posted.filter((msg) => msg.type === 'fileContent');
    assert.equal(reloads.length, 1);
    assert.equal(reloads[0].type === 'fileContent' && reloads[0].content, 'external edit');
  });

  it('does not suppress a later external edit back to the last self-saved bytes', async () => {
    const { view, props, posted, emit } = renderHost({ fileContent: 'saved locally' });
    posted.length = 0;
    emit({ type: 'parentSaveDocument', path: filePath, content: 'B', revision: 1 });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    view.rerender(createElement(ExtensionHostComponent, { ...props, fileContent: 'B' }));
    assert.equal(posted.filter((msg) => msg.type === 'fileContent').length, 0);
    assert.equal(
      markedSavedContent.get(props.tabId),
      'B',
      'the provider cache must follow the bytes written to disk, so a remounted tab restores the saved content'
    );

    view.rerender(createElement(ExtensionHostComponent, { ...props, fileContent: 'C' }));
    view.rerender(createElement(ExtensionHostComponent, { ...props, fileContent: 'B' }));
    assert.deepEqual(
      posted.filter((msg) => msg.type === 'fileContent').map((msg) => msg.content),
      ['C', 'B']
    );
  });

  it('resends identical content after a filePath change resets the write snapshot', async () => {
    const { view, props, posted, emit } = renderHost();
    emit({ type: 'parentSaveDocument', path: filePath, content: 'same bytes', revision: 1 });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    posted.length = 0;

    view.rerender(createElement(ExtensionHostComponent, {
      ...props,
      filePath: '/tmp/other.txt',
      fileContent: 'same bytes',
    }));

    const reloads = posted.filter((msg) => msg.type === 'fileContent');
    assert.equal(reloads.length, 1);
    assert.equal(reloads[0].type === 'fileContent' && reloads[0].path, '/tmp/other.txt');
  });

  it('shows a blocking retry and disables save for fatal restore errors', (context) => {
    context.mock.method(console, 'error', () => undefined);
    const { view, emit } = renderHost();
    const save = view.getByTestId('SaveIcon').closest('button');
    assert.ok(save);
    assert.equal(save.disabled, false);

    emit({ type: 'error', path: filePath, message: 'bad scene', fatal: true });

    assert.equal(save.disabled, true);
    assert.ok(view.getByText('extLoadFailed'));
    assert.ok(view.getByRole('button', { name: 'extRetry' }));
  });

  it('rejects close-save immediately while a fatal load error is showing', async (context) => {
    context.mock.method(console, 'error', () => undefined);
    const { posted, emit, saveCurrent } = renderHost();
    emit({ type: 'contentChangedInEditor', path: filePath, dirty: true, revision: 1 });
    posted.length = 0;
    emit({ type: 'error', path: filePath, message: 'bad scene', fatal: true });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await saveCurrent();
    });

    assert.equal(ok, false);
    assert.equal(posted.some((msg) => msg.type === 'requestSave'), false);
    assert.ok(hostNotices.includes('extensionSaveError: extLoadFailed'));
  });

  it('resets revision and identical-content suppression when retry remounts', async (context) => {
    context.mock.method(console, 'error', () => undefined);
    const { view, props, posted, emit, saveCurrent } = renderHost();
    emit({ type: 'contentChangedInEditor', path: filePath, dirty: true, revision: 4 });
    emit({ type: 'parentSaveDocument', path: filePath, content: 'saved bytes', revision: 4 });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    view.rerender(createElement(ExtensionHostComponent, { ...props, fileContent: 'saved bytes' }));
    posted.length = 0;

    emit({ type: 'error', path: filePath, message: 'bad scene', fatal: true });
    fireEvent.click(view.getByRole('button', { name: 'extRetry' }));
    emit({ type: 'ready' });

    const reloads = posted.filter((msg) => msg.type === 'fileContent');
    assert.equal(reloads.length, 1, 'retry must resend even identical bytes');
    let pending!: Promise<boolean>;
    act(() => {
      pending = saveCurrent();
    });
    emit({ type: 'parentSaveDocument', path: filePath, content: 'after retry', revision: 0 });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await pending;
    });
    assert.equal(ok, true, 'a remounted extension restarts its revision at zero');
    assert.equal(hostNotices.includes('extensionSaveError: extensionSaveOutdated'), false);
  });

  it('keeps dirty and resolves false when an older save ack follows a newer edit', async () => {
    const { posted, emit, saveCurrent } = renderHost();
    let finishWrite: (() => void) | undefined;
    writeFileWithRevisionImpl = () => new Promise<void>((resolve) => {
      finishWrite = resolve;
    });

    let pending!: Promise<boolean>;
    act(() => {
      pending = saveCurrent();
    });
    emit({ type: 'contentChangedInEditor', path: filePath, dirty: true, revision: 1 });
    emit({
      type: 'parentSaveDocument',
      path: filePath,
      content: 'version one',
      revision: 1,
    });
    emit({ type: 'contentChangedInEditor', path: filePath, dirty: true, revision: 2 });
    assert.ok(finishWrite, 'save must be pending while revision 2 arrives');

    let ok: boolean | undefined;
    await act(async () => {
      finishWrite?.();
      ok = await pending;
    });

    assert.equal(ok, false);
    assert.deepEqual(hostNotices, [
      'extensionSaveError: extensionSaveOutdated',
    ]);
    assert.deepEqual(
      posted.filter((msg) => msg.type === 'savingFile'),
      [{ type: 'savingFile', path: filePath, revision: 1 }]
    );
    const ackAction = dispatchedActions.filter(
      (action) => action.type === 'extensions/SET_FILE_EDIT_STATE'
    ).at(-1);
    assert.deepEqual(ackAction?.payload?.state, { saving: false });
    assert.equal(
      ackAction?.payload?.state && 'dirty' in ackAction.payload.state,
      false,
      'stale ack must not dispatch dirty:false'
    );
  });

  it('reports a concurrent save as in progress and resolves false', async () => {
    let finishWrite: (() => void) | undefined;
    let writes = 0;
    writeFileWithRevisionImpl = () => {
      writes += 1;
      return new Promise<void>((resolve) => {
        finishWrite = resolve;
      });
    };
    const { emit, saveCurrent } = renderHost();
    let pending!: Promise<boolean>;
    act(() => {
      pending = saveCurrent();
    });
    emit({
      type: 'parentSaveDocument',
      path: filePath,
      content: 'first content',
      revision: 1,
    });
    emit({
      type: 'parentSaveDocument',
      path: filePath,
      content: 'concurrent content',
      revision: 2,
    });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await pending;
    });
    assert.equal(ok, false);
    assert.equal(writes, 1);
    assert.deepEqual(hostNotices, [
      'extensionSaveError: extensionSaveInProgress',
    ]);

    await act(async () => {
      finishWrite?.();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('reports a real rejected write once and resolves the close save as false', async () => {
    writeFileWithRevisionImpl = async () => {
      throw new Error('disk full');
    };
    const { posted, emit, saveCurrent } = renderHost();
    let pending!: Promise<boolean>;
    act(() => {
      pending = saveCurrent();
    });
    assert.equal(
      posted.filter((msg) => msg.type === 'requestSave').length,
      1
    );

    emit({
      type: 'parentSaveDocument',
      path: filePath,
      content: 'latest edits',
      revision: 1,
    });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await pending;
    });

    assert.equal(ok, false);
    assert.deepEqual(hostNotices, ['extensionSaveError: disk full']);
    const failureAction = dispatchedActions
      .filter((action) => action.type === 'extensions/SET_FILE_EDIT_STATE')
      .at(-1);
    assert.deepEqual(failureAction?.payload?.state, {
      dirty: true,
      saving: false,
    });
  });

  it('reports readOnly once without requesting content from the extension', async () => {
    const { posted, saveCurrent } = renderHost({ readOnly: true });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await saveCurrent();
    });

    assert.equal(ok, false);
    assert.deepEqual(hostNotices, [
      'extensionSaveError: readOnlyLocation',
    ]);
    assert.equal(posted.some((msg) => msg.type === 'requestSave'), false);
  });

  it('reports a readOnly switch between requestSave and parentSaveDocument once', async () => {
    const { view, props, emit, saveCurrent } = renderHost();
    let pending!: Promise<boolean>;
    act(() => {
      pending = saveCurrent();
    });

    view.rerender(createElement(ExtensionHostComponent, { ...props, readOnly: true }));
    emit({
      type: 'parentSaveDocument',
      path: filePath,
      content: 'edits made before the permission change',
      revision: 1,
    });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await pending;
    });

    assert.equal(ok, false);
    assert.deepEqual(hostNotices, [
      'extensionSaveError: readOnlyLocation',
    ]);
  });

  it('reports a close-save timeout once and resolves false', async (context) => {
    // Electron's Node supports the options-object API; the bundled @types
    // still exposes the older Timer[] signature.
    context.mock.timers.enable({ apis: ['setTimeout'] } as unknown as Parameters<
      typeof context.mock.timers.enable
    >[0]);
    const { posted, saveCurrent } = renderHost();
    let pending!: Promise<boolean>;
    act(() => {
      pending = saveCurrent();
    });
    assert.equal(
      posted.filter((msg) => msg.type === 'requestSave').length,
      1
    );

    act(() => {
      context.mock.timers.tick(15000);
    });

    assert.equal(await pending, false);
    assert.deepEqual(hostNotices, [
      'extensionSaveError: extensionSaveTimeout',
    ]);
  });
});

describe('ExtensionHost hot-path subscriptions', () => {
  const filePath = '/tmp/host.txt';
  const manifest: ExtensionManifest = {
    id: 'text-editor',
    name: 'Text Editor',
    type: 'editor',
    color: '#000000',
    fileTypes: ['txt'],
    entryPoint: 'index.html',
    enabled: true,
    isDefault: true,
  };

  function renderHost() {
    return render(
      createElement(ExtensionHostComponent, {
        tabId: 'tab-1',
        manifest,
        filePath,
        fileContent: 'disk',
        encoding: 'utf8' as const,
        readOnly: false,
        theme: 'light' as const,
        onRequestRevisionHistory: () => {},
      })
    );
  }

  it('selects a primitive dirty boolean instead of the editState entry object', () => {
    const view = renderHost();
    assert.ok(view);
    const stateWith = (editState: Record<string, unknown>) => ({
      extensions: { editState },
    });
    const selector = capturedSelectors.find(
      (candidate) =>
        typeof candidate(stateWith({ 'tab-1': { dirty: true, saving: true } })) ===
        'boolean'
    );
    assert.ok(selector, 'host must subscribe to a boolean dirty value');
    // Fresh entry objects with the same flag must compare equal to React
    // (primitives), so a saving toggle cannot force a re-render of this host.
    assert.equal(selector(stateWith({ 'tab-1': { dirty: true, saving: true } })), true);
    assert.equal(selector(stateWith({ 'tab-1': { dirty: true, saving: false } })), true);
    assert.equal(selector(stateWith({ 'tab-1': { dirty: false, saving: true } })), false);
    assert.equal(selector(stateWith({ 'tab-1': {} })), false);
    assert.equal(selector(stateWith({})), false);
    assert.equal(selector(stateWith({ other: { dirty: true } })), false);
  });

  it('does not dispatch when a dirty report repeats the current flag', () => {
    const view = renderHost();
    const iframe = document.querySelector('iframe');
    assert.ok(iframe);
    Object.defineProperty(iframe.contentWindow, 'postMessage', {
      configurable: true,
      value: () => {},
    });
    const emit = (message: ExtensionMessage) => {
      act(() => {
        window.dispatchEvent(new window.MessageEvent('message', {
          source: iframe.contentWindow,
          data: { protocolVersion: 1, source: 'extension', message },
        }));
      });
    };
    emit({ type: 'ready' });
    dispatchedActions.length = 0;
    void view;

    // Mock host edit state already has dirty=true: a repeated true report is a
    // hot-path no-op (editors may send revision snapshots during a save).
    emit({ type: 'contentChangedInEditor', path: filePath, dirty: true, revision: 5 });
    assert.equal(dispatchedActions.length, 0);

    emit({ type: 'contentChangedInEditor', path: filePath, dirty: false, revision: 6 });
    assert.deepEqual(
      dispatchedActions.map((action) => action.type),
      ['extensions/SET_FILE_EDIT_STATE']
    );
    assert.deepEqual(dispatchedActions[0].payload?.state, { dirty: false });
  });

  it('treats the save-time revision as current when intermediate reports were skipped', async () => {
    const view = renderHost();
    const iframe = document.querySelector('iframe');
    assert.ok(iframe);
    Object.defineProperty(iframe.contentWindow, 'postMessage', {
      configurable: true,
      value: () => {},
    });
    const emit = (message: ExtensionMessage) => {
      act(() => {
        window.dispatchEvent(new window.MessageEvent('message', {
          source: iframe.contentWindow,
          data: { protocolVersion: 1, source: 'extension', message },
        }));
      });
    };
    emit({ type: 'ready' });
    void view;

    // Dirty reports are edge-triggered, so the host only saw revision 1. The
    // editor saves at revision 5 and the ack must still count as current.
    emit({ type: 'contentChangedInEditor', path: filePath, dirty: true, revision: 1 });
    const handler = registeredSaveHandlers.get('tab-1');
    assert.ok(handler);
    let pending!: Promise<boolean>;
    act(() => {
      pending = handler();
    });
    emit({ type: 'parentSaveDocument', path: filePath, content: 'final', revision: 5 });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await pending;
    });

    assert.equal(ok, true);
    assert.equal(
      hostNotices.includes('extensionSaveError: extensionSaveOutdated'),
      false,
      'a completed save must not be reported as outdated'
    );
  });
});

describe('ExtensionHost rename', () => {
  // Rename is only offered for a clean tab; a dirty tab hits the alert guard.
  beforeEach(() => {
    hostEditState.dirty = false;
  });

  const filePath = '/tmp/host.txt';
  const manifest: ExtensionManifest = {
    id: 'text-editor',
    name: 'Text Editor',
    type: 'editor',
    color: '#000000',
    fileTypes: ['txt'],
    entryPoint: 'index.html',
    enabled: true,
    isDefault: true,
  };

  function renderHost() {
    return render(
      createElement(ExtensionHostComponent, {
        tabId: 'tab-1',
        manifest,
        filePath,
        fileContent: 'disk',
        encoding: 'utf8' as const,
        readOnly: false,
        theme: 'light' as const,
        onRequestRevisionHistory: () => {},
      })
    );
  }

  async function confirmRename(view: ReturnType<typeof renderHost>): Promise<void> {
    fireEvent.click(view.getByTestId('DriveFileRenameOutlineIcon').closest('button')!);
    const confirm = view.getByTestId('rename-confirm');
    fireEvent.click(confirm);
    // Flush the rename -> close -> open promise chain (real timers).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('closes the old-path tab before opening the renamed file', async () => {
    const order: string[] = [];
    renameImpl = async (from, to) => {
      order.push(`rename:${from}->${to}`);
    };
    closeTabImpl = async (tabId) => {
      order.push(`close:${tabId}`);
      return 'closed';
    };
    openWithExtensionImpl = async (entry) => {
      order.push(`open:${entry.path}`);
    };

    const view = renderHost();
    await confirmRename(view);

    assert.deepEqual(renameCalls, [
      { from: '/tmp/host.txt', to: '/tmp/renamed.txt' },
    ]);
    assert.deepEqual(order, [
      'rename:/tmp/host.txt->/tmp/renamed.txt',
      'close:tab-1',
      'open:/tmp/renamed.txt',
    ]);
  });

  it('keeps the old tab when the rename fails', async (context) => {
    context.mock.method(window, 'alert', () => undefined);
    renameImpl = async () => {
      throw new Error('access denied');
    };

    const view = renderHost();
    await confirmRename(view);

    assert.deepEqual(closeTabCalls, []);
    assert.deepEqual(openWithExtensionCalls, []);
  });
});
