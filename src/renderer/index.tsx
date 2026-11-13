import React from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { I18nextProvider } from 'react-i18next';

import { store, persistor } from '-/store/configureStore';
import i18n from '-/i18n';
import { PersistGate } from 'redux-persist/integration/react';
import Root from '-/containers/Root';
import ErrorBoundary from '-/components/ErrorBoundary';
import UserCommandTemplateSync from '-/components/UserCommandTemplateSync';
import {
  errorDetail,
  installBootGuard,
  showRecoveryOverlay,
} from '-/services/boot-guard';

/**
 * Report renderer failures through preload so main can append them to
 * `<userData>/crash.log` (see docs/01 §14). The bridge may be gone when this
 * runs; a diagnostics path must never throw.
 */
function reportRendererError(detail: string): void {
  try {
    window.whale?.reportRendererError(detail);
  } catch {
    // Preload missing or torn down — the console already has the error.
  }
}

/** Mount beacon: tells the boot guard the React tree is alive. */
function BootReady({ onReady }: { onReady: () => void }): null {
  React.useEffect(() => {
    onReady();
  }, [onReady]);
  return null;
}

const container = document.getElementById('root');

if (!container) {
  const detail = 'boot: #root container not found in index.html';
  reportRendererError(detail);
  showRecoveryOverlay(document, {
    title: 'WhaleTag could not start',
    detail,
  });
} else {
  // Install before React: a module-level throw or a hung rehydration must not
  // leave a silent white window.
  const boot = installBootGuard({
    document,
    window,
    report: reportRendererError,
  });

  try {
    createRoot(container).render(
      <React.StrictMode>
        <Provider store={store}>
          <PersistGate loading={null} persistor={persistor}>
            <I18nextProvider i18n={i18n}>
              {/* ThemeProvider + CssBaseline live in Root.tsx so the theme can
                  read the persisted `settings.themeMode` reactively. */}
              <ErrorBoundary>
                <BootReady onReady={boot.markReady} />
                {/* Main keeps a fail-closed allow-list of command templates. */}
                <UserCommandTemplateSync />
                <Root />
              </ErrorBoundary>
            </I18nextProvider>
          </PersistGate>
        </Provider>
      </React.StrictMode>
    );
  } catch (error) {
    const detail = errorDetail(error);
    reportRendererError(`boot: ${detail}`);
    showRecoveryOverlay(document, {
      title: 'WhaleTag could not start',
      detail,
    });
  }
}
