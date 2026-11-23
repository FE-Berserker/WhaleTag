import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import type { IndexEntry } from '../../shared/ipc-types';

const require_ = createRequire(__filename);
const savedModules = new Map<string, NodeJS.Module | undefined>();
let cleanupDom: (() => void) | undefined;
let cleanup: typeof import('@testing-library/react').cleanup;
let fireEvent: typeof import('@testing-library/react').fireEvent;
let render: typeof import('@testing-library/react').render;
let waitFor: typeof import('@testing-library/react').waitFor;
let AdvancedSearchDialog: typeof import('./AdvancedSearchDialog').default;
let I18nextProvider: typeof import('react-i18next').I18nextProvider;
let initReactI18next: typeof import('react-i18next').initReactI18next;
let i18next: typeof import('i18next').default;

interface Pending {
  resolve: (rows: IndexEntry[]) => void;
  reject: (error: unknown) => void;
}
let pending: Pending | null = null;

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

function entry(index: number): IndexEntry {
  return {
    path: `/lib/file-${index}.md`,
    name: `file-${index}.md`,
    isDir: false,
  } as IndexEntry;
}

const state = {
  savedsearches: { items: [] },
  settings: { tagColors: {} },
  taglibrary: { groups: [] },
};

before(async () => {
  cleanupDom = globalJsdom();
  ({ cleanup, fireEvent, render, waitFor } = await import('@testing-library/react'));
  ({ I18nextProvider, initReactI18next } = await import('react-i18next'));
  ({ default: i18next } = await import('i18next'));

  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: {
      en: {
        translation: {
          advancedSearch: 'Advanced search',
          search: 'Search',
          searching: 'Searching…',
          resultsCount_one: '{{count}} result',
          resultsCount_other: '{{count}} results',
          resultsTruncated:
            'Showing the first {{shown}} of {{total}} results — narrow the filters to see the rest.',
          close: 'Close',
          reset: 'Reset',
          saveSearch: 'Save search',
          searchName: 'Search name',
          cancel: 'Cancel',
          retry: 'Retry',
        },
      },
    },
    interpolation: { escapeValue: false },
  });

  inject('react-redux', {
    useSelector: (selector: (s: unknown) => unknown) => selector(state),
    useDispatch: () => () => undefined,
  });
  inject('-/hooks/CurrentLocationContextProvider', {
    useCurrentLocationContext: () => ({
      currentLocation: { id: 'loc-1', path: '/lib', name: 'Library' },
      navigateTo: () => undefined,
    }),
  });
  inject('-/services/ipc-api', {
    ipcApi: {
      indexTags: async () => [],
      advancedIndex: () =>
        new Promise<IndexEntry[]>((resolve, reject) => {
          pending = { resolve, reject };
        }),
    },
  });

  ({ default: AdvancedSearchDialog } = await import('./AdvancedSearchDialog'));
});

afterEach(() => {
  cleanup();
  pending = null;
});

after(() => {
  for (const [id, original] of savedModules) {
    if (original) require_.cache[id] = original;
    else delete require_.cache[id];
  }
  cleanupDom?.();
});

function renderDialog() {
  return render(
    <I18nextProvider i18n={i18next}>
      <AdvancedSearchDialog open onClose={() => undefined} />
    </I18nextProvider>
  );
}

describe('AdvancedSearchDialog busy and truncation', () => {
  it('marks the dialog busy until the query resolves', async () => {
    const view = renderDialog();
    fireEvent.click(view.getByRole('button', { name: 'Search' }));

    // The button no longer looks dead while main runs the SQL.
    const busyButton = await view.findByRole('button', { name: 'Searching…' });
    assert.equal((busyButton as HTMLButtonElement).disabled, true);
    view.getByRole('progressbar', { name: 'Searching…' });

    assert.ok(pending);
    pending.resolve([entry(1)]);
    await view.findByText('1 result');
    assert.equal(
      view.getByRole('button', { name: 'Search' }).hasAttribute('disabled'),
      false
    );
  });

  it('renders at most 300 rows and says how many were hidden', async () => {
    const view = renderDialog();
    fireEvent.click(view.getByRole('button', { name: 'Search' }));
    assert.ok(pending);
    pending.resolve(Array.from({ length: 301 }, (_, i) => entry(i)));

    const note = await view.findByText(/Showing the first 300 of 301 results/);
    assert.ok(note);

    // The count line stays truthful while the list is capped (§12 render cost).
    view.getByText('301 results');
    const rows = view.getAllByRole('button', { name: /file-\d+\.md/ });
    assert.equal(rows.length, 300);

    await waitFor(() =>
      assert.equal(view.container.querySelector('[aria-busy="true"]'), null)
    );
  });
});
