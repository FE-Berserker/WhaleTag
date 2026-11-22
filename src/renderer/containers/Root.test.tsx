import globalJsdom from 'global-jsdom';

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { createRequire } from 'module';
import { cleanup, render, waitFor } from '@testing-library/react';
import { createTheme } from '@mui/material/styles';

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

let state = {
  settings: { themeMode: 'light', language: 'en' },
  locations: { defaultLocation: null, items: [] },
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

before(async () => {
  cleanupDom = globalJsdom();
  inject('react-redux', {
    useSelector: (selector: (value: typeof state) => unknown) => selector(state),
    useDispatch: () => () => undefined,
  });
  inject('react-i18next', {
    useTranslation: () => ({ t: (key: string) => key, i18n: i18nStub }),
  });
  inject('-/i18n', { __esModule: true, default: i18nStub });
  inject('-/services/allowed-roots', {
    setAllowedRootsAndWait: async () => undefined,
  });
  inject('-/services/ipc-api', {
    ipcApi: {
      syncFulltextPaths: async () => undefined,
      cleanupRevisions: async () => undefined,
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
