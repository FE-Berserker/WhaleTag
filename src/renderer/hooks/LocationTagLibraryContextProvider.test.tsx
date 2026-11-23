import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { WhaleLocation } from '../../shared/ipc-types';
import type { LocationTagLibraryContextValue } from './LocationTagLibraryContextProvider';

const require_ = createRequire(__filename);
const savedCache = new Map<string, NodeJS.Module | undefined>();
let cleanupDom: (() => void) | undefined;
let Provider!: typeof import('./LocationTagLibraryContextProvider').LocationTagLibraryContextProvider;
let useLibrary!: typeof import('./LocationTagLibraryContextProvider').useLocationTagLibrary;
let observed: LocationTagLibraryContextValue | undefined;

const LOCATION_A: WhaleLocation = {
  id: 'loc-a',
  name: 'A',
  path: '/loc-a',
  type: 'local',
  isReadOnly: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const LOCATION_B: WhaleLocation = {
  ...LOCATION_A,
  id: 'loc-b',
  name: 'B',
  path: '/loc-b',
};

let location: WhaleLocation | null = LOCATION_A;
/** Library content per location root. */
let libraries: Record<string, Record<string, string>> = {};
/** When set for a root, readTagLibrary rejects. */
let readFailures = new Map<string, Error>();
let readCalls: string[] = [];
let setWriteImpl: (
  locationRoot: string,
  tag: string,
  description: string
) => Promise<void> = async () => undefined;
let clearWriteImpl: (locationRoot: string, tag: string) => Promise<void> =
  async () => undefined;
let notices: string[] = [];
let warnings: unknown[][] = [];
const originalConsoleWarn = console.warn;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
  observed = useLibrary();
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
      readTagLibrary: (locationRoot: string) => {
        readCalls.push(locationRoot);
        const failure = readFailures.get(locationRoot);
        if (failure) return Promise.reject(failure);
        return Promise.resolve(libraries[locationRoot] ?? {});
      },
      setTagLibraryDescription: (
        locationRoot: string,
        tag: string,
        description: string
      ) => setWriteImpl(locationRoot, tag, description),
      clearTagLibraryDescription: (locationRoot: string, tag: string) =>
        clearWriteImpl(locationRoot, tag),
    },
  });
  injectMock('./CurrentLocationContextProvider', {
    useCurrentLocationContext: () => ({ currentLocation: location }),
  });
  injectMock('react-i18next', {
    useTranslation: () => ({ t: (key: string) => key }),
  });
  injectMock('-/services/app-notice', {
    notifyApp: (message: string) => {
      notices.push(message);
    },
  });
  const loaded = require_('./LocationTagLibraryContextProvider') as typeof import('./LocationTagLibraryContextProvider');
  Provider = loaded.LocationTagLibraryContextProvider;
  useLibrary = loaded.useLocationTagLibrary;
});

afterEach(() => {
  cleanup();
  observed = undefined;
  location = LOCATION_A;
  libraries = {};
  readFailures = new Map();
  readCalls = [];
  setWriteImpl = async () => undefined;
  clearWriteImpl = async () => undefined;
  notices = [];
  warnings = [];
  console.warn = originalConsoleWarn;
});

after(() => {
  cleanupDom?.();
  console.warn = originalConsoleWarn;
  for (const [modulePath, original] of savedCache) {
    if (original) require_.cache[modulePath] = original;
    else delete require_.cache[modulePath];
  }
  delete require_.cache[require_.resolve('./LocationTagLibraryContextProvider')];
});

describe('LocationTagLibraryContextProvider read failures', () => {
  it('surfaces an IPC read failure instead of silently emptying the library', async () => {
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    readFailures.set(LOCATION_A.path, new Error('ipc died'));
    renderProvider();

    await waitFor(() => assert.equal(notices.length, 1));
    assert.equal(notices[0], 'tagLibraryLoadFailed');
    assert.deepEqual(observed?.descriptions, {});
    assert.equal(observed?.loading, false);
    assert.ok(
      warnings.some((args) => /failed to read the tag library/.test(String(args[0]))),
      'the failure must be logged'
    );
  });

  it('does not notify for a healthy empty library', async () => {
    renderProvider();
    await waitFor(() => assert.equal(observed?.loading, false));
    assert.deepEqual(observed?.descriptions, {});
    assert.equal(notices.length, 0);
  });
});

describe('LocationTagLibraryContextProvider write rollback', () => {
  it('rolls back to the fresh library when the write fails in the same location', async () => {
    libraries = { [LOCATION_A.path]: { alpha: 'server value' } };
    setWriteImpl = () => Promise.reject(new Error('disk full'));
    renderProvider();
    await waitFor(() =>
      assert.deepEqual(observed?.descriptions, { alpha: 'server value' })
    );

    const pending = observed!.setDescription('alpha', 'edited');
    const settled = pending.then(
      () => null,
      (error: unknown) => error
    );
    const error = await settled;

    assert.ok(error instanceof Error);
    assert.match(error.message, /disk full/);
    assert.deepEqual(
      observed?.descriptions,
      { alpha: 'server value' },
      'the optimistic value must roll back to what disk holds'
    );
    assert.equal(notices.length, 0, 'the caller shows the write error itself');
  });

  it('discards a rollback that would leak the old location into the new one', async () => {
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    libraries = {
      [LOCATION_A.path]: { alpha: 'A description' },
      [LOCATION_B.path]: { beta: 'B description' },
    };
    const write = deferred<void>();
    setWriteImpl = () => write.promise;

    const view = renderProvider();
    await waitFor(() =>
      assert.deepEqual(observed?.descriptions, { alpha: 'A description' })
    );

    const pending = observed!.setDescription('alpha', 'edited');
    const settled = pending.then(
      () => null,
      (error: unknown) => error
    );
    await waitFor(() => assert.equal(observed?.descriptions.alpha, 'edited'));

    // Switch locations while the write is still in flight.
    location = LOCATION_B;
    view.rerender(
      <Provider>
        <Probe />
      </Provider>
    );
    await waitFor(() =>
      assert.deepEqual(observed?.descriptions, { beta: 'B description' })
    );
    const readsOfA = readCalls.filter((root) => root === LOCATION_A.path).length;

    await act(async () => {
      write.reject(new Error('disk full'));
    });
    const error = await settled;
    assert.ok(error instanceof Error);
    assert.match(error.message, /disk full/);

    assert.deepEqual(
      observed?.descriptions,
      { beta: 'B description' },
      "the old location's rollback must not leak into the new context"
    );
    assert.equal(
      readCalls.filter((root) => root === LOCATION_A.path).length,
      readsOfA,
      'no rollback read for a location that is no longer shown'
    );
    assert.ok(
      warnings.some((args) =>
        /discarded a cross-location rollback/.test(String(args[0]))
      ),
      'discarding the rollback must be logged'
    );
  });

  it('discards a cross-location restore when clearDescription fails', async () => {
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    libraries = {
      [LOCATION_A.path]: { alpha: 'A description' },
      [LOCATION_B.path]: { beta: 'B description' },
    };
    const clear = deferred<void>();
    clearWriteImpl = () => clear.promise;

    const view = renderProvider();
    await waitFor(() =>
      assert.deepEqual(observed?.descriptions, { alpha: 'A description' })
    );

    const pending = observed!.clearDescription('alpha');
    const settled = pending.then(
      () => null,
      (error: unknown) => error
    );
    await waitFor(() => assert.deepEqual(observed?.descriptions, {}));

    location = LOCATION_B;
    view.rerender(
      <Provider>
        <Probe />
      </Provider>
    );
    await waitFor(() =>
      assert.deepEqual(observed?.descriptions, { beta: 'B description' })
    );

    await act(async () => {
      clear.reject(new Error('disk full'));
    });
    const error = await settled;
    assert.ok(error instanceof Error);
    assert.match(error.message, /disk full/);
    assert.deepEqual(observed?.descriptions, { beta: 'B description' });
    assert.ok(
      warnings.some((args) =>
        /discarded a cross-location restore/.test(String(args[0]))
      )
    );
  });
});
