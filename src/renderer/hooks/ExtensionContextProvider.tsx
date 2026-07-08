import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from 'react';
import type { DirEntry } from '../../shared/ipc-types';
import type {
  ExtensionManifest,
  ExtensionRegistry,
  ExtensionEncoding,
} from '../../shared/extension-types';
import { ipcApi } from '-/services/ipc-api';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { selectExtension } from '-/services/extension-dispatch';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '-/reducers';
import { loadExtensionRegistry } from '-/reducers/extensions';

import { isBinaryExtension, isAudioTranscodeFile } from '../../shared/whale-meta';

export interface ActiveExtensionView {
  manifest: ExtensionManifest;
  filePath: string;
  fileContent: string;
  encoding: ExtensionEncoding;
  readOnly: boolean;
  /** File size in bytes, populated by `readFileContent` and forwarded to the
   *  extension via `FileContentMessage.size`. Optional — extensions that
   *  don't need it can ignore it. */
  fileSize?: number;
}

export interface ExtensionContextValue {
  registry: ExtensionRegistry | null;
  userDefaults: Record<string, string>;
  enabledOverrides: Record<string, boolean>;
  activeView: ActiveExtensionView | null;
  loading: boolean;
  error: string | null;
  openFile: (entry: DirEntry, preferredManifest?: ExtensionManifest) => Promise<void>;
  openWithExtension: (entry: DirEntry, manifest: ExtensionManifest) => Promise<void>;
  closeView: () => void;
  reloadContent: () => Promise<void>;
}

const ExtensionContext = createContext<ExtensionContextValue | null>(null);

export function useExtensionContext(): ExtensionContextValue {
  const ctx = useContext(ExtensionContext);
  if (!ctx) {
    throw new Error('useExtensionContext must be used within ExtensionContextProvider');
  }
  return ctx;
}

interface ExtensionContextProviderProps {
  children: ReactNode;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function extOf(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  return dot > 0 ? filePath.slice(dot + 1).toLowerCase() : '';
}

export function ExtensionContextProvider({
  children,
}: ExtensionContextProviderProps) {
  const dispatch = useDispatch();
  const { currentLocation } = useCurrentLocationContext();
  const registry = useSelector((s: RootState) => s.extensions.registry);
  const userDefaults = useSelector((s: RootState) => s.extensions.userDefaults);
  const enabledOverrides = useSelector(
    (s: RootState) => s.extensions.enabledOverrides
  );

  const [activeView, setActiveView] = useState<ActiveExtensionView | null>(
    null
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load registry once on mount.
  useEffect(() => {
    let mounted = true;
    ipcApi
      .loadExtensionRegistry()
      .then((reg) => {
        if (mounted) dispatch(loadExtensionRegistry(reg));
      })
      .catch(() => {
        if (mounted) dispatch(loadExtensionRegistry(null));
      });
    return () => {
      mounted = false;
    };
  }, [dispatch]);

  // Sync allowed roots with main whenever locations change.
  useEffect(() => {
    // Roots come from the locations slice; this provider only knows the active
    // location, but the full list is needed for allowedRoots. We read it from
    // window.whale via ipcApi by piggybacking on the next setAllowedRoots call.
    // The actual roots are set in MainLayout from the locations slice.
  }, []);

  const readFileContent = useCallback(
    async (
      filePath: string
    ): Promise<{ content: string; encoding: ExtensionEncoding; size: number }> => {
      const ext = extOf(filePath);
      // media-player transcodes these from the PATH alone (the host re-reads the
      // file during transcode). Reading the source here would base64 tens of MB
      // — bytes media-player throws away — and freeze the renderer (a 50 MB APE
      // → ~67 MB base64 string over IPC + postMessage). Skip the read entirely.
      if (isAudioTranscodeFile(filePath)) {
        return { content: '', encoding: 'base64', size: 0 };
      }
      if (isBinaryExtension(ext)) {
        const buffer = await ipcApi.readFile(filePath);
        return {
          content: arrayBufferToBase64(buffer),
          encoding: 'base64',
          size: buffer.byteLength,
        };
      }
      const text = await ipcApi.readTextFile(filePath);
      // Polyfill-free UTF-8 byte count (works in renderer, jsdom, modern browsers).
      return {
        content: text,
        encoding: 'utf8',
        size: new TextEncoder().encode(text).byteLength,
      };
    },
    []
  );

  const openWithExtension = useCallback(
    async (entry: DirEntry, manifest: ExtensionManifest) => {
      setLoading(true);
      setError(null);
      try {
        // media-player 的视频和原生可解码音频直接走 whale-file:// 流式 URL，
        // 避免把整份文件 base64 进渲染进程（大视频会卡死 / OOM）。
        let content: string;
        let encoding: ExtensionEncoding;
        let size: number;
        if (manifest.id === 'media-player' && !isAudioTranscodeFile(entry.name)) {
          content = '';
          encoding = 'base64';
          size = entry.size;
        } else {
          const result = await readFileContent(entry.path);
          content = result.content;
          encoding = result.encoding;
          size = result.size;
        }
        setActiveView({
          manifest,
          filePath: entry.path,
          fileContent: content,
          encoding,
          readOnly: currentLocation?.isReadOnly ?? false,
          fileSize: size,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [currentLocation, readFileContent]
  );

  const openFile = useCallback(
    async (entry: DirEntry, preferredManifest?: ExtensionManifest) => {
      if (preferredManifest) {
        await openWithExtension(entry, preferredManifest);
        return;
      }
      const manifest = selectExtension(entry, {
        registry,
        userDefaults,
        enabledOverrides,
      });
      if (manifest) {
        await openWithExtension(entry, manifest);
      }
    },
    [registry, userDefaults, enabledOverrides, openWithExtension]
  );

  const closeView = useCallback(() => {
    setActiveView(null);
    setError(null);
  }, []);

  const reloadContent = useCallback(async () => {
    if (!activeView) return;
    const { content, encoding, size } = await readFileContent(activeView.filePath);
    setActiveView({ ...activeView, fileContent: content, encoding, fileSize: size });
  }, [activeView, readFileContent]);

  const value: ExtensionContextValue = {
    registry,
    userDefaults,
    enabledOverrides,
    activeView,
    loading,
    error,
    openFile,
    openWithExtension,
    closeView,
    reloadContent,
  };

  return (
    <ExtensionContext.Provider value={value}>{children}</ExtensionContext.Provider>
  );
}
