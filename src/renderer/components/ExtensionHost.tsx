import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  Box,
  Button,
  IconButton,
  Toolbar,
  Tooltip,
  Typography,
  CircularProgress,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import SaveIcon from '@mui/icons-material/Save';
import HistoryIcon from '@mui/icons-material/History';
import DriveFileRenameOutlineIcon from '@mui/icons-material/DriveFileRenameOutline';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import { useTranslation } from 'react-i18next';
import type {
  ExtensionManifest,
} from '../../shared/extension-types';
import type { DirEntry } from '../../shared/ipc-types';
import {
  ExtensionMessage,
  HostMessage,
  isValidEnvelope,
} from '../../shared/extension-types';
import { ipcApi } from '-/services/ipc-api';
import { basename, parentDir } from '-/services/path-util';
import { AUDIO_TRANSCODE_EXT, isImageFile } from '../../shared/whale-meta';
import {
  encodeWhaleAudioUrl,
  encodeWhaleFileUrl,
} from '../../shared/whale-file-url';
import { useExtensionContext } from '-/hooks/ExtensionContextProvider';
import { useDirectoryUI } from '-/hooks/DirectoryContentContextProvider';
import { useDirectoryTreeRefresh } from '-/hooks/DirectoryTreeRefreshContextProvider';
import { createRpcHandler } from './extension-host/rpc-cases';
import PromptDialog from '-/components/PromptDialog';
import InlineEditModal from '-/components/ai/InlineEditModal';
import { RootState } from '-/reducers';
import {
  setFileEditState,
  clearFileEditState,
} from '-/reducers/extensions';
import { setAiSettings, setMdRenderTheme } from '-/reducers/settings';

/** How long the extension iframe may take to post `ready` before the host
 *  shows a retry-able failure instead of an indefinite spinner. */
const READY_TIMEOUT_MS = 12_000;

interface ExtensionHostProps {
  manifest: ExtensionManifest;  filePath: string;
  fileContent: string;
  encoding: 'utf8' | 'base64';
  readOnly: boolean;
  /** File size in bytes, forwarded into the `fileContent` envelope as `size`
   *  so the extension can show it in its status bar. Optional — older hosts
   *  may not supply it. */
  fileSize?: number;
  /** Sibling paths the extension can navigate to without asking the user to
   *  close + reopen (e.g. image-viewer's prev/next within the current dir).
   *  When provided, the host sends a `siblings` envelope to the extension on
   *  every file change, and the extension's `requestFile` messages are
   *  resolved by routing through `onRequestFile` so the active view re-renders
   *  with the new file's content. Omit for extensions that don't navigate. */
  siblings?: string[];
  theme: 'light' | 'dark';
  onClose: () => void;
  onRequestRevisionHistory: () => void;
  /** Re-open the extension view with a different file path (used to fulfill
   *  the extension's `requestFile` message). The host (view panel) is
   *  expected to keep the same manifest + read-only flag, and refresh
   *  `siblings` for the new file. */
  onRequestFile?: (path: string) => void;
}

/** Map a filename's extension to the standard IANA MIME type for the image
 *  formats we embed as full-resolution originals (vs. thumbnails). Only
 *  called for known-image extensions — `isImageFile(name)` should be true. */
function mimeFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = (dot >= 0 ? name.slice(dot + 1) : '').toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

/** SVG data-URL "document" icon with the file extension, used when a dropped
 *  file has no real thumbnail (e.g. plain text). */
function genericFileIcon(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = (dot >= 0 ? name.slice(dot + 1) : '').slice(0, 4).toUpperCase();
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="150">` +
    `<rect x="1" y="1" width="118" height="148" rx="8" fill="#eef0f5" stroke="#9aa0b4"/>` +
    `<path d="M82 4 L116 38 L82 38 Z" fill="#c5cad8"/>` +
    `<text x="60" y="98" font-family="sans-serif" font-size="20" font-weight="600" ` +
    `fill="#5a6072" text-anchor="middle">${ext}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

export default function ExtensionHost({
  manifest,
  filePath,
  fileContent,
  encoding,
  readOnly,
  fileSize,
  siblings,
  theme,
  onClose,
  onRequestRevisionHistory,
  onRequestFile,
}: ExtensionHostProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const dispatch = useDispatch();
  const { openWithExtension, requestCloseCurrent, registerSaveCurrent } =
    useExtensionContext();
  const { refresh } = useDirectoryUI();
  const { refreshTree } = useDirectoryTreeRefresh();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Inline-edit: pending `requestSelection` round-trips, keyed by requestId.
  const pendingSelections = useRef(
    new Map<
      string,
      (sel: { selectedText: string; from: number; to: number }) => void
    >()
  );
  const [ready, setReady] = useState(false);
  // Boot watchdog: the iframe must post `ready` within READY_TIMEOUT_MS of
  // mount, else show a retry-able failure instead of a permanent blank area
  // (extension crash / CSP block / protocol error all look identical from
  // the outside). `retryKey` remounts the iframe for a fresh boot.
  const [loadFailed, setLoadFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  // Inline-edit (AI rewrite of the editor selection).
  const [inlineEditSel, setInlineEditSel] = useState<{
    selectedText: string;
    from: number;
    to: number;
  } | null>(null);
  const aiProvider = useSelector(
    (s: RootState) => s.settings.aiProvider ?? 'claude-cli'
  );
  const aiEnabled = useSelector((s: RootState) => s.settings.aiEnabled);
  // Inline-edit is offered on the text/md editors across all providers. The
  // Claude CLI path uses a cold-start `query()` with a dedicated strict system
  // prompt (see src/main/ai/inlineEdit.ts); HTTP providers use a single
  // non-streaming chat completion. Both finalize as the rewritten selection.
  const canInlineEdit =
    !readOnly &&
    (manifest.id === 'text-editor' || manifest.id === 'md-editor') &&
    (aiProvider === 'claude-cli' ||
      aiProvider === 'ollama' ||
      aiProvider === 'openai');
  const editState = useSelector(
    (s: RootState) => s.extensions.editState[filePath]
  );
  const dwg2dxfPath = useSelector(
    (s: RootState) => s.settings?.dwg2dxfPath ?? null
  );
  const odaPath = useSelector((s: RootState) => s.settings?.odaPath ?? null);
  const calibrePath = useSelector(
    (s: RootState) => s.settings?.calibrePath ?? null
  );
  // docs/09 §16.14: the user's explicit LibreOffice override from settings —
  // forwarded to office-PDF conversion and the availability probe below.
  const sofficePath = useSelector(
    (s: RootState) => s.settings?.sofficePath ?? null
  );
  const mdRenderTheme = useSelector(
    (s: RootState) => s.settings?.mdEditorRenderTheme ?? 'auto'
  );
  const customCallouts = useSelector(
    (s: RootState) => s.settings?.customCallouts ?? []
  );
  const mdKeybindings = useSelector(
    (s: RootState) => s.settings?.mdKeybindings
  );
  const mdImageSaveMode = useSelector(
    (s: RootState) => s.settings?.mdImageSaveMode ?? 'subfolder'
  );
  const mdImageSubfolder = useSelector(
    (s: RootState) => s.settings?.mdImageSubfolder ?? '${filename}.assets'
  );
  const dirty = editState?.dirty ?? false;

  // Boot-watchdog timer: pending until `ready` (or the user retried into a
  // failure); remounting the iframe (retryKey bump) re-arms it.
  useEffect(() => {
    if (ready || loadFailed) return;
    const timer = setTimeout(() => setLoadFailed(true), READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [ready, loadFailed, retryKey]);

  const retryExtensionLoad = () => {
    setReady(false);
    setLoadFailed(false);
    setRetryKey((k) => k + 1);
  };

  const postToExtension = useCallback(
    (message: HostMessage) => {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow) return;
      iframe.contentWindow.postMessage(
        {
          protocolVersion: 1,
          source: 'host',
          message,
        },
        '*'
      );
    },
    []
  );

  // docs/07 §10: the 16 `request* → reply` RPC cases live in
  // `extension-host/rpc-cases.ts` (one forwardRpc helper + reply
  // constructors); the switch below keeps only the component-state cases.
  const handleRpc = useMemo(
    () =>
      createRpcHandler(postToExtension, {
        dwg2dxfPath,
        odaPath,
        calibrePath,
        sofficePath,
      }),
    [postToExtension, dwg2dxfPath, odaPath, calibrePath, sofficePath]
  );

  /** Inline-edit: ask the editor for its current selection (3s timeout). */
  const requestSelection = useCallback(async (): Promise<{
    selectedText: string;
    from: number;
    to: number;
  } | null> => {
    const requestId = `sel-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingSelections.current.delete(requestId);
        resolve(null);
      }, 3000);
      pendingSelections.current.set(requestId, (sel) => {
        clearTimeout(timer);
        resolve(sel);
      });
      postToExtension({ type: 'requestSelection', requestId });
    });
  }, [postToExtension]);

  /** Inline-edit: replace the selection range with AI-produced text. */
  const applyReplacement = useCallback(
    (from: number, to: number, text: string) => {
      postToExtension({ type: 'applyReplacement', from, to, text });
    },
    [postToExtension]
  );

  useEffect(() => {
    if (ready) {
      postToExtension({
        type: 'fileContent',
        path: filePath,
        content: fileContent,
        encoding,
        readOnly,
        size: fileSize,
        // §18.2.3 — supply the file's directory so the extension can
        // resolve `<img src="./relative.png">` into streamable
        // `whale-file://` URLs. `parentDir` handles the trailing-separator
        // / no-separator / Windows-drive cases identically to the rest
        // of the path utilities (see src/renderer/services/path-util.ts).
        // Optional in the message type; older hosts can omit it.
        dirPath: parentDir(filePath),
      });
    }
  }, [ready, filePath, fileContent, encoding, readOnly, fileSize, postToExtension]);

  // Sibling list (image-viewer's prev/next target set). Sent on every file
  // change so the extension can light up its navigation UI immediately. Only
  // dispatched when the host actually supplied a list — most extensions don't
  // need it, and we don't want to spam an irrelevant `siblings` envelope.
  useEffect(() => {
    if (!ready) return;
    if (!siblings || siblings.length === 0) return;
    postToExtension({
      type: 'siblings',
      current: filePath,
      paths: siblings,
    });
  }, [ready, filePath, siblings, postToExtension]);

  useEffect(() => {
    if (ready) {
      postToExtension({ type: 'setTheme', theme });
    }
  }, [theme, ready, postToExtension]);

  // md-editor render-theme preset + custom callouts (host → ext). Only
  // md-editor acts on these; other extensions ignore them (onMessage default).
  useEffect(() => {
    if (ready) {
      postToExtension({ type: 'setMdRenderTheme', theme: mdRenderTheme });
    }
  }, [mdRenderTheme, ready, postToExtension]);

  useEffect(() => {
    if (ready) {
      postToExtension({ type: 'setCustomCallouts', callouts: customCallouts });
    }
  }, [customCallouts, ready, postToExtension]);

  // md-editor keymap overrides (action → CodeMirror combo). The editor
  // reconfigures its keymapCompartment on receipt, so rebinding applies live.
  useEffect(() => {
    if (ready && mdKeybindings) {
      postToExtension({ type: 'setKeybindings', keybindings: mdKeybindings });
    }
  }, [mdKeybindings, ready, postToExtension]);

  // md-editor pasted-image save location (host → ext). The editor computes the
  // save dir + insert link from these on every paste; `subfolder` may contain
  // `${filename}`. Defaults are guarded so the first push (pre-migrate) is sane.
  useEffect(() => {
    if (ready) {
      postToExtension({
        type: 'setImageSaveConfig',
        mode: mdImageSaveMode,
        subfolder: mdImageSubfolder,
      });
    }
  }, [mdImageSaveMode, mdImageSubfolder, ready, postToExtension]);

  useEffect(() => {
    if (ready) {
      postToExtension({ type: 'setLocale', locale });
    }
  }, [locale, ready, postToExtension]);

  // AI availability (host → ext): extensions with AI-driven actions
  // (pdf-viewer's marquee "ask AI") hide them when the assistant is off.
  useEffect(() => {
    if (ready) {
      postToExtension({ type: 'setAiAvailable', available: aiEnabled });
    }
  }, [aiEnabled, ready, postToExtension]);

  useEffect(() => {
    return () => {
      dispatch(clearFileEditState(filePath));
    };
  }, [dispatch, filePath]);

  const handleSave = useCallback(
    async (content: string): Promise<boolean> => {
      if (readOnly || saving) return false;
      setSaving(true);
      try {
        await ipcApi.writeFileWithRevision(filePath, content);
        postToExtension({ type: 'savingFile', path: filePath });
        dispatch(setFileEditState(filePath, { dirty: false, saving: false }));
        return true;
      } catch (e) {
        dispatch(
          setFileEditState(filePath, {
            dirty: true,
            saving: false,
          })
        );
        alert(
          t('extensionSaveError', {
            message: e instanceof Error ? e.message : String(e),
          })
        );
        return false;
      } finally {
        setSaving(false);
      }
    },
    [dispatch, filePath, postToExtension, readOnly, saving, t]
  );

  // §unsaved-close — resolver for the in-flight `requestSave` round-trip. Set
  // by `saveCurrent`, resolved by the `parentSaveDocument` case in onMessage
  // once the extension hands back its latest content and `handleSave` writes
  // it. Mirrors `requestSelection`'s pendingSelections pattern (resolver +
  // timeout) so we don't add a second message listener.
  const saveResolverRef = useRef<((ok: boolean) => void) | null>(null);

  // Ask the extension to save its current document and wait for the write to
  // land. Exposed to `requestCloseCurrent` (in the context provider, where
  // closeView/setActiveView live) via the registered ref. Returns false on
  // read-only, timeout (15s — covers large-file writes + revision backup), or
  // write failure; the caller then keeps the view open.
  const saveCurrent = useCallback(async (): Promise<boolean> => {
    if (readOnly) return false;
    return new Promise<boolean>((resolve) => {
      const resolver = (ok: boolean) => {
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        if (saveResolverRef.current === resolver) {
          saveResolverRef.current = null;
        }
        resolve(false);
      }, 15000);
      saveResolverRef.current = resolver;
      // If a save is already in flight (toolbar Save clicked a moment ago),
      // don't fire a second requestSave — the pending parentSaveDocument will
      // resolve this resolver. Otherwise ask the extension to save.
      if (!saving) {
        postToExtension({ type: 'requestSave', path: filePath });
      }
    });
  }, [postToExtension, filePath, readOnly, saving]);

  // Register saveCurrent into the context so requestCloseCurrent can trigger a
  // save before closing. Cleared on unmount.
  useEffect(() => {
    registerSaveCurrent(saveCurrent);
    return () => {
      registerSaveCurrent(null);
    };
  }, [registerSaveCurrent, saveCurrent]);

  // Rename the open file: rename on disk, then reopen under the new path so the
  // editor, toolbar title, and subsequent saves all use it. Blocked while dirty
  // (reopening reloads from disk, which would drop unsaved edits).
  const handleRename = useCallback(
    async (rawName: string) => {
      setRenameOpen(false);
      const newName = rawName.trim();
      if (!newName || newName === basename(filePath)) return;
      if (dirty) {
        alert(t('saveBeforeRename'));
        return;
      }
      const sep = Math.max(
        filePath.lastIndexOf('/'),
        filePath.lastIndexOf('\\')
      );
      const dir = filePath.slice(0, sep);
      const sepChar = sep >= 0 ? filePath[sep] : '/';
      const newPath = `${dir}${sepChar}${newName}`;
      try {
        await ipcApi.rename(filePath, newPath);
        const dot = newName.lastIndexOf('.');
        const entry: DirEntry = {
          name: newName,
          path: newPath,
          isDirectory: false,
          isFile: true,
          size: 0,
          modified: new Date().toISOString(),
          extension: dot > 0 ? newName.slice(dot + 1).toLowerCase() : '',
        };
        await openWithExtension(entry, manifest);
        await refresh().catch(() => undefined);
        refreshTree(dir);
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e));
      }
    },
    [dirty, filePath, manifest, openWithExtension, refresh, refreshTree, t]
  );

  // A file (or folder) was dropped into the editor. For images we embed the
  // ORIGINAL file bytes (so the inserted cell shows the full-resolution
  // image, like the excalidraw extension). For everything else we use the
  // 256x256 thumbnail pipeline. Folders use the folder-thumbnail pipeline
  // (`<dir>/.whale/wst.jpg`).
  const handleRequestFileEmbed = useCallback(
    async (p: string, isDirectory: boolean) => {
      const name = basename(p);
      const isImage = !isDirectory && isImageFile(name);
      let imageDataUrl: string | null = null;
      try {
        if (isDirectory) {
          imageDataUrl = await ipcApi.loadFolderThumbnail(p);
        } else if (isImage) {
          // Image: embed the original file bytes (base64) instead of a
          // thumbnail. We trust the extension's underlying mimeType from
          // the filename's extension — mime-types detection via the main
          // process is not exposed for arbitrary files. drawio doesn't care
          // about the exact bytes; it just renders the image. The cell
          // stays small (data URL inside an `image=data:image/...` style).
          const buf = await ipcApi.readFile(p);
          const bytes = new Uint8Array(buf);
          let bin = '';
          for (let i = 0; i < bytes.length; i += 1) {
            bin += String.fromCharCode(bytes[i]);
          }
          const mime = isImage ? mimeFromName(name) : 'application/octet-stream';
          imageDataUrl = `data:${mime};base64,${btoa(bin)}`;
        } else {
          await ipcApi.generateThumbnail(p);
          imageDataUrl = await ipcApi.loadThumbnail(p);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[extHost] embed gen failed, using generic icon:', err);
        imageDataUrl = null;
      }
      postToExtension({
        type: 'fileEmbed',
        path: p,
        name,
        thumbnailDataUrl: imageDataUrl ?? genericFileIcon(name),
      });
    },
    [postToExtension]
  );

  // Forward directory-tree drags (dispatched as window CustomEvents) into the
  // iframe so the editor knows the dragged file's path on drop.
  useEffect(() => {
    const onStart = (e: Event) => {
      const detail = (e as CustomEvent<{
        path: string;
        name: string;
        isDirectory?: boolean;
      }>).detail;
      if (!detail) return;
      const isDirectory = !!detail.isDirectory;
      postToExtension({
        type: 'externalDrag',
        active: true,
        path: detail.path,
        name: detail.name,
        isImage: !isDirectory && isImageFile(detail.name),
        isDirectory,
      });
    };
    const onEnd = () => postToExtension({ type: 'externalDrag', active: false });
    window.addEventListener('whale:extdrag-start', onStart);
    window.addEventListener('whale:extdrag-end', onEnd);
    return () => {
      window.removeEventListener('whale:extdrag-start', onStart);
      window.removeEventListener('whale:extdrag-end', onEnd);
    };
  }, [postToExtension]);

  // Catch-all dragend listener. The previous design relied on a custom
  // `whale:extdrag-end` event from DirectoryTree, but DirectoryTree never
  // dispatches it (starting a native OS drag fires the source's HTML5
  // dragend immediately, which is what we listen to here). Without this,
  // any drop that lands outside the iframe's overlay — on the toolbar, on
  // the wrapper's edge, on the sidebar — never tells the iframe to clear
  // its overlay, and the orange dashed box stays for the full 15 s safety
  // timer. Listening at window catches dragend from ANY source element in
  // the main renderer (toolbar rows, sidebar entries, breadcrumb, etc.) and
  // forwards a single "release" signal to the iframe. The iframe's own
  // fileEmbed handler runs in parallel if the drop actually landed on the
  // overlay — that path still inserts the cell correctly because we don't
  // clear `externalDragRef` on this signal (see app.tsx externalDrag
  // listener for the "stale ref is harmless" reasoning).
  useEffect(() => {
    const onDragEnd = () => {
      postToExtension({ type: 'externalDrag', active: false });
    };
    window.addEventListener('dragend', onDragEnd);
    return () => window.removeEventListener('dragend', onDragEnd);
  }, [postToExtension]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const iframe = iframeRef.current;
      if (!iframe) return;
      if (event.source !== iframe.contentWindow) return;
      if (!isValidEnvelope<ExtensionMessage>(event.data, 'extension')) return;

      const msg = event.data.message;
      // docs/07 §10: the 16 `request*` RPC cases are delegated to
      // `handleRpc` (extension-host/rpc-cases.ts); only component-state
      // cases stay in this switch.
      if (handleRpc(msg)) return;
      switch (msg.type) {
        case 'ready':
          setReady(true);
          setLoadFailed(false);
          break;
        case 'parentSaveDocument':
          handleSave(msg.content)
            .then((ok) => {
              saveResolverRef.current?.(ok);
              saveResolverRef.current = null;
            })
            .catch(() => {
              saveResolverRef.current?.(false);
              saveResolverRef.current = null;
            });
          break;
        case 'requestFileEmbed':
          handleRequestFileEmbed(msg.path, !!msg.isDirectory).catch(
            () => undefined
          );
          break;
        case 'requestFile':
          // Extension (e.g. image-viewer) wants to navigate to a sibling file.
          // Defer to the view panel so the active view re-renders with new
          // content + a refreshed sibling list. Ignore if the host didn't
          // supply a handler (siblings API is opt-in).
          if (onRequestFile) {
            onRequestFile(msg.path);
          }
          break;
        case 'contentChangedInEditor':
          dispatch(setFileEditState(filePath, { dirty: msg.dirty }));
          break;
        case 'editorSelection': {
          // Inline-edit: the editor answered our `requestSelection`.
          const resolve = pendingSelections.current.get(msg.requestId);
          if (resolve) {
            pendingSelections.current.delete(msg.requestId);
            resolve({
              selectedText: msg.selectedText,
              from: msg.from,
              to: msg.to,
            });
          }
          break;
        }
        case 'openLinkExternally':
          if (
            msg.url.startsWith('http://') ||
            msg.url.startsWith('https://')
          ) {
            window.open(msg.url, '_blank');
          } else {
            ipcApi.openNative(msg.url).catch(() => undefined);
          }
          break;
        case 'openWithSystem': {
          // docs/09 §16.21: fallback — open the file with the OS default app
          // when LibreOffice is missing or conversion fails. Fire-and-forget.
          ipcApi.openNative(msg.path).catch(() => undefined);
          break;
        }
        case 'requestStreamingUrl': {
          // Pick the scheme by extension: transcode-only audio (APE/WMA/…)
          // gets whale-audio:// (host live-transcodes ffmpeg → Opus → <audio>
          // so large files start playing within ~1s); everything else gets
          // whale-file:// (streamed with Range support).
          const dot = msg.path.lastIndexOf('.');
          const ext = dot >= 0 ? msg.path.slice(dot + 1).toLowerCase() : '';
          const url = AUDIO_TRANSCODE_EXT.has(ext)
            ? encodeWhaleAudioUrl(msg.path)
            : encodeWhaleFileUrl(msg.path);
          postToExtension({
            type: 'streamingUrl',
            path: msg.path,
            url: url ?? '',
          });
          break;
        }
        case 'mdRenderThemeChanged': {
          // md-editor toolbar <select> changed the preset → sync back into
          // redux so Settings stays in sync (bidirectional). This dispatch
          // triggers the setMdRenderTheme useEffect above, which re-posts
          // the same value the iframe just told us — no loop (the iframe's
          // onMessage for setMdRenderTheme is a no-op when the value matches
          // its current mdThemePref).
          dispatch(setMdRenderTheme(msg.theme));
          break;
        }
        case 'askAi': {
          // pdf-viewer marquee: the user boxed a region and asked about the
          // extracted text. Open the panel and hand the payload to AiPanel
          // as a draft attachment (CustomEvent — NOT redux: the `ai` slice is
          // redux-persist'd wholesale, a draft must not survive restart).
          if (!aiEnabled) break;
          dispatch(setAiSettings({ aiPanelOpen: true }));
          window.dispatchEvent(
            new CustomEvent('whale:ai-draft', {
              detail: { path: msg.path, page: msg.page, text: msg.text },
            })
          );
          break;
        }
        case 'error':
          console.error('[ExtensionHost] extension error:', msg.message);
          break;
        default:
          break;
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [
    dispatch,
    filePath,
    aiEnabled,
    handleSave,
    handleRequestFileEmbed,
    postToExtension,
    handleRpc,
  ]);

  const title = manifest.name;
  const fileName = filePath.substring(
    Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1
  );

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Toolbar
        variant="dense"
        sx={{
          minHeight: 40,
          borderBottom: 1,
          borderColor: 'divider',
          gap: 1,
        }}
      >
        <Box
          sx={{
            width: 12,
            height: 12,
            borderRadius: '50%',
            backgroundColor: manifest.color,
            flexShrink: 0,
          }}
        />
        <Typography variant="subtitle2" noWrap sx={{ flexShrink: 0 }}>
          {title}
        </Typography>
        <Typography
          variant="body2"
          color="text.secondary"
          noWrap
          sx={{ flex: 1, minWidth: 0 }}
        >
          {fileName}
        </Typography>
        {manifest.type === 'editor' && (
          <>
            <Tooltip title={t('revisionHistory')}>
              <span>
                <IconButton
                  size="small"
                  onClick={onRequestRevisionHistory}
                  disabled={readOnly}
                >
                  <HistoryIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title={t('save')}>
              <span>
                <IconButton
                  size="small"
                  onClick={() =>
                    postToExtension({ type: 'requestSave', path: filePath })
                  }
                  // For drawio, drop `!dirty` from the disabled predicate:
                  // drawio's `editor.modified` only flips to true after a
                  // change AND the 1.5s autosave timer fires, so a freshly
                  // opened (unmodified) file is permanently "not dirty" and
                  // the button would be unpressable. `getXml` forces drawio
                  // to emit XML on demand, so saving an unmodified file is
                  // a no-op write, not an error. The local `dirty` indicator
                  // (the dot in the close button) still works because the
                  // bridge posts `contentChangedInEditor` on autosave.
                  disabled={readOnly || saving}
                >
                  {saving ? (
                    <CircularProgress size={18} />
                  ) : (
                    <SaveIcon fontSize="small" />
                  )}
                </IconButton>
              </span>
            </Tooltip>
            {canInlineEdit ? (
              <Tooltip title={t('aiInlineEditButton')}>
                <span>
                  <IconButton
                    size="small"
                    onClick={async () => {
                      const sel = await requestSelection();
                      if (sel && sel.selectedText) setInlineEditSel(sel);
                    }}
                  >
                    <AutoFixHighIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            ) : null}
          </>
        )}
        <Tooltip title={t('rename')}>
          <span>
            <IconButton
              size="small"
              onClick={() => setRenameOpen(true)}
              disabled={readOnly}
            >
              <DriveFileRenameOutlineIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={t('close')}>
          <IconButton
            size="small"
            onClick={() => {
              void requestCloseCurrent();
            }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Toolbar>
      <Box
        sx={{ flex: 1, minHeight: 0, position: 'relative' }}
        // Wrapper-level drop guard: drops that land on the gap between the
        // toolbar and the iframe (or any pixel the iframe doesn't paint
        // over) would otherwise show Chromium's "no-drop" cursor and, worse,
        // fall through to the browser's default file-open navigation.
        // preventDefault on dragover+drop makes the wrapper a valid drop
        // target; the actual drop logic lives inside the extension's own
        // overlay (drawio-editor/app.tsx / excalidraw-editor/app.tsx) which
        // is positioned with `inset: 0` over the iframe.
        onDragOver={(e) => {
          e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
        }}
      >
        <iframe
          key={retryKey}
          ref={iframeRef}
          title={title}
          src={`whale-extension://${manifest.id}/${manifest.entryPoint}`}
          // Fullscreen plumbing. The legacy `allowFullScreen` boolean attribute
          // is intentionally NOT set: modern Chromium (89+) considers
          // Permissions-Policy `allow="fullscreen"` authoritative and prints
          // a dev warning when both are present (`Allow attribute will take
          // precedence over 'allowfullscreen'`). The `allow` token alone is
          // what unlocks media-player's native fullscreen button and
          // image-viewer's F-key programmatic call.
          // Note: `allow-fullscreen` is NOT a valid sandbox token (the HTML
          // sandbox grammar only lists the
          // allow-{downloads,forms,modals,orientation-lock,pointer-lock,
          // popups,popups-to-escape-sandbox,presentation,same-origin,
          // scripts,top-navigation,…} tokens). Including it makes Chromium
          // log `Error while parsing the 'sandbox' attribute: 'allow-fullscreen'
          // is an invalid sandbox flag.` and silently drop the whole
          // sandbox attribute — which would break scripts + same-origin
          // for every extension. Sandbox must stay clean.
          allow="fullscreen"
          sandbox="allow-same-origin allow-scripts allow-modals allow-downloads"
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
          }}
        />
        {/* Boot-state overlay: spinner while the extension loads; retry-able
            failure when it never posts `ready` (crash / CSP block / protocol
            error). Removed once ready so it never intercepts interaction. */}
        {!ready ? (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 1.5,
              bgcolor: 'background.default',
            }}
          >
            {loadFailed ? (
              <>
                <ErrorOutlineIcon color="error" />
                <Typography variant="body2" color="text.secondary">
                  {t('extLoadFailed')}
                </Typography>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={retryExtensionLoad}
                >
                  {t('extRetry')}
                </Button>
              </>
            ) : (
              <CircularProgress size={28} />
            )}
          </Box>
        ) : null}
      </Box>
      <PromptDialog
        open={renameOpen}
        title={t('rename')}
        label={t('name')}
        defaultValue={fileName}
        onConfirm={handleRename}
        onClose={() => setRenameOpen(false)}
      />
      <InlineEditModal
        open={inlineEditSel !== null}
        selection={inlineEditSel?.selectedText ?? ''}
        onClose={() => setInlineEditSel(null)}
        onApplied={(replacement) => {
          if (inlineEditSel) {
            applyReplacement(inlineEditSel.from, inlineEditSel.to, replacement);
          }
          setInlineEditSel(null);
        }}
      />
    </Box>
  );
}
