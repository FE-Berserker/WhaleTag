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
        // These viewers stream their file via `whale-file://` (Range-served by
        // the main process) instead of receiving the whole file base64-encoded
        // through IPC + postMessage. The iframe asks the host for a streaming
        // URL via `requestStreamingUrl` and feeds it to its player/viewer.
        // Avoids freezing the renderer on large files — a 50 MB PDF → ~67 MB
        // base64 + O(n²) `binary += String.fromCharCode(...)` string concat on
        // the main thread; same shape for big APE rips that media-player
        // throws away after transcoding. `isAudioTranscodeFile` is handled by
        // `readFileContent`'s own short-circuit (returns empty), so it stays
        // on the non-streamed branch.
        const isStreamed =
          manifest.id === 'pdf-viewer' ||
          (manifest.id === 'media-player' && !isAudioTranscodeFile(entry.name));
        let content: string;
        let encoding: ExtensionEncoding;
        let size: number;
        if (isStreamed) {
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
    // Streamed viewers (pdf-viewer / non-transcode media-player) don't carry
    // file bytes in `fileContent` — they re-request a `whale-file://` URL on
    // every content push. Keep them on the empty-content path so a reload
    // doesn't base64 a 50 MB PDF back into the renderer (same freeze the
    // initial open avoids — see openWithExtension).
    const manifestId = activeView.manifest.id;
    const isStreamed =
      manifestId === 'pdf-viewer' ||
      (manifestId === 'media-player' && !isAudioTranscodeFile(activeView.filePath));
    let content: string;
    let encoding: ExtensionEncoding;
    let size: number;
    if (isStreamed) {
      content = '';
      encoding = 'base64';
      size = activeView.fileSize ?? 0;
    } else {
      const result = await readFileContent(activeView.filePath);
      content = result.content;
      encoding = result.encoding;
      size = result.size;
    }
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
