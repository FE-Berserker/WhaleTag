import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
type TestingLibrary = typeof import('@testing-library/react');
let cleanup: TestingLibrary['cleanup'];
let fireEvent: TestingLibrary['fireEvent'];
let render: TestingLibrary['render'];
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { setThemeMode, setThemePreset } from '-/reducers/settings';

const require_ = createRequire(__filename);
const savedModules = new Map<string, NodeJS.Module | undefined>();
const dispatchCalls: unknown[] = [];
let cleanupDom: (() => void) | undefined;
let SettingsDialog: typeof import('./SettingsDialog').default;

const state = {
  settings: {
    themeMode: 'light',
    themePreset: 'whale',
    language: 'en',
    fontSize: 13,
    defaultLocationId: null,
    deleteToTrash: true,
    showHiddenFiles: false,
    showLunar: false,
    keybindings: {},
    // Stable reference: FulltextSection's selector falls back to a fresh `[]`,
    // and its effect would then re-run + setState on every render.
    fulltextPaths: [],
  },
  locations: { items: [] },
  workflow: { stages: [] },
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

function LanSettingsStub() {
  return <div>LAN pairing content</div>;
}

function renderDialog(
  section: 'general' | 'keyboard' | 'notifications' | 'lan',
  onClose: () => void = () => undefined
) {
  return render(
    <I18nextProvider i18n={i18next}>
      <SettingsDialog open section={section} onClose={onClose} />
    </I18nextProvider>
  );
}

function emittedCss(): string {
  return Array.from(document.styleSheets)
    .flatMap((sheet) => {
      try {
        return Array.from(sheet.cssRules).map((rule) => rule.cssText);
      } catch {
        return [];
      }
    })
    .join('\n');
}

before(async () => {
  cleanupDom = globalJsdom();
  // Load the renderer only once the document exists (same pattern as
  // SearchBar.test.tsx): react-dom probes the environment at import time, and
  // without a DOM it decides it runs in IE8 and installs the `attachEvent`
  // input polyfill, which jsdom cannot satisfy — keydown events on text inputs
  // then throw inside React before reaching any handler.
  ({ cleanup, fireEvent, render } = await import('@testing-library/react'));
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: {
      en: {
        translation: {
          settings: 'Settings',
          settingsSectionGeneral: 'General',
          settingsSectionKeyboard: 'Keyboard',
          settingsSectionLan: 'LAN',
          settingsSectionDescGeneral:
            'Theme, language and how files behave.',
          settingsSectionDescKeyboard: 'Key bindings for the file list.',
          settingsSectionDescLan:
            'Read-only access from another device on your network.',
          settingsSectionDescNotifications:
            'Remind you about tasks when WhaleTag starts.',
          settingsSearchPlaceholder: 'Search settings…',
          settingsSearchClear: 'Clear search',
          settingsSearchEmpty: 'No matching settings',
          settingsSearchResults_one: '{{count}} setting found',
          settingsSearchResults_other: '{{count}} settings found',
          keybindingsHint: 'Choose an action for each key.',
          keybindingsSearch: 'Search shortcuts…',
          resetKeybindings: 'Reset shortcuts',
          enabled: 'Enabled',
          deleteToTrash: 'Move deleted files to trash',
          showHiddenFiles: 'Show hidden files',
          showLunar: 'Show lunar calendar',
          taskReminder: 'Task reminder',
          close: 'Close',
          dark: 'Dark',
          presetMidnightPlum: 'Midnight plum',
        },
      },
    },
    interpolation: { escapeValue: false },
  });

  inject('react-redux', {
    useSelector: (selector: (value: typeof state) => unknown) => selector(state),
    useDispatch: () => (action: unknown) => {
      dispatchCalls.push(action);
      return action;
    },
  });
  inject('-/i18n', {
    SUPPORTED_LANGUAGES: ['en', 'zh', 'zh-TW', 'ja', 'ko'],
  });
  inject('-/hooks/CurrentLocationContextProvider', {
    useCurrentLocationContext: () => ({ currentLocation: null }),
  });
  inject('-/services/ipc-api', {
    ipcApi: {
      // The "advanced" tab renders the full-text index section, which subscribes
      // to progress and probes each path on mount.
      onIndexProgress: () => () => undefined,
      hasFulltextIndex: async () => false,
      buildFulltextIndex: async () => ({ count: 0 }),
    },
  });
  for (const spec of [
    './UpdateSection',
    './UserCommandsSection',
    './McpSection',
    './ExtensionsSection',
    '-/components/WorkflowManagerDialog',
  ]) {
    inject(spec, { __esModule: true, default: Empty });
  }
  inject('./LanSettings', { __esModule: true, default: LanSettingsStub });

  SettingsDialog = (await import('./SettingsDialog')).default;
});

afterEach(() => {
  cleanup();
  dispatchCalls.length = 0;
  state.settings.themeMode = 'light';
  state.settings.themePreset = 'whale';
});

after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  cleanupDom?.();
  for (const [id, mod] of savedModules) {
    if (mod) require_.cache[id] = mod;
    else delete require_.cache[id];
  }
});

describe('SettingsDialog accessibility', () => {
  it('names all three general Switches without a static Enabled label', () => {
    const { getAllByRole, getByRole, queryByText } = renderDialog('general');

    // The third switch is Delete to trash; all three expose their own checked
    // state, so the two old always-on text labels were redundant and wrong.
    assert.equal(getAllByRole('switch').length, 3);
    getByRole('switch', { name: 'Move deleted files to trash' });
    getByRole('switch', { name: 'Show hidden files' });
    getByRole('switch', { name: 'Show lunar calendar' });
    assert.equal(queryByText('Enabled'), null);
  });

  it('exposes the sections as a vertical tablist and routes to the panel', () => {
    const { getAllByRole, getByRole, getByText } = renderDialog('lan');

    const tablist = getByRole('tablist', { name: 'Settings' });
    assert.equal(tablist.getAttribute('aria-orientation'), 'vertical');
    assert.equal(getAllByRole('tab').length, 11);

    const lanTab = getByRole('tab', { name: 'LAN' });
    assert.equal(lanTab.getAttribute('aria-selected'), 'true');
    // Roving tabindex: only the active tab is in the page's tab order.
    assert.equal(lanTab.getAttribute('tabindex'), '0');
    assert.equal(lanTab.getAttribute('aria-controls'), 'settings-section-panel');
    const panel = getByRole('tabpanel');
    assert.equal(panel.getAttribute('id'), 'settings-section-panel');
    assert.equal(panel.getAttribute('aria-labelledby'), lanTab.id);
    getByText('LAN pairing content');
  });

  it('moves selection with Arrow/Home/End inside the tablist', () => {
    const view = renderDialog('general');
    const tabs = view.getAllByRole('tab');
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
    assert.equal(tabs[0].getAttribute('tabindex'), '0');
    assert.equal(tabs[1].getAttribute('tabindex'), '-1');

    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'ArrowDown' });
    // Automatic activation: focus and selection move together, so the user
    // never has to press Enter on a tab they just arrowed to.
    assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
    assert.equal(tabs[1].getAttribute('tabindex'), '0');
    assert.equal(document.activeElement, tabs[1]);

    fireEvent.keyDown(tabs[1], { key: 'End' });
    assert.equal(tabs[tabs.length - 1].getAttribute('aria-selected'), 'true');

    fireEvent.keyDown(tabs[tabs.length - 1], { key: 'Home' });
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
    assert.equal(document.activeElement, tabs[0]);

    // Wrapping in both directions keeps the list a closed loop.
    fireEvent.keyDown(tabs[0], { key: 'ArrowUp' });
    assert.equal(tabs[tabs.length - 1].getAttribute('aria-selected'), 'true');
  });

  it('names the task reminder Switch in the notifications section', () => {
    const { getByRole } = renderDialog('notifications');
    getByRole('switch', { name: 'Task reminder' });
  });

  it('names the shortcut search and emits a theme-aware focus-visible ring', () => {
    const { getByRole } = renderDialog('keyboard');
    const input = getByRole('textbox', {
      name: 'Search shortcuts…',
    }) as HTMLInputElement;

    assert.equal(input.style.outline, '');
    const css = emittedCss();
    assert.match(css, /:focus-visible/);
    assert.match(css, /outline:\s*2px solid/i);
    assert.match(css, /outline-color:\s*(?:#1976d2|rgb\(25,\s*118,\s*210\))/i);
    assert.match(css, /outline-offset:\s*2px/i);
  });
});

describe('SettingsDialog theme consistency', () => {
  it('resets a stale curated preset when choosing a classic mode', () => {
    state.settings.themeMode = 'midnight-plum';
    state.settings.themePreset = 'midnight-plum';
    const view = renderDialog('general');

    fireEvent.click(view.getByRole('radio', { name: 'Dark' }));

    assert.deepEqual(dispatchCalls, [
      setThemeMode('dark'),
      setThemePreset('whale'),
    ]);
  });
});

describe('SettingsDialog sections and search', () => {
  it('renders the active section title and description in the panel', () => {
    const { getByRole, getByText } = renderDialog('general');

    getByRole('heading', { name: 'General' });
    getByText('Theme, language and how files behave.');
  });

  it('closes from the header button', () => {
    let closed = false;
    const view = renderDialog('general', () => {
      closed = true;
    });

    fireEvent.click(view.getByRole('button', { name: 'Close' }));
    assert.equal(closed, true);
  });

  it('Escape in the search box clears the query without closing the dialog; on an empty box it closes', () => {
    let closed = 0;
    const view = renderDialog('general', () => {
      closed += 1;
    });
    const search = view.getByRole('textbox', {
      name: 'Search settings…',
    }) as HTMLInputElement;

    fireEvent.input(search, { target: { value: 'shortcut' } });
    fireEvent.keyDown(search, { key: 'Escape' });
    // The keydown bubbles to the Modal root, whose handler closes the dialog
    // on `escapeKeyDown` — the search box has to stop it while it has text.
    assert.equal(search.value, '');
    assert.equal(closed, 0, 'clearing the search must not close the dialog');

    fireEvent.keyDown(search, { key: 'Escape' });
    assert.equal(closed, 1, 'Escape on an empty search box closes the dialog');
  });

  it('filters settings by keyword and shows the matching section', () => {
    const view = renderDialog('general');
    const search = view.getByRole('textbox', { name: 'Search settings…' });

    fireEvent.input(search, { target: { value: 'shortcut' } });

    const panelText = view.baseElement.textContent ?? '';
    assert.ok(panelText.includes('1 setting found'));
    assert.ok(panelText.includes('Choose an action for each key.'));
    assert.ok(!panelText.includes('settingsAppearance'));
    assert.ok(view.baseElement.querySelector('#settings-section-panel button'));
  });

  it('reports when no setting matches the query', () => {
    const view = renderDialog('general');
    const search = view.getByRole('textbox', { name: 'Search settings…' });

    fireEvent.input(search, { target: { value: 'zzzz-no-such-setting' } });
    view.getByText('No matching settings');
  });
});
