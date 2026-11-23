import globalJsdom from 'global-jsdom';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { createElement, useEffect, useRef } from 'react';
import type { DirEntry } from '../../shared/ipc-types';
import type { ExtensionManifest } from '../../shared/extension-types';

type TestingLibrary = typeof import('@testing-library/react');
type ProviderModule = typeof import('./ExtensionContextProvider');
type ExtensionContextValue = ReturnType<ProviderModule['useExtensionContext']>;

let cleanup: TestingLibrary['cleanup'];
let render: TestingLibrary['render'];
let act: TestingLibrary['act'];
let Provider: ProviderModule['ExtensionContextProvider'];
let useExtensionContext: ProviderModule['useExtensionContext'];

const require_ = createRequire(__filename);
const BINARY_BASE64 = 'AAECf4D+/w=='; // 7 bytes
const savedCache = new Map<string, NodeJS.Module | undefined>();
let jsdomCleanup: (() => void) | null = null;

const dispatched: Array<{ type: string; payload?: unknown }> = [];
const notices: string[] = [];
const readFileBase64Calls: string[] = [];
const readTextFileCalls: string[] = [];
let legacyReadCalls = 0;
let loadRegistryImpl: () => Promise<unknown>;
let readFileBase64Impl: (filePath: string) => Promise<string>;
let readTextFileImpl: (filePath: string) => Promise<string>;
let probeCtx: ExtensionContextValue | null = null;

const location = {
  id: 'loc-1',
  name: 'root',
  path: 'C:/root',
  isReadOnly: false,
};

const fakeState = {
  extensions: {
    registry: null,
    userDefaults: {},
    enabledOverrides: {},
    editState: {},
  },
};

const mockDispatch = (action: { type: string; payload?: unknown }) => {
  dispatched.push(action);
  return action;
};

const mockTranslate = (key: string, options?: { message?: string }) =>
  options?.message ? `${key}: ${options.message}` : key;

const fakeStore = { getState: () => fakeState };

const savedManifest: ExtensionManifest = {
  id: 'heic-viewer',
  name: 'HEIC Viewer',
  type: 'viewer',
  color: '#000000',
  fileTypes: ['heic'],
  entryPoint: 'index.html',
  enabled: true,
  isDefault: true,
};

function makeEntry(name: string, ext: string): DirEntry {
  return {
    name,
    path: `C:/root/${name}`,
    isDirectory: false,
    isFile: true,
    size: 100,
    modified: '2026-01-01T00:00:00.000Z',
    extension: ext,
  };
}

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

/** Renders inside the provider and hands the live context to the test. */
function Probe(props: { onReady?: (ctx: ExtensionContextValue) => void }) {
  const ctx = useExtensionContext();
  probeCtx = ctx;
  const onReadyRef = useRef(props.onReady);
  onReadyRef.current = props.onReady;
  useEffect(() => {
    onReadyRef.current?.(ctx);
    // Mount-only: the first context value already has stable handlers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return createElement(
    'span',
    { 'data-testid': 'probe-error' },
    ctx.error ?? 'none'
  );
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Flush async provider effects through React's act queue. */
async function flushAll(): Promise<void> {
  await act(async () => {
    await flush();
  });
}

before(async () => {
  jsdomCleanup = globalJsdom() as unknown as () => void;
  loadRegistryImpl = async () => null;
  readFileBase64Impl = async () => BINARY_BASE64;
  readTextFileImpl = async () => 'text';
  injectMock('-/services/ipc-api', {
    ipcApi: {
      loadExtensionRegistry: () => loadRegistryImpl(),
      readFileBase64: (filePath: string) => {
        readFileBase64Calls.push(filePath);
        return readFileBase64Impl(filePath);
      },
      readTextFile: (filePath: string) => {
        readTextFileCalls.push(filePath);
        return readTextFileImpl(filePath);
      },
      readFile: async () => {
        legacyReadCalls += 1;
        throw new Error('legacy byte-array read must not be used');
      },
      onDirChanged: () => () => {},
      openNative: async () => undefined,
    },
  });
  injectMock('-/services/app-notice', {
    notifyApp: (message: string) => {
      notices.push(message);
    },
  });
  injectMock('-/services/extension-save-flush', {
    registerExtensionSaveFlush: () => () => {},
  });
  injectMock('-/services/extension-dispatch', {
    selectExtension: () => null,
  });
  injectMock('-/hooks/CurrentLocationContextProvider', {
    useCurrentLocationContext: () => ({ currentLocation: location }),
  });
  injectMock('-/components/ConfirmDiscardDialog', {
    __esModule: true,
    default: () => null,
    ConfirmDiscardChoice: undefined,
  });
  injectMock('react-redux', {
    useDispatch: () => mockDispatch,
    useSelector: (selector: (state: unknown) => unknown) => selector(fakeState),
    useStore: () => fakeStore,
  });
  injectMock('react-i18next', {
    useTranslation: () => ({ t: mockTranslate, i18n: { language: 'en' } }),
  });

  try {
    delete require_.cache[require_.resolve('./ExtensionContextProvider')];
  } catch {
    // Not loaded yet.
  }
  const mod = require_('./ExtensionContextProvider') as ProviderModule;
  Provider = mod.ExtensionContextProvider;
  useExtensionContext = mod.useExtensionContext;

  ({ cleanup, render, act } = await import('@testing-library/react'));
});

afterEach(() => {
  cleanup();
  probeCtx = null;
  dispatched.length = 0;
  notices.length = 0;
  readFileBase64Calls.length = 0;
  readTextFileCalls.length = 0;
  legacyReadCalls = 0;
  loadRegistryImpl = async () => null;
  readFileBase64Impl = async () => BINARY_BASE64;
  readTextFileImpl = async () => 'text';
});

after(() => {
  jsdomCleanup?.();
  for (const [modulePath, original] of savedCache.entries()) {
    if (original) require_.cache[modulePath] = original;
    else delete require_.cache[modulePath];
  }
});

describe('ExtensionContextProvider file reads', () => {
  it('opens binary files through Main base64, never btoa/ArrayBuffer in the renderer', async () => {
    const view = render(
      createElement(
        Provider,
        null,
        createElement(Probe, {
          onReady: (ctx) => {
            void ctx.openWithExtension(
              makeEntry('photo.heic', 'heic'),
              savedManifest
            );
          },
        })
      )
    );

    await flushAll();

    assert.deepEqual(readFileBase64Calls, ['C:/root/photo.heic']);
    assert.equal(legacyReadCalls, 0);
    assert.deepEqual(readTextFileCalls, []);
    assert.equal(probeCtx?.tabs.length, 1);
    const tab = probeCtx?.tabs[0];
    assert.ok(tab);
    assert.equal(tab.fileContent, BINARY_BASE64);
    assert.equal(tab.encoding, 'base64');
    assert.equal(tab.fileSize, 7);
    assert.equal(tab.manifestId, 'heic-viewer');
    void view;
  });

  it('opens text files as utf8 and reports decoded byte size', async () => {
    readTextFileImpl = async () => 'héllo';
    const view = render(
      createElement(
        Provider,
        null,
        createElement(Probe, {
          onReady: (ctx) => {
            void ctx.openWithExtension(
              makeEntry('notes.txt', 'txt'),
              { ...savedManifest, id: 'text-editor', fileTypes: ['txt'] }
            );
          },
        })
      )
    );

    await flushAll();

    assert.deepEqual(readTextFileCalls, ['C:/root/notes.txt']);
    assert.equal(legacyReadCalls, 0);
    const tab = probeCtx?.tabs[0];
    assert.ok(tab);
    assert.equal(tab.fileContent, 'héllo');
    assert.equal(tab.encoding, 'utf8');
    assert.equal(tab.fileSize, 6);
    void view;
  });
});

describe('ExtensionContextProvider registry failures', () => {
  it('surfaces a broken registry instead of pretending there are no extensions', async (context) => {
    context.mock.method(console, 'error', () => undefined);
    loadRegistryImpl = async () => {
      throw new Error('Malformed extension registry at C:/root/registry.json');
    };

    const view = render(
      createElement(Provider, null, createElement(Probe, {}))
    );
    await flushAll();

    assert.deepEqual(notices, ['extensionRegistryError']);
    assert.equal(probeCtx?.error, 'extensionRegistryError');
    assert.ok(
      view.queryByTestId('probe-error')?.textContent === 'extensionRegistryError'
    );
    const registryDispatch = dispatched.find(
      (action) => action.type === 'extensions/LOAD_EXTENSION_REGISTRY'
    );
    assert.ok(registryDispatch, 'renderer must still clear the registry');
    assert.equal(registryDispatch.payload, null);
  });

  it('treats a missing registry as a legitimate empty install', async () => {
    loadRegistryImpl = async () => null;

    render(createElement(Provider, null, createElement(Probe, {})));
    await flushAll();

    assert.deepEqual(notices, []);
    assert.equal(probeCtx?.error, null);
    assert.deepEqual(probeCtx?.registry, null);
  });

  it('dispatches a loaded registry without a notice', async () => {
    const registry = {
      extensions: [savedManifest],
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    loadRegistryImpl = async () => registry;

    render(createElement(Provider, null, createElement(Probe, {})));
    await flushAll();

    assert.deepEqual(notices, []);
    const registryDispatch = dispatched.find(
      (action) => action.type === 'extensions/LOAD_EXTENSION_REGISTRY'
    );
    assert.deepEqual(registryDispatch?.payload, registry);
  });
});
