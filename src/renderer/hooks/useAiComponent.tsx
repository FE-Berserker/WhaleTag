import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { ipcApi } from '-/services/ipc-api';
import type {
  AiComponentInstallResult,
  AiComponentState,
  AiComponentUninstallResult,
} from '../../shared/ai-types';

/**
 * Optional AI component status + lifecycle, shared app-wide via Context.
 *
 * WHY A CONTEXT (not a plain hook): Sidebar AND the Settings → AI panel both
 * need the install state, and an install triggered from Settings must
 * immediately enable the Sidebar's AI button. A plain hook gives each consumer
 * its own independent state, so an install in Settings would not refresh the
 * Sidebar (the exact bug: "installed but button still says not installed").
 * The Context holds a single state; install/uninstall mutate it once and every
 * consumer re-renders together.
 */
export interface AiComponentContextValue {
  state: AiComponentState;
  loading: boolean;
  install: (filePath: string) => Promise<AiComponentInstallResult>;
  uninstall: () => Promise<AiComponentUninstallResult>;
  refresh: () => Promise<AiComponentState>;
}

const AiComponentContext = createContext<AiComponentContextValue | null>(null);

export function AiComponentProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [state, setState] = useState<AiComponentState>({ installed: false });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const s = await ipcApi.aiGetComponentState();
      if (!cancelled) {
        setState(s);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    const s = await ipcApi.aiGetComponentState();
    setState(s);
    return s;
  }, []);

  const install = useCallback(async (filePath: string) => {
    const result = await ipcApi.aiInstallComponent(filePath);
    if (result.ok && result.state) setState(result.state);
    return result;
  }, []);

  const uninstall = useCallback(async () => {
    const result = await ipcApi.aiUninstallComponent();
    if (result.ok) setState({ installed: false });
    return result;
  }, []);

  const value: AiComponentContextValue = {
    state,
    loading,
    install,
    uninstall,
    refresh,
  };

  return (
    <AiComponentContext.Provider value={value}>
      {children}
    </AiComponentContext.Provider>
  );
}

export function useAiComponent(): AiComponentContextValue {
  const ctx = useContext(AiComponentContext);
  if (!ctx) {
    throw new Error('useAiComponent must be used within an AiComponentProvider');
  }
  return ctx;
}
