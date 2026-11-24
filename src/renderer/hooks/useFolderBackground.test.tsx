import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

type TestingLibrary = typeof import('@testing-library/react');
let act: TestingLibrary['act'];
let cleanup: TestingLibrary['cleanup'];
let render: TestingLibrary['render'];
let waitFor: TestingLibrary['waitFor'];

type Hook = typeof import('./useFolderBackground').useFolderBackground;
type HookState = ReturnType<Hook>;

const require_ = createRequire(__filename);
const savedModules = new Map<string, NodeJS.Module | undefined>();
let hookId = '';
let cleanupDom: (() => void) | undefined;
let useFolderBackground: Hook;
let latest: HookState | null = null;
let loadImpl: (dirPath: string) => Promise<string | null> = async () => null;
const loadCalls: string[] = [];

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Probe({ dirPath }: { dirPath: string }) {
  latest = useFolderBackground(dirPath);
  return <span data-testid="background-url">{latest.backgroundUrl ?? 'none'}</span>;
}

before(async () => {
  cleanupDom = globalJsdom();
  ({ act, cleanup, render, waitFor } = await import('@testing-library/react'));
  inject('-/services/ipc-api', {
    ipcApi: {
      loadFolderBackground: (dirPath: string) => {
        loadCalls.push(dirPath);
        return loadImpl(dirPath);
      },
    },
  });
  hookId = require_.resolve('./useFolderBackground');
  delete require_.cache[hookId];
  ({ useFolderBackground } = require_('./useFolderBackground') as {
    useFolderBackground: Hook;
  });
});

afterEach(() => {
  cleanup();
  latest = null;
  loadCalls.length = 0;
  loadImpl = async () => null;
});

after(() => {
  if (hookId) delete require_.cache[hookId];
  for (const [id, original] of savedModules) {
    if (original) require_.cache[id] = original;
    else delete require_.cache[id];
  }
  cleanupDom?.();
});

describe('useFolderBackground', () => {
  it('loads the current directory and clears the image when the next one has none', async () => {
    loadImpl = async (dirPath) => (dirPath === '/a' ? 'data:image/jpeg;base64,AA==' : null);
    const view = render(<Probe dirPath="/a" />);
    await waitFor(() =>
      assert.equal(view.getByTestId('background-url').textContent, 'data:image/jpeg;base64,AA==')
    );

    view.rerender(<Probe dirPath="/b" />);
    await waitFor(() =>
      assert.equal(view.getByTestId('background-url').textContent, 'none')
    );
    assert.deepEqual(loadCalls, ['/a', '/b']);
  });

  it('ignores a late response from the previous directory', async () => {
    const a = deferred<string | null>();
    const b = deferred<string | null>();
    loadImpl = (dirPath) => (dirPath === '/a' ? a.promise : b.promise);
    const view = render(<Probe dirPath="/a" />);
    view.rerender(<Probe dirPath="/b" />);

    await act(async () => {
      b.resolve('data:image/jpeg;base64,NEW==');
      await b.promise;
    });
    await waitFor(() =>
      assert.equal(view.getByTestId('background-url').textContent, 'data:image/jpeg;base64,NEW==')
    );

    await act(async () => {
      a.resolve('data:image/jpeg;base64,OLD==');
      await a.promise;
    });
    assert.equal(view.getByTestId('background-url').textContent, 'data:image/jpeg;base64,NEW==');
  });

  it('reloads after set/clear and clears a removed background', async () => {
    let result: string | null = 'data:image/jpeg;base64,ONE==';
    loadImpl = async () => result;
    const view = render(<Probe dirPath="/a" />);
    await waitFor(() =>
      assert.equal(view.getByTestId('background-url').textContent, 'data:image/jpeg;base64,ONE==')
    );

    result = null;
    await act(async () => {
      latest?.reloadFolderBackground();
    });
    await waitFor(() =>
      assert.equal(view.getByTestId('background-url').textContent, 'none')
    );
    assert.deepEqual(loadCalls, ['/a', '/a']);
  });

  it('falls back to no background on failure and can recover on reload', async () => {
    loadImpl = async () => {
      throw new Error('read failed');
    };
    const view = render(<Probe dirPath="/a" />);
    await waitFor(() => assert.equal(loadCalls.length, 1));
    assert.equal(view.getByTestId('background-url').textContent, 'none');

    loadImpl = async () => 'data:image/jpeg;base64,BACK==';
    await act(async () => {
      latest?.reloadFolderBackground();
    });
    await waitFor(() =>
      assert.equal(view.getByTestId('background-url').textContent, 'data:image/jpeg;base64,BACK==')
    );
  });
});

describe('FolderBackground', () => {
  it('renders a decorative, input-transparent layer only when a URL exists', async () => {
    const { default: FolderBackground } = (await import(
      '../components/file-list/FolderBackground'
    )) as typeof import('../components/file-list/FolderBackground');
    const view = render(<FolderBackground url={null} />);
    assert.equal(view.queryByTestId('folder-background'), null);

    view.rerender(<FolderBackground url="data:image/jpeg;base64,AA==" />);
    const layer = view.getByTestId('folder-background');
    assert.equal(layer.getAttribute('aria-hidden'), 'true');
    const style = window.getComputedStyle(layer);
    assert.equal(style.pointerEvents, 'none');
    assert.equal(style.position, 'absolute');
    assert.equal(style.zIndex, '-1');
    assert.match(style.backgroundImage, /data:image\/jpeg;base64,AA==/);
  });
});
