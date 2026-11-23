import globalJsdom from 'global-jsdom';

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { createRequire } from 'module';
import { cleanup, render, waitFor } from '@testing-library/react';
import { createTheme } from '@mui/material/styles';
import type { McpAddLocationRequest } from '../../shared/mcp-types';
import type { WhaleLocation } from '../../shared/ipc-types';
import { ADD_LOCATION, REMOVE_LOCATION } from '-/reducers/locations';

const require_ = createRequire(__filename);
const savedModules = new Map<string, NodeJS.Module | undefined>();
let cleanupDom: (() => void) | undefined;
let Root: typeof import('./Root').default;
const languageChanges: string[] = [];
const i18nStub = {
  language: 'en',
  changeLanguage: async (language: string) => {
    i18nStub.language = language;
    languageChanges.push(language);
  },
};

let state: {
  settings: { themeMode: string; language: string };
  locations: { defaultLocation: null; items: WhaleLocation[] };
} = {
  settings: { themeMode: 'light', language: 'en' },
  locations: { defaultLocation: null, items: [] },
};
const dispatchedActions: unknown[] = [];
const rootPushes: { roots: string[]; readOnlyRoots: string[] }[] = [];
const completions: { reqId: string; error?: string }[] = [];
let addLocationListener: ((req: McpAddLocationRequest) => void) | null = null;
let persistFlushCount = 0;
let failNextRootPush = false;
let nextRootPushError: Error | null = null;

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

before(async () => {
  cleanupDom = globalJsdom();
  inject('react-redux', {
    useSelector: (selector: (value: typeof state) => unknown) => selector(state),
    useDispatch: () => (action: unknown) => {
      dispatchedActions.push(action);
      const typed = action as { type: string; payload: unknown };
      if (typed.type === ADD_LOCATION) {
        state = {
          ...state,
          locations: {
            ...state.locations,
            items: [...state.locations.items, typed.payload as WhaleLocation],
          },
        };
      } else if (typed.type === REMOVE_LOCATION) {
        state = {
          ...state,
          locations: {
            ...state.locations,
            items: state.locations.items.filter((item) => item.id !== typed.payload),
          },
        };
      }
    },
  });
  inject('react-i18next', {
    useTranslation: () => ({ t: (key: string) => key, i18n: i18nStub }),
  });
  inject('-/i18n', { __esModule: true, default: i18nStub });
  inject('-/services/allowed-roots', {
    setAllowedRootsAndWait: async (roots: string[], readOnlyRoots: string[]) => {
      if (failNextRootPush) {
        failNextRootPush = false;
        const error = nextRootPushError ?? new Error('injected root sync failure');
        nextRootPushError = null;
        throw error;
      }
      rootPushes.push({ roots, readOnlyRoots });
    },
  });
  inject('-/services/ipc-api', {
    ipcApi: {
      syncFulltextPaths: async () => undefined,
      cleanupRevisions: async () => undefined,
      onMcpAddLocationRequest: (cb: (req: McpAddLocationRequest) => void) => {
        addLocationListener = cb;
        return () => {
          addLocationListener = null;
        };
      },
      mcpCompleteAddLocation: async (reqId: string, error?: string) => {
        completions.push({ reqId, error });
        return { ok: true, settled: true };
      },
    },
  });
  inject('-/store/configureStore', {
    store: { getState: () => state },
    persistor: {
      flush: async () => {
        persistFlushCount += 1;
      },
    },
  });
  inject('-/theme/useResolvedThemeMode', {
    useResolvedTheme: () => ({ mode: 'light', presetId: 'whale' }),
  });
  inject('-/theme', { createWhaleTheme: () => createTheme() });
  inject('-/components/ConfirmDialogProvider', {
    ConfirmDialogProvider: ({ children }: { children: React.ReactNode }) => children,
  });
  for (const spec of [
    '-/hooks/CurrentLocationContextProvider',
    '-/hooks/DirectoryContentContextProvider',
    '-/hooks/DirectoryTreeRefreshContextProvider',
    '-/hooks/IOActionsContextProvider',
    '-/hooks/LocationIndexContextProvider',
    '-/hooks/LocationTagLibraryContextProvider',
    '-/hooks/TagMetaContextProvider',
    '-/hooks/ExtensionContextProvider',
  ]) {
    const providerName = spec.split('/').pop()!;
    inject(spec, {
      [providerName]: ({ children }: { children: React.ReactNode }) => children,
    });
  }
  inject('react-dnd', { DndProvider: Empty });
  inject('react-dnd-html5-backend', { HTML5Backend: Empty });
  for (const spec of [
    '-/components/AppNoticeHost',
    '-/components/TaskReminder',
    '-/containers/MainLayout',
  ]) {
    inject(spec, { __esModule: true, default: Empty });
  }

  Root = (await import('./Root')).default;
});

beforeEach(() => {
  languageChanges.length = 0;
  dispatchedActions.length = 0;
  rootPushes.length = 0;
  completions.length = 0;
  persistFlushCount = 0;
  failNextRootPush = false;
  nextRootPushError = null;
  addLocationListener = null;
  i18nStub.language = 'en';
  state = {
    settings: { themeMode: 'light', language: 'en' },
    locations: { defaultLocation: null, items: [] },
  };
  document.documentElement.lang = '';
});

afterEach(cleanup);

after(() => {
  cleanupDom?.();
  for (const [id, mod] of savedModules) {
    if (mod) require_.cache[id] = mod;
    else delete require_.cache[id];
  }
});

describe('Root document language', () => {
  it('synchronizes html lang on mount and when settings language changes', async () => {
    const view = render(createElement(Root));

    await waitFor(() => {
      assert.equal(document.documentElement.lang, 'en');
    });

    state = {
      ...state,
      settings: { ...state.settings, language: 'zh' },
    };
    view.rerender(createElement(Root));

    await waitFor(() => {
      assert.equal(document.documentElement.lang, 'zh');
      assert.deepEqual(languageChanges, ['zh']);
    });
  });
});

describe('Root MCP location additions', () => {
  it('dispatches, syncs roots, flushes persistence, then acknowledges', async () => {
    render(createElement(Root));
    await waitFor(() => assert.ok(addLocationListener));

    addLocationListener!({
      reqId: 'mcp-location-1',
      path: 'D:\\Reference',
      name: 'Reference',
      readOnly: true,
    });

    await waitFor(() => assert.equal(completions.length, 1));
    const action = dispatchedActions.find((value) => {
      const payload = (value as { payload?: { path?: string } }).payload;
      return payload?.path === 'D:\\Reference';
    }) as { payload: { name: string; path: string; isReadOnly: boolean } };
    assert.ok(action, 'the standard addLocation action must be dispatched');
    assert.equal(action.payload.name, 'Reference');
    assert.equal(action.payload.isReadOnly, true);
    assert.deepEqual(rootPushes.at(-1), {
      roots: ['D:\\Reference'],
      readOnlyRoots: ['D:\\Reference'],
    });
    assert.equal(persistFlushCount, 1);
    assert.deepEqual(completions, [
      { reqId: 'mcp-location-1', error: undefined },
    ]);
  });

  it('rolls back Redux, roots and persistence when the addition fails', async () => {
    render(createElement(Root));
    await waitFor(() => assert.ok(addLocationListener));
    failNextRootPush = true;
    const originalError = console.error;
    console.error = () => undefined;
    try {
      addLocationListener!({
        reqId: 'mcp-location-rollback',
        path: 'D:\\WillFail',
        name: 'WillFail',
        readOnly: false,
      });
      await waitFor(() => assert.equal(completions.length, 1));
    } finally {
      console.error = originalError;
    }

    assert.deepEqual(state.locations.items, []);
    assert.ok(
      dispatchedActions.some(
        (action) => (action as { type?: string }).type === REMOVE_LOCATION
      ),
      'the just-added location is removed before the error acknowledgement'
    );
    assert.deepEqual(rootPushes.at(-1), { roots: [], readOnlyRoots: [] });
    assert.equal(persistFlushCount, 1, 'the rollback is flushed');
    assert.match(completions[0].error ?? '', /injected root sync failure/);
  });

  it('acknowledges a non-empty failure even when the thrown message is blank', async () => {
    render(createElement(Root));
    await waitFor(() => assert.ok(addLocationListener));
    failNextRootPush = true;
    nextRootPushError = new Error('');
    const originalError = console.error;
    console.error = () => undefined;
    try {
      addLocationListener!({
        reqId: 'mcp-location-blank-error',
        path: 'D:\\BlankError',
        name: 'BlankError',
        readOnly: false,
      });
      await waitFor(() => assert.equal(completions.length, 1));
    } finally {
      console.error = originalError;
    }

    assert.deepEqual(state.locations.items, []);
    assert.equal(completions[0].error, 'location addition failed');
  });
});
