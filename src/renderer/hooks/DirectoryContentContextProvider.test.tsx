import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { DirEntry, SidecarIssue, SidecarReadResult } from '../../shared/ipc-types';
import type { DirectoryContentContextValue } from './DirectoryContentContextProvider';

const require_ = createRequire(__filename);
const savedCache = new Map<string, NodeJS.Module | undefined>();
let cleanupDom: (() => void) | undefined;
let Provider!: typeof import('./DirectoryContentContextProvider').DirectoryContentContextProvider;
let useContent!: typeof import('./DirectoryContentContextProvider').useDirectoryContentContext;
let observed: DirectoryContentContextValue | undefined;
let currentDir = 'C:\\root';
let depth = 1;
let entries: DirEntry[] = [];
let depthSidecars: SidecarReadResult['sidecars'] = {};
let bulkSidecars: SidecarReadResult['sidecars'] = {};
let issues: SidecarIssue[] = [];
let depthCalls: unknown[][] = [];
let bulkCalls: unknown[][] = [];

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

function entry(dir: string, name: string): DirEntry {
  return {
    name,
    path: `${dir}\\${name}`,
    isDirectory: false,
    isFile: true,
    size: 1,
    modified: '2026-01-01T00:00:00.000Z',
    extension: 'txt',
  };
}

function corrupt(dir: string): SidecarIssue {
  return {
    kind: 'corrupt',
    reason: 'invalid-json',
    dirPath: dir,
    sidecarPath: `${dir}\\.whale\\wsd.json`,
    sha256: 'a'.repeat(64),
    size: 4,
  };
}

before(() => {
  cleanupDom = globalJsdom();
  injectMock('-/services/ipc-api', {
    ipcApi: {
      listDirectory: async () => entries,
      readSidecarsDetailed: async (...args: unknown[]) => {
        depthCalls.push(args);
        return { sidecars: depthSidecars, issues };
      },
      listDirectoryRecursive: async () => entries,
      readSidecardsForPathsDetailed: async (...args: unknown[]) => {
        bulkCalls.push(args);
        return { sidecars: bulkSidecars, issues };
      },
      readFolderMeta: async () => ({}),
      onDirChanged: () => () => undefined,
    },
  });
  injectMock('./CurrentLocationContextProvider', {
    useCurrentLocationContext: () => ({ currentDirectoryPath: currentDir }),
  });
  injectMock('react-redux', {
    useSelector: (selector: (state: unknown) => unknown) =>
      selector({ settings: { viewDepth: depth } }),
  });
  const loaded = require_('./DirectoryContentContextProvider') as typeof import('./DirectoryContentContextProvider');
  Provider = loaded.DirectoryContentContextProvider;
  useContent = loaded.useDirectoryContentContext;
});

afterEach(() => {
  cleanup();
  observed = undefined;
  currentDir = 'C:\\root';
  depth = 1;
  entries = [];
  depthSidecars = {};
  bulkSidecars = {};
  issues = [];
  depthCalls = [];
  bulkCalls = [];
});

after(() => {
  cleanupDom?.();
  for (const [modulePath, original] of savedCache) {
    if (original) require_.cache[modulePath] = original;
    else delete require_.cache[modulePath];
  }
  delete require_.cache[require_.resolve('./DirectoryContentContextProvider')];
});

function Probe() {
  observed = useContent();
  return null;
}

function renderProvider() {
  return render(
    <Provider>
      <Probe />
    </Provider>
  );
}

describe('DirectoryContentContextProvider sidecar issues', () => {
  it('exposes depth-one issues and healthy tags, then clears issues on refresh', async () => {
    entries = [entry(currentDir, 'a.txt')];
    depthSidecars = { 'a.txt': { tags: ['healthy'] } };
    issues = [corrupt(currentDir)];
    renderProvider();
    await waitFor(() => assert.equal(observed?.sidecarIssues?.length, 1));
    assert.deepEqual(observed?.tagsByName.get(entries[0].path), ['healthy']);
    issues = [];
    await observed?.refresh();
    await waitFor(() => assert.deepEqual(observed?.sidecarIssues, []));
    assert.deepEqual(observed?.tagsByName.get(entries[0].path), ['healthy']);
    assert.equal(depthCalls.length, 2);
  });

  it('clears a previous directory issue during navigation', async () => {
    issues = [corrupt(currentDir)];
    const view = renderProvider();
    await waitFor(() => assert.equal(observed?.sidecarIssues?.length, 1));
    currentDir = 'C:\\next';
    issues = [];
    view.rerender(
      <Provider>
        <Probe />
      </Provider>
    );
    await waitFor(() => assert.equal(depthCalls.length, 2));
    await waitFor(() => assert.deepEqual(observed?.sidecarIssues, []));
    assert.equal(depthCalls[1][0], currentDir);
  });

  it('reads the root wsd when a recursive scan is empty', async () => {
    depth = 2;
    issues = [corrupt(currentDir)];
    renderProvider();
    await waitFor(() => assert.equal(depthCalls.length, 1));
    assert.deepEqual(depthCalls[0], [currentDir, []]);
    assert.equal(bulkCalls.length, 0);
    await waitFor(() => assert.deepEqual(observed?.sidecarIssues, issues));
  });

  it('uses the detailed bulk API and preserves recursive sidecars', async () => {
    depth = 3;
    entries = [entry(currentDir, 'nested.txt')];
    bulkSidecars = { [entries[0].path]: { tags: ['bulk'] } };
    issues = [corrupt(currentDir)];
    renderProvider();
    await waitFor(() => assert.equal(bulkCalls.length, 1));
    assert.deepEqual(bulkCalls[0], [[entries[0].path]]);
    assert.deepEqual(observed?.tagsByName.get(entries[0].path), ['bulk']);
    assert.deepEqual(observed?.sidecarIssues, issues);
  });

  it('prunes hidden descendants from recursive entries and sidecar reads', async () => {
    depth = 2;
    const hiddenDir = {
      ...entry(currentDir, '.hidden'),
      isDirectory: true,
      isFile: false,
    };
    const hiddenChild = entry(`${currentDir}\\.hidden`, 'secret.txt');
    const visible = entry(currentDir, 'visible.txt');
    entries = [hiddenDir, hiddenChild, visible];
    renderProvider();
    await waitFor(() => assert.equal(bulkCalls.length, 1));
    assert.deepEqual(bulkCalls[0], [[visible.path]]);
    assert.deepEqual(observed?.entries.map((item) => item.path), [visible.path]);
  });
});
