import globalJsdom from 'global-jsdom';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { createElement } from 'react';
type TestingLibrary = typeof import('@testing-library/react');
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import type { ExtensionTab } from '-/hooks/ExtensionContextProvider';

let cleanup: TestingLibrary['cleanup'];
let fireEvent: TestingLibrary['fireEvent'];
let render: TestingLibrary['render'];
let ExtensionTabButton: typeof import('./ExtensionTabButton').default;
let jsdomCleanup: (() => void) | null = null;

let editState: Record<string, { dirty?: boolean; saving?: boolean }>;
const capturedSelectors: Array<(state: unknown) => unknown> = [];

const require_ = createRequire(__filename);
const savedCache = new Map<string, NodeJS.Module | undefined>();

function injectMock(moduleName: string, exports: unknown): void {
  const modulePath = require_.resolve(moduleName);
  savedCache.set(modulePath, require_.cache[modulePath]);
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

function makeTab(overrides: Partial<ExtensionTab> = {}): ExtensionTab {
  return {
    id: '/tmp/doc.txt::text-editor',
    locationId: 'loc-1',
    filePath: '/tmp/doc.txt',
    manifestId: 'text-editor',
    manifest: {
      id: 'text-editor',
      name: 'Text Editor',
      type: 'editor',
      color: '#123456',
      fileTypes: ['txt'],
      entryPoint: 'index.html',
      enabled: true,
      isDefault: true,
    },
    fileContent: 'disk',
    encoding: 'utf8',
    readOnly: false,
    title: 'doc.txt',
    lastAccessed: 1,
    ...overrides,
  };
}

before(async () => {
  jsdomCleanup = globalJsdom() as unknown as () => void;
  editState = {};
  injectMock('react-redux', {
    useSelector: (selector: (state: unknown) => unknown) => {
      capturedSelectors.push(selector);
      return selector({ extensions: { editState } });
    },
  });
  try {
    delete require_.cache[require_.resolve('./ExtensionTabButton')];
  } catch {
    // Not loaded yet.
  }
  ExtensionTabButton = require_('./ExtensionTabButton').default;
  ({ cleanup, fireEvent, render } = await import('@testing-library/react'));
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: { close: 'Close' } } },
  });
});

afterEach(() => {
  cleanup();
  capturedSelectors.length = 0;
  editState = {};
});

after(() => {
  jsdomCleanup?.();
  for (const [modulePath, original] of savedCache.entries()) {
    if (original) require_.cache[modulePath] = original;
    else delete require_.cache[modulePath];
  }
});

function renderTab(
  tab: ExtensionTab,
  overrides: { active?: boolean; onActivate?: (id: string) => void; onClose?: (id: string) => void } = {}
) {
  const onActivate = overrides.onActivate ?? (() => {});
  const onClose = overrides.onClose ?? (() => {});
  return render(
    createElement(
      I18nextProvider,
      { i18n: i18next },
      createElement(ExtensionTabButton, {
        tab,
        active: overrides.active ?? false,
        onActivate,
        onClose,
      })
    )
  );
}

describe('ExtensionTabButton', () => {
  it('subscribes to this tab\'s dirty boolean, not the whole editState map', () => {
    editState = {
      'tab-1': { dirty: true, saving: true },
      'other-tab': { dirty: false, saving: false },
    };
    const view = renderTab(makeTab({ id: 'tab-1' }));
    const selector = capturedSelectors[0];
    assert.ok(selector, 'tab must subscribe to a dirty value');
    // The selector's output is a primitive, so a saving-flag toggle on the same
    // entry cannot force this tab (or the bar) to re-render.
    assert.equal(selector({ extensions: { editState: { 'tab-1': { dirty: true, saving: true } } } }), true);
    assert.equal(selector({ extensions: { editState: { 'tab-1': { dirty: true, saving: false } } } }), true);
    assert.equal(selector({ extensions: { editState: { 'tab-1': { dirty: false } } } }), false);
    assert.equal(selector({ extensions: { editState: { 'other-tab': { dirty: true } } } }), false);
    assert.equal(selector({ extensions: { editState: {} } }), false);
    // A dirty tab shows the trailing bullet.
    assert.ok(view.getByText('doc.txt •'));
  });

  it('hides the bullet for a clean tab and marks the active one', () => {
    editState = {};
    const view = renderTab(makeTab({ id: 'tab-1' }), { active: true });
    assert.ok(view.getByText('doc.txt'));
    assert.equal(view.queryByText('doc.txt •'), null);
    assert.equal(view.getByRole('tab').getAttribute('aria-selected'), 'true');
  });

  it('activates on click and closes without activating', () => {
    editState = {};
    const activated: string[] = [];
    const closed: string[] = [];
    const view = renderTab(makeTab({ id: 'tab-1' }), {
      onActivate: (id) => activated.push(id),
      onClose: (id) => closed.push(id),
    });

    fireEvent.click(view.getByRole('tab'));
    assert.deepEqual(activated, ['tab-1']);

    fireEvent.click(view.getByRole('button', { name: 'Close' }));
    assert.deepEqual(closed, ['tab-1']);
    assert.deepEqual(activated, ['tab-1'], 'close must not activate the tab');
  });
});
