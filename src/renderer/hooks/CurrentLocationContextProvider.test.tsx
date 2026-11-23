import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { WhaleLocation } from '../../shared/ipc-types';
import type { CurrentLocationContextValue } from './CurrentLocationContextProvider';

const require_ = createRequire(__filename);
const savedCache = new Map<string, NodeJS.Module | undefined>();
let cleanupDom: (() => void) | undefined;
let Provider!: typeof import('./CurrentLocationContextProvider').CurrentLocationContextProvider;
let useLocation!: typeof import('./CurrentLocationContextProvider').useCurrentLocationContext;
let observed: CurrentLocationContextValue | undefined;

const ROOT = '/root';
const LOCATION: WhaleLocation = {
  id: 'loc-1',
  name: 'root',
  path: ROOT,
  type: 'local',
  isReadOnly: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

let parentDirImpl: (dirPath: string) => Promise<string> = async (dirPath) => {
  const idx = dirPath.lastIndexOf('/');
  return idx > 0 ? dirPath.slice(0, idx) : '/';
};
let notices: string[] = [];
let dispatched: unknown[] = [];
let consoleErrors: unknown[][] = [];
const originalConsoleError = console.error;

function injectMock(moduleName: string, exports: unknown): void {
  const modulePath = require_.resolve(moduleName);
  if (!savedCache.has(modulePath)) savedCache.set(modulePath, require_.cache[modulePath]);
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

function Probe() {
  observed = useLocation();
  return null;
}

function renderProvider() {
  return render(
    <Provider>
      <Probe />
    </Provider>
  );
}

before(() => {
  cleanupDom = globalJsdom();
  injectMock('-/services/ipc-api', {
    ipcApi: {
      parentDir: (dirPath: string) => parentDirImpl(dirPath),
    },
  });
  injectMock('react-redux', {
    useDispatch: () => (action: unknown) => {
      dispatched.push(action);
    },
    useSelector: (selector: (state: unknown) => unknown) =>
      selector({ locations: { items: [LOCATION], activeId: LOCATION.id } }),
  });
  injectMock('react-i18next', {
    useTranslation: () => ({
      t: (key: string, options?: { message?: string }) =>
        options?.message ? `${key}: ${options.message}` : key,
    }),
  });
  injectMock('-/services/app-notice', {
    notifyApp: (message: string) => {
      notices.push(message);
    },
  });
  const loaded = require_('./CurrentLocationContextProvider') as typeof import('./CurrentLocationContextProvider');
  Provider = loaded.CurrentLocationContextProvider;
  useLocation = loaded.useCurrentLocationContext;
});

afterEach(() => {
  cleanup();
  observed = undefined;
  notices = [];
  dispatched = [];
  consoleErrors = [];
  console.error = originalConsoleError;
  parentDirImpl = async (dirPath) => {
    const idx = dirPath.lastIndexOf('/');
    return idx > 0 ? dirPath.slice(0, idx) : '/';
  };
});

after(() => {
  cleanupDom?.();
  console.error = originalConsoleError;
  for (const [modulePath, original] of savedCache) {
    if (original) require_.cache[modulePath] = original;
    else delete require_.cache[modulePath];
  }
  delete require_.cache[require_.resolve('./CurrentLocationContextProvider')];
});

describe('CurrentLocationContextProvider navigation history', () => {
  it('records both directories when two navigations land in one render', async () => {
    renderProvider();
    await waitFor(() => assert.equal(observed?.currentDirectoryPath, ROOT));

    // Same-tick pair: the second call must see the history/index produced by
    // the first one, not the index captured when the render was committed.
    act(() => {
      observed?.navigateTo('/root/a');
      observed?.navigateTo('/root/b');
    });
    assert.equal(observed?.currentDirectoryPath, '/root/b');
    assert.equal(observed?.canGoBack, true);

    act(() => {
      observed?.goBack();
    });
    assert.equal(
      observed?.currentDirectoryPath,
      '/root/a',
      'goBack must return to the directory the user actually visited'
    );
    act(() => {
      observed?.goBack();
    });
    assert.equal(observed?.currentDirectoryPath, ROOT);
  });

  it('walks back and forward through the recorded history', async () => {
    renderProvider();
    await waitFor(() => assert.equal(observed?.currentDirectoryPath, ROOT));

    act(() => {
      observed?.navigateTo('/root/a');
    });
    act(() => {
      observed?.navigateTo('/root/b');
    });

    act(() => {
      observed?.goBack();
    });
    assert.equal(observed?.currentDirectoryPath, '/root/a');
    assert.equal(observed?.canGoForward, true);

    act(() => {
      observed?.goForward();
    });
    assert.equal(observed?.currentDirectoryPath, '/root/b');
    assert.equal(observed?.canGoForward, false);
  });
});

describe('CurrentLocationContextProvider goUp failure', () => {
  it('reports a failed parent lookup instead of leaving an unhandled rejection', async () => {
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args);
    };
    parentDirImpl = async () => {
      throw new Error('EACCES: permission denied');
    };
    renderProvider();
    await waitFor(() => assert.equal(observed?.currentDirectoryPath, ROOT));

    act(() => {
      observed?.navigateTo('/root/a');
    });
    // goUp must not reject: FileToolbar calls it as `onClick={() => goUp()}`
    // with no catch, so a rejection would become an unhandled rejection.
    await act(async () => {
      await observed?.goUp();
    });

    assert.equal(observed?.currentDirectoryPath, '/root/a');
    assert.equal(notices.length, 1, 'the user must see one failure notice');
    assert.match(notices[0], /operationFailed/);
    assert.match(notices[0], /EACCES/);
    assert.equal(consoleErrors.length, 1);
  });

  it('navigates to the parent on success', async () => {
    renderProvider();
    await waitFor(() => assert.equal(observed?.currentDirectoryPath, ROOT));

    act(() => {
      observed?.navigateTo('/root/sub/dir');
    });
    await act(async () => {
      await observed?.goUp();
    });

    assert.equal(observed?.currentDirectoryPath, '/root/sub');
    assert.equal(notices.length, 0);
  });
});
