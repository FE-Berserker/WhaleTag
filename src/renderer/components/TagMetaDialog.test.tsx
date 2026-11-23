import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { setTagColor } from '-/reducers/settings';
import { TAG_PALETTE } from '../domain/tag-colors';

const require_ = createRequire(__filename);
const savedModules = new Map<string, NodeJS.Module | undefined>();
const dispatchCalls: unknown[] = [];
/** Ordered log of side effects, to prove the commit order. */
const effects: string[] = [];
let setDescriptionImpl: (tag: string, description: string) => Promise<void>;
let closeCalls = 0;
let cleanupDom: (() => void) | undefined;
let TagMetaDialog: typeof import('./TagMetaDialog').default;

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

function renderDialog() {
  return render(
    <I18nextProvider i18n={i18next}>
      <TagMetaDialog open tag="work" onClose={() => (closeCalls += 1)} />
    </I18nextProvider>
  );
}

before(async () => {
  cleanupDom = globalJsdom();
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: {
      en: {
        translation: {
          editTag: 'Edit tag',
          changeColor: 'Color',
          clearColor: 'Clear color',
          tagDescription: 'Description',
          tagDescriptionPlaceholder: 'What is this tag for?',
          cancel: 'Cancel',
          save: 'Save',
        },
      },
    },
    interpolation: { escapeValue: false },
  });
  inject('react-redux', {
    useSelector: (selector: (value: unknown) => unknown) =>
      selector({ settings: { tagColors: {} } }),
    useDispatch: () => (action: unknown) => {
      dispatchCalls.push(action);
      effects.push('color');
      return action;
    },
  });
  inject('-/hooks/LocationTagLibraryContextProvider', {
    useLocationTagLibrary: () => ({
      descriptions: {},
      setDescription: (tag: string, description: string) => {
        effects.push('description');
        return setDescriptionImpl(tag, description);
      },
    }),
  });
  TagMetaDialog = (await import('./TagMetaDialog')).default;
});

afterEach(() => {
  cleanup();
  dispatchCalls.length = 0;
  effects.length = 0;
  closeCalls = 0;
});

after(() => {
  cleanupDom?.();
  for (const [id, mod] of savedModules) {
    if (mod) require_.cache[id] = mod;
    else delete require_.cache[id];
  }
});

describe('TagMetaDialog save atomicity', () => {
  it('does not commit the color when the description write fails', async () => {
    setDescriptionImpl = async () => {
      throw new Error('sidecar write failed');
    };
    const view = renderDialog();
    fireEvent.click(view.getByRole('button', { name: TAG_PALETTE[0] }));
    fireEvent.click(view.getByRole('button', { name: 'Save' }));

    await waitFor(() => assert.ok(view.getByText('sidecar write failed')));

    // The color used to be dispatched first, so a failed description left the
    // new color applied (and persisted) while the dialog reported an error.
    assert.equal(dispatchCalls.length, 0);
    assert.equal(closeCalls, 0);
    assert.ok(view.getByRole('dialog'));
  });

  it('commits the description first, then the color, then closes', async () => {
    setDescriptionImpl = async () => undefined;
    const view = renderDialog();
    fireEvent.click(view.getByRole('button', { name: TAG_PALETTE[0] }));
    fireEvent.click(view.getByRole('button', { name: 'Save' }));

    await waitFor(() => assert.equal(closeCalls, 1));
    assert.deepEqual(effects, ['description', 'color']);
    assert.deepEqual(dispatchCalls, [setTagColor('work', TAG_PALETTE[0])]);
  });
});
