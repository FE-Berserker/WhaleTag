import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
import ConfirmDiscardDialog, {
  ConfirmDiscardChoice,
} from '-/components/ConfirmDiscardDialog';
import { basename } from '-/services/path-util';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { selectExtension } from '-/services/extension-dispatch';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '-/reducers';
import {
  loadExtensionRegistry,
  clearFileEditState,
} from '-/reducers/extensions';

import {
  isBinaryExtension,
  isAudioTranscodeFile,
  isImageFile,
} from '../../shared/whale-meta';
import { MAX_TABS, makeTabId, pickLruEvict } from './extension-tabs';

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

/** A single open tab. Carries everything `ExtensionHost` needs to render the
 *  file plus tab-specific bookkeeping (`title`, `lastAccessed` for LRU). Kept
 *  mounted (display:none) while inactive so switching back is instant and
 *  doesn't reload the file — see ExtensionViewPanel's layering. */
export interface ExtensionTab {
  /** `${filePath}::${manifestId}` — dedup key + React key. */
  id: string;
  filePath: string;
  manifestId: string;
  manifest: ExtensionManifest;
  fileContent: string;
  encoding: ExtensionEncoding;
  readOnly: boolean;
  fileSize?: number;
  title: string;
  lastAccessed: number;
}

export interface ExtensionContextValue {
  registry: ExtensionRegistry | null;
  userDefaults: Record<string, string>;
  enabledOverrides: Record<string, boolean>;
  /** Derived from the active tab. Retained for consumers that haven't
   *  migrated to `tabs`/`activeTabId` yet (MainLayout, DirectoryTree). */
  activeView: ActiveExtensionView | null;
  loading: boolean;
  error: string | null;
  tabs: ExtensionTab[];
  activeTabId: string | null;
  openFile: (entry: DirEntry, preferredManifest?: ExtensionManifest) => Promise<void>;
  openWithExtension: (entry: DirEntry, manifest: ExtensionManifest) => Promise<void>;
  /** Unified "open this entry" for any UI (directory tree, etc.) without
   *  direct access to the lightbox. Images dispatch a `whale:open-lightbox`
   *  CustomEvent (FileList → MediaLightbox); other files open in a tab, or
   *  the OS default app if no extension matches. */
  openEntryInTab: (entry: DirEntry) => Promise<void>;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => Promise<'closed' | 'cancelled'>;
  reloadContent: () => Promise<void>;
  /** Close the active tab, prompting to save if it has unsaved edits.
   *  Resolves 'cancelled' if the user aborted (keep the tab open). Alias for
   *  `closeTab(activeTabId)`; kept for legacy callers. */
  requestCloseCurrent: () => Promise<'closed' | 'cancelled'>;
  /** Close the active tab (with dirty check). Kept for legacy callers. */
  closeView: () => void;
  /** Register a tab's save function (used by closeTab's "Save" branch).
   *  ExtensionHost sets it on mount, clears on unmount. */
  registerSaveCurrent: (
    tabId: string,
    fn: (() => Promise<boolean>) | null
  ) => void;
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

  const [tabs, setTabs] = useState<ExtensionTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // Mirror `tabs` into a ref so async open/close handlers can read the latest
  // list without depending on it in their deps (which would re-create them on
  // every tab change and race in-flight reads). Same pattern DirectoryTree
  // uses for childrenByPath.
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
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

  // Read a file's content for a given extension, applying the streamed-viewer
  // short-circuit (pdf-viewer / non-transcode media-player pull bytes via
  // `whale-file://` themselves, so we hand them empty content + the file size).
  const readTabContent = useCallback(
    async (
      entry: Pick<DirEntry, 'path' | 'name' | 'size'>,
      manifest: ExtensionManifest
    ): Promise<{ content: string; encoding: ExtensionEncoding; size: number }> => {
      const isStreamed =
        manifest.id === 'pdf-viewer' ||
        (manifest.id === 'media-player' && !isAudioTranscodeFile(entry.name));
      if (isStreamed) {
        return { content: '', encoding: 'base64', size: entry.size };
      }
      return readFileContent(entry.path);
    },
    [readFileContent]
  );

  // §unsaved-close — read dirty flags so we can prompt before closing a tab.
  const editStateMap = useSelector((s: RootState) => s.extensions.editState);
  // editStateMap mirror: read inside callbacks without re-creating them on
  // every dirty-flag toggle (which would churn the context value and force
  // every consumer to re-render).
  const editStateMapRef = useRef(editStateMap);
  useEffect(() => {
    editStateMapRef.current = editStateMap;
  }, [editStateMap]);

  // Per-tab save functions, registered by each ExtensionHost on mount. Keyed
  // by tab id (not a single ref) so multiple tabs can each save correctly — a
  // single ref would let a newly-mounted tab clobber the previous one's
  // handler and the wrong file would save on close.
  const saveHandlersRef = useRef<Map<string, () => Promise<boolean>>>(
    new Map()
  );
  const registerSaveCurrent = useCallback(
    (tabId: string, fn: (() => Promise<boolean>) | null) => {
      if (fn) saveHandlersRef.current.set(tabId, fn);
      else saveHandlersRef.current.delete(tabId);
    },
    []
  );

  // Reentry guard: while the discard dialog is open, a second close/switch
  // attempt (e.g. user double-clicks another file) is treated as 'cancelled'
  // so it can't open a second dialog or race the in-flight save.
  const closeInProgressRef = useRef(false);

  // Drive ConfirmDiscardDialog from a Promise: confirmDiscard resolves with
  // the user's choice once onChoose fires (ESC / backdrop → 'cancel' via the
  // Dialog's onClose, so the Promise never hangs).
  const [confirmState, setConfirmState] = useState<{
    fileName: string;
    resolve: (c: ConfirmDiscardChoice) => void;
  } | null>(null);
  const confirmDiscard = useCallback((fileName: string) => {
    return new Promise<ConfirmDiscardChoice>((resolve) => {
      setConfirmState({ fileName, resolve });
    });
  }, []);
  const resolveConfirm = useCallback(
    (choice: ConfirmDiscardChoice) => {
      confirmState?.resolve(choice);
      setConfirmState(null);
    },
    [confirmState]
  );

  // The active tab + a backwards-compatible `activeView` projection for
  // consumers that still read the single-view shape.
  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? null,
    [tabs, activeTabId]
  );
  const activeView = useMemo<ActiveExtensionView | null>(() => {
    if (!activeTab) return null;
    return {
      manifest: activeTab.manifest,
      filePath: activeTab.filePath,
      fileContent: activeTab.fileContent,
      encoding: activeTab.encoding,
      readOnly: activeTab.readOnly,
      fileSize: activeTab.fileSize,
    };
  }, [activeTab]);

  const activateTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, lastAccessed: Date.now() } : t))
    );
  }, []);

  // Close a tab, prompting to save if it has unsaved edits. Resolves
  // 'cancelled' if the user aborted (tab stays open). On close: drop the tab,
  // clear its edit state, and move focus to the nearest surviving tab.
  const closeTab = useCallback(
    async (tabId: string): Promise<'closed' | 'cancelled'> => {
      if (closeInProgressRef.current) return 'cancelled';
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return 'closed';
      const dirty = editStateMapRef.current[tab.filePath]?.dirty ?? false;
      if (dirty) {
        closeInProgressRef.current = true;
        try {
          // Focus the tab being closed so the user sees which document
          // they're being asked to save.
          setActiveTabId(tabId);
          const choice = await confirmDiscard(basename(tab.filePath));
          if (choice === 'cancel') return 'cancelled';
          if (choice === 'save') {
            const save = saveHandlersRef.current.get(tabId);
            const ok = (await save?.()) ?? false;
            if (!ok) return 'cancelled'; // save failed / timed out / read-only
          }
          // 'discard' or successful save — fall through to close.
        } finally {
          closeInProgressRef.current = false;
        }
      }
      const idx = tabsRef.current.findIndex((t) => t.id === tabId);
      const remaining = tabsRef.current.filter((t) => t.id !== tabId);
      setTabs(remaining);
      // display:none keeps inactive tabs mounted, so ExtensionHost's unmount
      // cleanup only fires now (when the tab leaves the list). Clear edit
      // state explicitly too — the unmount handler does the same and the
      // reducer delete is idempotent.
      dispatch(clearFileEditState(tab.filePath));
      setActiveTabId((prev) => {
        if (prev !== tabId) return prev; // closed a background tab — keep focus
        if (remaining.length === 0) return null;
        // Favor the tab that took the closed tab's slot (right neighbor),
        // else the left neighbor.
        const nextIdx = Math.min(idx, remaining.length - 1);
        return remaining[nextIdx].id;
      });
      return 'closed';
    },
    [confirmDiscard, dispatch]
  );

  const openWithExtension = useCallback(
    async (entry: DirEntry, manifest: ExtensionManifest) => {
      const tabId = makeTabId(entry.path, manifest.id);
      // Dedup: this file is already open in this extension — just focus it
      // (and bump its LRU timestamp) instead of reloading. No dirty check:
      // background tabs are kept alive, so activating one loses nothing.
      const existing = tabsRef.current.find((t) => t.id === tabId);
      if (existing) {
        activateTab(tabId);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const { content, encoding, size } = await readTabContent(entry, manifest);
        const newTab: ExtensionTab = {
          id: tabId,
          filePath: entry.path,
          manifestId: manifest.id,
          manifest,
          fileContent: content,
          encoding,
          readOnly: currentLocation?.isReadOnly ?? false,
          fileSize: size,
          title: basename(entry.path),
          lastAccessed: Date.now(),
        };
        const dirtyPaths = new Set(
          Object.entries(editStateMapRef.current)
            .filter(([, v]) => v?.dirty)
            .map(([k]) => k)
        );
        setTabs((prev) => {
          const next = [newTab, ...prev];
          if (next.length > MAX_TABS) {
            const evictId = pickLruEvict(next, newTab.id, dirtyPaths);
            if (evictId) return next.filter((t) => t.id !== evictId);
          }
          return next;
        });
        setActiveTabId(tabId);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [currentLocation, readTabContent, activateTab]
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

  /** Unified "open this entry" used by the directory tree (and any other UI
   *  without direct access to the lightbox). Images are routed to MediaLightbox
   *  via a CustomEvent FileList listens for; everything else opens in a tab,
   *  or the OS default app when no extension matches. */
  const openEntryInTab = useCallback(
    async (entry: DirEntry) => {
      // Directories are navigated by the tree itself; never reach here.
      if (entry.isDirectory) return;
      if (isImageFile(entry.name)) {
        window.dispatchEvent(
          new CustomEvent('whale:open-lightbox', { detail: entry })
        );
        return;
      }
      const manifest = selectExtension(entry, {
        registry,
        userDefaults,
        enabledOverrides,
      });
      if (manifest) {
        await openWithExtension(entry, manifest);
      } else {
        await ipcApi.openNative(entry.path);
      }
    },
    [registry, userDefaults, enabledOverrides, openWithExtension]
  );

  const requestCloseCurrent = useCallback(async (): Promise<
    'closed' | 'cancelled'
  > => {
    if (!activeTabId) return 'closed';
    return closeTab(activeTabId);
  }, [activeTabId, closeTab]);

  const closeView = useCallback(() => {
    if (activeTabId) void closeTab(activeTabId);
  }, [activeTabId, closeTab]);

  const reloadContent = useCallback(async () => {
    const t = activeTab;
    if (!t) return;
    // Streamed viewers (pdf-viewer / non-transcode media-player) don't carry
    // file bytes in `fileContent` — they re-request a `whale-file://` URL on
    // every content push. Keep them on the empty-content path so a reload
    // doesn't base64 a 50 MB PDF back into the renderer.
    const { content, encoding, size } = await readTabContent(
      { path: t.filePath, name: t.title, size: t.fileSize ?? 0 },
      t.manifest
    );
    setTabs((prev) =>
      prev.map((x) =>
        x.id === t.id ? { ...x, fileContent: content, encoding, fileSize: size } : x
      )
    );
  }, [activeTab, readTabContent]);

  // Memoize the context value: every member is already a stable useSelector
  // reference / useState value / useCallback, so without this wrapper ANY
  // provider render (e.g. every loading toggle) would mint a new object and
  // force all consumers (MainLayout → FileList et al.) to re-render.
  const value: ExtensionContextValue = useMemo(
    () => ({
      registry,
      userDefaults,
      enabledOverrides,
      activeView,
      loading,
      error,
      tabs,
      activeTabId,
      openFile,
      openWithExtension,
      openEntryInTab,
      activateTab,
      closeTab,
      reloadContent,
      requestCloseCurrent,
      closeView,
      registerSaveCurrent,
    }),
    [
      registry,
      userDefaults,
      enabledOverrides,
      activeView,
      loading,
      error,
      tabs,
      activeTabId,
      openFile,
      openWithExtension,
      openEntryInTab,
      activateTab,
      closeTab,
      reloadContent,
      requestCloseCurrent,
      closeView,
      registerSaveCurrent,
    ]
  );

  return (
    <ExtensionContext.Provider value={value}>
      {children}
      <ConfirmDiscardDialog
        open={confirmState !== null}
        fileName={confirmState?.fileName ?? ''}
        onChoose={resolveConfirm}
      />
    </ExtensionContext.Provider>
  );
}
