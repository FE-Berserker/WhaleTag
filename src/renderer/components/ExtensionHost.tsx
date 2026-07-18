import { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  Box,
  IconButton,
  Toolbar,
  Tooltip,
  Typography,
  CircularProgress,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
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
import PromptDialog from '-/components/PromptDialog';
import InlineEditModal from '-/components/ai/InlineEditModal';
import { RootState } from '-/reducers';
import {
  setFileEditState,
  clearFileEditState,
} from '-/reducers/extensions';
import { setMdRenderTheme } from '-/reducers/settings';

interface ExtensionHostProps {
  manifest: ExtensionManifest;
  filePath: string;
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
  const { openWithExtension } = useExtensionContext();
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
  const mdRenderTheme = useSelector(
    (s: RootState) => s.settings?.mdEditorRenderTheme ?? 'auto'
  );
  const customCallouts = useSelector(
    (s: RootState) => s.settings?.customCallouts ?? []
  );
  const dirty = editState?.dirty ?? false;

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

  useEffect(() => {
    if (ready) {
      postToExtension({ type: 'setLocale', locale });
    }
  }, [locale, ready, postToExtension]);

  useEffect(() => {
    return () => {
      dispatch(clearFileEditState(filePath));
    };
  }, [dispatch, filePath]);

  const handleSave = useCallback(
    async (content: string) => {
      if (readOnly || saving) return;
      setSaving(true);
      try {
        await ipcApi.writeFileWithRevision(filePath, content);
        postToExtension({ type: 'savingFile', path: filePath });
        dispatch(setFileEditState(filePath, { dirty: false, saving: false }));
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
      } finally {
        setSaving(false);
      }
    },
    [dispatch, filePath, postToExtension, readOnly, saving, t]
  );

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
      switch (msg.type) {
        case 'ready':
          setReady(true);
          break;
        case 'parentSaveDocument':
          handleSave(msg.content).catch(() => undefined);
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
        case 'requestPdfAsset': {
          const { requestId, kind, filename } = msg;
          ipcApi
            .getPdfAsset(kind, filename)
            .then((data) => {
              postToExtension({ type: 'pdfAsset', requestId, data });
            })
            .catch((e) => {
              postToExtension({
                type: 'pdfAsset',
                requestId,
                data: null,
                error: e instanceof Error ? e.message : String(e),
              });
            });
          break;
        }
        case 'requestCadWasm': {
          const { requestId } = msg;
          ipcApi
            .getCadWasm()
            .then((data) => {
              postToExtension({ type: 'cadWasm', requestId, data });
            })
            .catch((e) => {
              postToExtension({
                type: 'cadWasm',
                requestId,
                data: null,
                error: e instanceof Error ? e.message : String(e),
              });
            });
          break;
        }
        case 'requestHeicWasm': {
          const { requestId } = msg;
          ipcApi
            .getHeicWasm()
            .then((data) => {
              postToExtension({ type: 'heicWasm', requestId, data });
            })
            .catch((e) => {
              postToExtension({
                type: 'heicWasm',
                requestId,
                data: null,
                error: e instanceof Error ? e.message : String(e),
              });
            });
          break;
        }
        case 'requestOfficeConvert': {
          const { requestId, path: officePath } = msg;
          ipcApi
            .convertOfficeToPdf(officePath)
            .then((data) => {
              postToExtension({ type: 'officePdfContent', requestId, data });
            })
            .catch((e) => {
              postToExtension({
                type: 'officePdfContent',
                requestId,
                data: null,
                error: e instanceof Error ? e.message : String(e),
              });
            });
          break;
        }
        case 'requestSofficeCheck': {
          // docs/09 §16.16: office-viewer probes LibreOffice availability so it
          // can show install guidance instead of a bare "not found" dead-end.
          const { requestId } = msg;
          ipcApi
            .isSofficeAvailable()
            .then((available) =>
              postToExtension({ type: 'sofficeCheckResult', requestId, available })
            )
            .catch(() =>
              postToExtension({ type: 'sofficeCheckResult', requestId, available: false })
            );
          break;
        }
        case 'openWithSystem': {
          // docs/09 §16.21: fallback — open the file with the OS default app
          // when LibreOffice is missing or conversion fails. Fire-and-forget.
          ipcApi.openNative(msg.path).catch(() => undefined);
          break;
        }
        case 'requestThumbnail': {
          // P3-1: office-viewer asks for the cached thumbnail (data URL) to
          // show as an instant first-page placeholder while LibreOffice
          // cold-converts to PDF. `loadThumbnail` returns null when no
          // thumbnail has been generated yet — the viewer then just keeps
          // its "Converting…" status.
          const { requestId, path: thumbPath } = msg;
          ipcApi
            .loadThumbnail(thumbPath)
            .then((dataUrl) => {
              postToExtension({
                type: 'thumbnailContent',
                requestId,
                dataUrl: dataUrl ?? null,
              });
            })
            .catch(() => {
              postToExtension({
                type: 'thumbnailContent',
                requestId,
                dataUrl: null,
              });
            });
          break;
        }
        case 'requestDwgConvert': {
          const { requestId, path: dwgPath } = msg;
          ipcApi
            .convertDwgToDxf(dwgPath, { dwg2dxfPath, odaPath })
            .then((data) => {
              postToExtension({ type: 'dwgConvertedContent', requestId, data });
            })
            .catch((e) => {
              postToExtension({
                type: 'dwgConvertedContent',
                requestId,
                data: null,
                error: e instanceof Error ? e.message : String(e),
              });
            });
          break;
        }
        case 'requestEbookConvert': {
          const { requestId, path: ebookPath } = msg;
          ipcApi
            .convertEbookToEpub(ebookPath, { calibrePath })
            .then((data) => {
              postToExtension({
                type: 'ebookConvertedContent',
                requestId,
                data,
              });
            })
            .catch((e) => {
              postToExtension({
                type: 'ebookConvertedContent',
                requestId,
                data: null,
                error: e instanceof Error ? e.message : String(e),
              });
            });
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
        case 'requestFileBytes': {
          // pdf-viewer can't `fetch(whale-file://)` — Chromium CORS blocks
          // cross-origin fetch to custom schemes (only http/https/data/chrome
          // are allowed) — so it asks the host to read the file and ship the
          // raw bytes back. Electron structured-clones the Uint8Array through
          // postMessage (one memcpy, no base64, no O(n²) decode). Mirrors
          // office-viewer's officePdfContent path.
          const { requestId, path: bytesPath } = msg;
          ipcApi
            .readFile(bytesPath)
            .then((buf: ArrayBuffer) => {
              postToExtension({
                type: 'fileBytes',
                requestId,
                data: new Uint8Array(buf),
              });
            })
            .catch((e: unknown) => {
              postToExtension({
                type: 'fileBytes',
                requestId,
                data: null,
                error: e instanceof Error ? e.message : String(e),
              });
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
        case 'requestSaveImage': {
          // §paste-image (md-editor): save the pasted clipboard image into the
          // .md's directory, return the absolute path so the editor can link it.
          const { requestId, dataURL, ext, dirPath } = msg;
          ipcApi
            .saveImageToFile(dataURL, dirPath, ext)
            .then((savedPath: string) => {
              postToExtension({ type: 'imageSaved', requestId, path: savedPath });
            })
            .catch((e: unknown) => {
              postToExtension({
                type: 'imageSaved',
                requestId,
                path: null,
                error: e instanceof Error ? e.message : String(e),
              });
            });
          break;
        }
        case 'requestReadEbookAnnotations': {
          const { requestId, path: annoPath } = msg;
          ipcApi
            .readEbookAnnotations(annoPath)
            .then((payload) => {
              postToExtension({
                type: 'ebookAnnotations',
                requestId,
                ok: true,
                payload: payload ?? null,
              });
            })
            .catch((e) => {
              postToExtension({
                type: 'ebookAnnotations',
                requestId,
                ok: false,
                payload: null,
                error: e instanceof Error ? e.message : String(e),
              });
            });
          break;
        }
        case 'requestWriteEbookAnnotations': {
          const { requestId, path: annoPath, payload } = msg;
          ipcApi
            .writeEbookAnnotations(
              annoPath,
              payload as Parameters<typeof ipcApi.writeEbookAnnotations>[1]
            )
            .then(() => {
              postToExtension({
                type: 'ebookAnnotations',
                requestId,
                ok: true,
                payload: null,
              });
            })
            .catch((e) => {
              postToExtension({
                type: 'ebookAnnotations',
                requestId,
                ok: false,
                payload: null,
                error: e instanceof Error ? e.message : String(e),
              });
            });
          break;
        }
        case 'requestArchiveList': {
          const { requestId, path: archivePath, maxEntries, password } = msg;
          ipcApi
            .listArchive(archivePath, { maxEntries, password })
            .then(({ entries, truncated }) => {
              postToExtension({
                type: 'archiveList',
                requestId,
                entries,
                truncated,
              });
            })
            .catch((e) => {
              postToExtension({
                type: 'archiveList',
                requestId,
                entries: [],
                truncated: false,
                error: e instanceof Error ? e.message : String(e),
              });
            });
          break;
        }
        case 'requestArchiveEntry': {
          const { requestId, path: archivePath, entryPath, password, force } = msg;
          ipcApi
            .readArchiveEntry(archivePath, entryPath, { password, force })
            .then((result) => {
              postToExtension({
                type: 'archiveEntryContent',
                requestId,
                base64: result?.base64 ?? '',
                size: result?.size ?? 0,
              });
            })
            .catch((e) => {
              postToExtension({
                type: 'archiveEntryContent',
                requestId,
                base64: '',
                size: 0,
                error: e instanceof Error ? e.message : String(e),
              });
            });
          break;
        }
        case 'requestArchiveExtract': {
          const { requestId, path: archivePath, destDir, password, flatten } = msg;
          ipcApi
            .extractArchive(archivePath, destDir, { password, flatten })
            .then(({ written, skipped, errors }) => {
              postToExtension({
                type: 'archiveExtracted',
                requestId,
                written,
                skipped,
                errors,
              });
            })
            .catch((e) => {
              postToExtension({
                type: 'archiveExtracted',
                requestId,
                written: 0,
                skipped: [],
                errors: [],
                error: e instanceof Error ? e.message : String(e),
              });
            });
          break;
        }
        case 'requestDirectoryDialog': {
          const { requestId } = msg;
          ipcApi
            .openDirectoryDialog()
            .then((selected) => {
              postToExtension({
                type: 'directoryDialogResult',
                requestId,
                path: selected,
              });
            })
            .catch(() => {
              postToExtension({
                type: 'directoryDialogResult',
                requestId,
                path: null,
              });
            });
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
    handleSave,
    handleRequestFileEmbed,
    postToExtension,
    dwg2dxfPath,
    odaPath,
    calibrePath,
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
          <IconButton size="small" onClick={onClose}>
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
