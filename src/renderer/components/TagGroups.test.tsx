import globalJsdom from 'global-jsdom';

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { cleanup, fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

const require_ = createRequire(__filename);
const savedModules = new Map<string, NodeJS.Module | undefined>();
let cleanupDom: (() => void) | undefined;
let TagGroups: typeof import('./TagGroups').default;
let dispatchCalls: unknown[] = [];

const state = {
  taglibrary: {
    groups: [
      { id: 'g-work', title: 'Work', tags: [], expanded: false },
      { id: 'g-personal', title: 'Personal', tags: [], expanded: true },
    ],
    activeGroupId: null,
    collapsed: false,
  },
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
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: {
      en: {
        translation: {
          tagGroups: 'Tag groups',
          expand: 'Expand',
          collapse: 'Collapse',
        },
      },
    },
    interpolation: { escapeValue: false },
  });

  inject('react-redux', {
    useSelector: (selector: (value: typeof state) => unknown) => selector(state),
    useDispatch: () => (action: unknown) => dispatchCalls.push(action),
  });
  inject('./ConfirmDialogProvider', {
    useConfirm: () => async () => false,
  });
  inject('-/hooks/LocationTagLibraryContextProvider', {
    useLocationTagLibrary: () => ({ tagDescriptions: {} }),
  });
  inject('-/hooks/TagMetaContextProvider', {
    useTagMetaContext: () => ({ activeTag: null, setActiveTag: () => undefined }),
  });
  inject('-/components/QuickTagChips', {
    SmartTagChip: Empty,
    StageChip: Empty,
    PeriodChip: Empty,
  });
  for (const spec of [
    '-/components/PromptDialog',
    '-/components/TagMetaDialog',
  ]) {
    inject(spec, { __esModule: true, default: Empty });
  }

  TagGroups = (await import('./TagGroups')).default;
});

beforeEach(() => {
  dispatchCalls = [];
});

afterEach(cleanup);

after(() => {
  cleanupDom?.();
  for (const [id, mod] of savedModules) {
    if (mod) require_.cache[id] = mod;
    else delete require_.cache[id];
  }
});

describe('TagGroups accessibility', () => {
  it('names each expander with its group and exposes the current state', () => {
    const { getByRole } = render(
      <I18nextProvider i18n={i18next}>
        <TagGroups />
      </I18nextProvider>
    );

    const collapsed = getByRole('button', {
      name: 'Expand: Work',
      expanded: false,
    });
    getByRole('button', { name: 'Collapse: Personal', expanded: true });

    fireEvent.click(collapsed);
    assert.equal(dispatchCalls.length, 1);
    assert.deepEqual(dispatchCalls[0], {
      type: 'taglibrary/TOGGLE_GROUP',
      payload: 'g-work',
    });
  });

  it('toggles the group list from the keyboard', () => {
    const { getByRole } = render(
      <I18nextProvider i18n={i18next}>
        <TagGroups />
      </I18nextProvider>
    );

    const toggle = getByRole('button', { name: 'Tag groups' });
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');

    fireEvent.keyDown(toggle, { key: 'Enter' });
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');

    fireEvent.keyDown(toggle, { key: ' ' });
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  });
});
