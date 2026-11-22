import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
type TestingLibrary = typeof import('@testing-library/react');
let cleanup: TestingLibrary['cleanup'];
let fireEvent: TestingLibrary['fireEvent'];
let render: TestingLibrary['render'];
let waitFor: TestingLibrary['waitFor'];
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
let Provider: typeof import('react-redux').Provider;
import { createStore } from 'redux';

const require_ = createRequire(__filename);
const savedModules = new Map<string, NodeJS.Module | undefined>();
const queries: string[] = [];
let componentId = '';
let cleanupDom: (() => void) | undefined;
let SearchBarComponent: typeof import('./SearchBar').default;
let advancedError: Error | null = null;
let advancedReady = false;

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

before(async () => {
  cleanupDom = globalJsdom();
  ({ Provider } = await import('react-redux'));
  ({ cleanup, fireEvent, render, waitFor } = await import(
    '@testing-library/react'
  ));
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: { search: 'Search' } } },
  });
  inject('-/hooks/LocationIndexContextProvider', {
    useLocationIndexContext: () => ({
      status: 'ready',
      progress: null,
      build: async () => undefined,
      search: async (query: string) => {
        queries.push(query);
        return [];
      },
    }),
  });
  inject('-/hooks/CurrentLocationContextProvider', {
    useCurrentLocationContext: () => ({
      currentLocation: null,
      navigateTo: () => undefined,
      navigateToInLocation: () => undefined,
    }),
  });
  inject('-/components/AdvancedSearchDialog', {
    __esModule: true,
    default: () => {
      if (advancedError) throw advancedError;
      return advancedReady ? <div>Advanced search recovered</div> : null;
    },
  });
  inject('-/services/fulltext-search', {
    searchAllFulltext: async () => [],
  });
  inject('-/services/ipc-api', { ipcApi: {} });

  componentId = require_.resolve('./SearchBar');
  delete require_.cache[componentId];
  SearchBarComponent = require_('./SearchBar')
    .default as typeof import('./SearchBar').default;
});

afterEach(() => {
  cleanup();
  queries.length = 0;
  advancedError = null;
  advancedReady = false;
});
after(() => {
  if (componentId) delete require_.cache[componentId];
  for (const [id, original] of savedModules) {
    if (original) require_.cache[id] = original;
    else delete require_.cache[id];
  }
  cleanupDom?.();
});

describe('SearchBar IME search', () => {
  it('does not search for composing Enter or keyCode 229', async () => {
    const store = createStore(() => ({
      settings: { fulltextPaths: [] },
      locations: { items: [] },
    }));
    const view = render(
      <Provider store={store}>
        <I18nextProvider i18n={i18next}>
          <SearchBarComponent />
        </I18nextProvider>
      </Provider>
    );
    const input = view.getByPlaceholderText('Search');
    fireEvent.change(input, { target: { value: 'notes' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    assert.deepEqual(queries, []);

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => assert.deepEqual(queries, ['notes']));
  });
});

describe('SearchBar advanced dialog recovery', () => {
  it('retries the lazy dialog when the toolbar button is clicked again', async (t) => {
    t.mock.method(console, 'error', () => undefined);
    advancedError = new Error('advanced chunk failed');
    const store = createStore(() => ({
      settings: { fulltextPaths: [] },
      locations: { items: [] },
    }));
    const view = render(
      <Provider store={store}>
        <I18nextProvider i18n={i18next}>
          <SearchBarComponent />
        </I18nextProvider>
      </Provider>
    );

    const advancedButton = view.getByRole('button', {
      name: 'advancedSearch',
    });
    fireEvent.click(advancedButton);
    await waitFor(() => assert.ok(view.getByText('errorOccurred')));

    advancedError = null;
    advancedReady = true;
    fireEvent.click(advancedButton);
    await waitFor(() =>
      assert.ok(view.getByText('Advanced search recovered'))
    );
    assert.equal(view.queryByText('errorOccurred'), null);
  });
});
