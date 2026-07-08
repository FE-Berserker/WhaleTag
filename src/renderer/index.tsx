import React from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { I18nextProvider } from 'react-i18next';

import { store, persistor } from '-/store/configureStore';
import i18n from '-/i18n';
import { PersistGate } from 'redux-persist/integration/react';
import Root from '-/containers/Root';
import ErrorBoundary from '-/components/ErrorBoundary';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found in index.html');
}

createRoot(container).render(
  <React.StrictMode>
    <Provider store={store}>
      <PersistGate loading={null} persistor={persistor}>
        <I18nextProvider i18n={i18n}>
          {/* ThemeProvider + CssBaseline live in Root.tsx so the theme can read
              the persisted `settings.themeMode` reactively. */}
          <ErrorBoundary>
            <Root />
          </ErrorBoundary>
        </I18nextProvider>
      </PersistGate>
    </Provider>
  </React.StrictMode>
);
