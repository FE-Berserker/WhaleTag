import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { createRequire } from 'module';
import { cleanup, render } from '@testing-library/react';

const require_ = createRequire(__filename);
const savedModules = new Map<string, NodeJS.Module | undefined>();
let cleanupDom: (() => void) | undefined;
let originalResizeObserver: typeof ResizeObserver | undefined;
let FileToolbar: typeof import('./FileToolbar').default;
let computeFileToolbarVisibility: typeof import('./FileToolbar').computeFileToolbarVisibility;
let FOLD_VIEW_DEPTH_BELOW: number;

const state = {
  recent: { items: [] },
  locations: { items: [{ id: 'loc', path: 'D:/', name: 'Root' }] },
  settings: { viewDepth: 1 },
};

const labels: Record<string, string> = {
  up: 'Up one level',
  back: 'Back',
  forward: 'Forward',
  recent: 'Recent',
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

function Empty(): null {
  return null;
}

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

before(async () => {
  cleanupDom = globalJsdom();
  originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;

  inject('react-i18next', {
    useTranslation: () => ({ t: (key: string) => labels[key] ?? key }),
  });
  inject('react-redux', {
    useSelector: (selector: (value: typeof state) => unknown) => selector(state),
    useDispatch: () => () => undefined,
  });
  inject('-/theme', { COLUMN_HEADER_HEIGHT: 40 });
  inject('-/hooks/CurrentLocationContextProvider', {
    useCurrentLocationContext: () => ({
      currentDirectoryPath: 'D:/',
      currentLocation: { id: 'loc', path: 'D:/', isReadOnly: false },
      navigateToInLocation: () => undefined,
      goUp: () => undefined,
      goBack: () => undefined,
      goForward: () => undefined,
      canGoBack: true,
      canGoForward: true,
    }),
  });
  inject('-/hooks/DirectoryContentContextProvider', {
    useDirectoryUI: () => ({ refresh: () => undefined, loading: false }),
  });
  inject('-/hooks/IOActionsContextProvider', {
    useIOActionsContext: () => ({
      createFolder: async () => undefined,
      createFile: async () => undefined,
    }),
  });
  for (const spec of [
    '-/components/PromptDialog',
    '-/components/SearchBar',
    '-/components/BreadcrumbNav',
    '-/components/ThemeQuickToggle',
  ]) {
    inject(spec, { __esModule: true, default: Empty });
  }

  const module = await import('./FileToolbar');
  FileToolbar = module.default;
  computeFileToolbarVisibility = module.computeFileToolbarVisibility;
  FOLD_VIEW_DEPTH_BELOW = module.FOLD_VIEW_DEPTH_BELOW;
});

afterEach(cleanup);

after(() => {
  cleanupDom?.();
  if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
  else delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  for (const [id, mod] of savedModules) {
    if (mod) require_.cache[id] = mod;
    else delete require_.cache[id];
  }
});

describe('computeFileToolbarVisibility', () => {
  it('keeps everything visible at comfortable widths', () => {
    assert.deepEqual(computeFileToolbarVisibility(Infinity), {
      showViewDepth: true,
      showCreateButtons: true,
      showMoreMenu: false,
    });
    assert.deepEqual(computeFileToolbarVisibility(FOLD_VIEW_DEPTH_BELOW), {
      showViewDepth: true,
      showCreateButtons: true,
      showMoreMenu: false,
    });
  });

  it('folds the viewDepth slider into the overflow menu below its threshold', () => {
    assert.deepEqual(computeFileToolbarVisibility(FOLD_VIEW_DEPTH_BELOW - 1), {
      showViewDepth: false,
      showCreateButtons: true,
      showMoreMenu: true,
    });
  });

  it('moves create-folder / create-file into the overflow at narrow widths', () => {
    assert.deepEqual(computeFileToolbarVisibility(0), {
      showViewDepth: false,
      showCreateButtons: false,
      showMoreMenu: true,
    });
  });

  it('treats non-finite / negative widths as fully folded', () => {
    assert.deepEqual(computeFileToolbarVisibility(NaN), {
      showViewDepth: false,
      showCreateButtons: false,
      showMoreMenu: true,
    });
    assert.deepEqual(computeFileToolbarVisibility(-50), {
      showViewDepth: false,
      showCreateButtons: false,
      showMoreMenu: true,
    });
  });
});

describe('FileToolbar accessibility', () => {
  it('gives all four history/navigation icon buttons explicit names', () => {
    const { getByRole } = render(createElement(FileToolbar));

    for (const name of ['Up one level', 'Back', 'Forward', 'Recent']) {
      assert.equal(getByRole('button', { name }).getAttribute('aria-label'), name);
    }
  });
});
