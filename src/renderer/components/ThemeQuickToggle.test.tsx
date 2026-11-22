import globalJsdom from 'global-jsdom';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { Provider } from 'react-redux';
import { combineReducers, createStore } from 'redux';

import settingsReducer, {
  initialState,
  type ThemeMode,
} from '-/reducers/settings';
import ThemeQuickToggle from './ThemeQuickToggle';

let cleanupDom: (() => void) | undefined;

before(async () => {
  cleanupDom = globalJsdom();
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: {} } },
    interpolation: { escapeValue: false },
  });
});
afterEach(() => cleanup());
after(() => cleanupDom?.());

function renderToggle(themeMode: ThemeMode, themePreset: string) {
  const reducer = combineReducers({ settings: settingsReducer });
  const store = createStore(reducer, {
    settings: { ...initialState, themeMode, themePreset },
  });
  const view = render(
    <Provider store={store}>
      <I18nextProvider i18n={i18next}>
        <ThemeQuickToggle />
      </I18nextProvider>
    </Provider>
  );
  return { store, view };
}

describe('ThemeQuickToggle preset consistency', () => {
  it('resets the default preset when cycling into light, dark, or system', () => {
    const cases: Array<{
      current: ThemeMode;
      stalePreset: string;
      next: ThemeMode;
    }> = [
      { current: 'high-contrast', stalePreset: 'high-contrast', next: 'light' },
      { current: 'light', stalePreset: 'ocean', next: 'dark' },
      { current: 'dark', stalePreset: 'forest', next: 'system' },
    ];

    for (const testCase of cases) {
      const { store, view } = renderToggle(
        testCase.current,
        testCase.stalePreset
      );
      fireEvent.click(view.getByTestId('theme-quick-toggle'));
      assert.equal(store.getState().settings.themeMode, testCase.next);
      assert.equal(store.getState().settings.themePreset, 'whale');
      view.unmount();
    }
  });

  it('keeps curated modes paired with their own preset', () => {
    const { store, view } = renderToggle('system', 'whale');
    fireEvent.click(view.getByTestId('theme-quick-toggle'));
    assert.equal(store.getState().settings.themeMode, 'warm-paper');
    assert.equal(store.getState().settings.themePreset, 'warm-paper');
  });
});
