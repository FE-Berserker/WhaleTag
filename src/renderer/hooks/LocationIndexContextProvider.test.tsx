/**
 * P1-3 (gui-audit 2026-11): async-result ownership for the search index.
 *
 * `build()` awaits an IPC round-trip; while it is in flight the user can
 * switch locations or start a second build. These tests use a controllable
 * ipc-api mock to prove a late result from an older generation is discarded
 * instead of being written onto the current location's status/count, and that
 * an unmount makes the continuation a no-op.
 *
 * Harness mirrors DirectoryContentContextProvider.test.tsx: `require_` cache
 * injection of the ipc-api + current-location modules, then the real provider
 * is required and mounted under a Probe.
 */

import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { WhaleLocation } from '../../shared/ipc-types';

type LocationIndexContextValue = ReturnType<
  typeof import('./LocationIndexContextProvider').useLocationIndexContext
>;

const require_ = createRequire(__filename);
const savedCache = new Map<string, NodeJS.Module | undefined>();
let cleanupDom: (() => void) | undefined;
let Provider!: typeof import('./LocationIndexContextProvider').LocationIndexContextProvider;
let useIndex!: typeof import('./LocationIndexContextProvider').useLocationIndexContext;
let observed: LocationIndexContextValue | undefined;

let location: WhaleLocation | null = null;
let statusByRoot = new Map<
  string,
  { count: number; ready: boolean; exists: boolean }
>();
let buildImpl: (rootPath: string) => Promise<{ count: number }> = async () => ({
  count: 0,
});
let buildCalls: string[] = [];

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

function makeLocation(id: string, path: string): WhaleLocation {
  return {
    id,
    name: id,
    path,
    type: 'local',
    isReadOnly: false,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

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

/** Let queued promise continuations + React passive effects settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

before(() => {
  cleanupDom = globalJsdom();
  injectMock('-/services/ipc-api', {
    ipcApi: {
      indexStatus: async (rootPath: string) =>
        statusByRoot.get(rootPath) ?? { count: 0, ready: true, exists: true },
      buildLocationIndex: (rootPath: string) => {
        buildCalls.push(rootPath);
        return buildImpl(rootPath);
      },
      queryIndex: async () => [],
      onIndexProgress: () => () => undefined,
    },
  });
  injectMock('./CurrentLocationContextProvider', {
    useCurrentLocationContext: () => ({ currentLocation: location }),
  });
  const loaded =
    require_('./LocationIndexContextProvider') as typeof import('./LocationIndexContextProvider');
  Provider = loaded.LocationIndexContextProvider;
  useIndex = loaded.useLocationIndexContext;
});

afterEach(() => {
  cleanup();
  observed = undefined;
  location = null;
  statusByRoot = new Map();
  buildImpl = async () => ({ count: 0 });
  buildCalls = [];
});

after(() => {
  cleanupDom?.();
  for (const [modulePath, original] of savedCache) {
    if (original) require_.cache[modulePath] = original;
    else delete require_.cache[modulePath];
  }
  delete require_.cache[require_.resolve('./LocationIndexContextProvider')];
});

function Probe() {
  observed = useIndex();
  return null;
}

function renderProvider() {
  return render(
    <Provider>
      <Probe />
    </Provider>
  );
}

function rerenderProvider(view: ReturnType<typeof renderProvider>) {
  view.rerender(
    <Provider>
      <Probe />
    </Provider>
  );
}

/** Start a build whose IPC reply is still pending. */
async function startPendingBuild(): Promise<{ build: Promise<void> }> {
  let buildPromise: Promise<void> | undefined;
  await act(async () => {
    buildPromise = observed?.build();
  });
  assert.ok(buildPromise, 'build() should have been invoked');
  return { build: buildPromise };
}

describe('LocationIndexContextProvider build ownership', () => {
  it('drops a build result that resolves after the location changed', async () => {
    location = makeLocation('a', '/root/a');
    statusByRoot.set('/root/b', { count: 2, ready: true, exists: true });
    const slow = deferred<{ count: number }>();
    buildImpl = (rootPath: string) =>
      rootPath === '/root/a' ? slow.promise : Promise.resolve({ count: 2 });

    const view = renderProvider();
    await waitFor(() => assert.equal(observed?.status, 'ready'));

    const { build: buildPromise } = await startPendingBuild();
    assert.equal(observed?.status, 'building');

    // Switch to another location while the first build is still awaiting.
    location = makeLocation('b', '/root/b');
    rerenderProvider(view);
    await waitFor(() => assert.equal(observed?.count, 2));
    await waitFor(() => assert.equal(observed?.status, 'ready'));

    // The old location's build finally answers — it must not touch the
    // new location's state.
    await act(async () => {
      slow.resolve({ count: 111 });
      await flush();
    });
    await buildPromise;
    assert.equal(
      observed?.count,
      2,
      'stale build must not overwrite the new location count'
    );
    assert.equal(
      observed?.status,
      'ready',
      'stale build must not overwrite the new location status'
    );
    assert.equal(observed?.error, null);
  });

  it('drops a stale build failure after the location changed', async () => {
    location = makeLocation('a', '/root/a');
    statusByRoot.set('/root/b', { count: 4, ready: true, exists: true });
    const slow = deferred<{ count: number }>();
    buildImpl = () => slow.promise;

    const view = renderProvider();
    await waitFor(() => assert.equal(observed?.status, 'ready'));

    const { build: buildPromise } = await startPendingBuild();
    location = makeLocation('b', '/root/b');
    rerenderProvider(view);
    await waitFor(() => assert.equal(observed?.count, 4));
    await waitFor(() => assert.equal(observed?.status, 'ready'));

    await act(async () => {
      slow.reject(new Error('index build failed'));
      await flush();
    });
    await buildPromise;
    assert.equal(observed?.status, 'ready');
    assert.equal(observed?.error, null, 'stale failure must not surface as the new location error');
    assert.equal(observed?.count, 4);
  });

  it('lets the newest build win when two builds overlap', async () => {
    location = makeLocation('a', '/root/a');
    const first = deferred<{ count: number }>();
    const second = deferred<{ count: number }>();
    let calls = 0;
    buildImpl = () => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    };

    renderProvider();
    await waitFor(() => assert.equal(observed?.status, 'ready'));

    const { build: firstBuild } = await startPendingBuild();
    const { build: secondBuild } = await startPendingBuild();

    await act(async () => {
      second.resolve({ count: 7 });
      await flush();
    });
    await waitFor(() => assert.equal(observed?.count, 7));

    // The first (now superseded) build answers late — ignored.
    await act(async () => {
      first.resolve({ count: 111 });
      await flush();
    });
    await firstBuild;
    await secondBuild;
    assert.equal(observed?.count, 7, 'older build must not overwrite newer result');
    assert.equal(observed?.status, 'ready');
  });

  it('does not write state when the provider unmounts mid-build', async () => {
    location = makeLocation('a', '/root/a');
    const pending = deferred<{ count: number }>();
    buildImpl = () => pending.promise;

    const view = renderProvider();
    await waitFor(() => assert.equal(observed?.status, 'ready'));
    const { build: buildPromise } = await startPendingBuild();

    const consoleError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(' '));
    };
    try {
      view.unmount();
      await act(async () => {
        pending.resolve({ count: 9 });
        await flush();
      });
      await assert.doesNotReject(buildPromise);
    } finally {
      console.error = consoleError;
    }

    assert.deepEqual(
      errors.filter((message) => /unmounted|state update on/i.test(message)),
      [],
      'an unmounted provider must not attempt a state update'
    );
  });
});
