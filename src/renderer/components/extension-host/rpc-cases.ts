import type {
  ExtensionMessage,
  HostMessage,
} from '../../../shared/extension-types';
import { ipcApi } from '-/services/ipc-api';

/**
 * The `request* → reply` RPC cases of the extension message switch
 * (docs/07 §10 — extracted from ExtensionHost's god-switch). Every case is
 * the same three steps: one ipcApi call, a success reply, or an error
 * reply. `forwardRpc` owns that plumbing; each case only supplies its reply
 * constructors (reply types carry their own empty fields alongside `error`).
 */

type Post = (message: HostMessage) => void;

function forwardRpc<T>(
  post: Post,
  call: () => Promise<T>,
  onOk: (data: T) => HostMessage,
  onErr: (error: string) => HostMessage
): void {
  call()
    .then((data) => post(onOk(data)))
    .catch((e: unknown) =>
      post(onErr(e instanceof Error ? e.message : String(e)))
    );
}

/** User-configured converter paths from settings (forwarded to the
 *  corresponding ipcApi calls). */
export interface RpcPaths {
  dwg2dxfPath: string | null;
  odaPath: string | null;
  calibrePath: string | null;
  sofficePath: string | null;
}

/**
 * Build the RPC-case dispatcher. Returns a handler: `true` when the message
 * was an RPC case and has been dispatched (the reply posts asynchronously),
 * `false` so the caller falls through to its component-level switch.
 */
export function createRpcHandler(post: Post, paths: RpcPaths) {
  const { dwg2dxfPath, odaPath, calibrePath, sofficePath } = paths;
  return (msg: ExtensionMessage): boolean => {
    switch (msg.type) {
      case 'requestPdfAsset':
        forwardRpc(
          post,
          () => ipcApi.getPdfAsset(msg.kind, msg.filename),
          (data) => ({ type: 'pdfAsset', requestId: msg.requestId, data }),
          (error) => ({
            type: 'pdfAsset',
            requestId: msg.requestId,
            data: null,
            error,
          })
        );
        return true;

      case 'requestCadWasm':
        forwardRpc(
          post,
          () => ipcApi.getCadWasm(),
          (data) => ({ type: 'cadWasm', requestId: msg.requestId, data }),
          (error) => ({
            type: 'cadWasm',
            requestId: msg.requestId,
            data: null,
            error,
          })
        );
        return true;

      case 'requestHeicWasm':
        forwardRpc(
          post,
          () => ipcApi.getHeicWasm(),
          (data) => ({ type: 'heicWasm', requestId: msg.requestId, data }),
          (error) => ({
            type: 'heicWasm',
            requestId: msg.requestId,
            data: null,
            error,
          })
        );
        return true;

      case 'requestOfficeConvert':
        forwardRpc(
          post,
          () => ipcApi.convertOfficeToPdf(msg.path, { sofficePath }),
          (data) => ({
            type: 'officePdfContent',
            requestId: msg.requestId,
            data,
          }),
          (error) => ({
            type: 'officePdfContent',
            requestId: msg.requestId,
            data: null,
            error,
          })
        );
        return true;

      case 'requestSofficeCheck':
        // docs/09 §16.16: office-viewer probes LibreOffice availability so it
        // can show install guidance instead of a bare "not found" dead-end.
        // Errors collapse to `available: false` (same UX as "not installed").
        forwardRpc(
          post,
          () => ipcApi.isSofficeAvailable({ sofficePath }),
          (available) => ({
            type: 'sofficeCheckResult',
            requestId: msg.requestId,
            available,
          }),
          () => ({
            type: 'sofficeCheckResult',
            requestId: msg.requestId,
            available: false,
          })
        );
        return true;

      case 'requestThumbnail':
        // P3-1: office-viewer asks for the cached thumbnail (data URL) to
        // show as an instant first-page placeholder while LibreOffice
        // cold-converts to PDF. `loadThumbnail` returns null when no
        // thumbnail has been generated yet — the viewer then just keeps
        // its "Converting…" status.
        forwardRpc(
          post,
          () => ipcApi.loadThumbnail(msg.path),
          (dataUrl) => ({
            type: 'thumbnailContent',
            requestId: msg.requestId,
            dataUrl: dataUrl ?? null,
          }),
          () => ({
            type: 'thumbnailContent',
            requestId: msg.requestId,
            dataUrl: null,
          })
        );
        return true;

      case 'requestDwgConvert':
        forwardRpc(
          post,
          () => ipcApi.convertDwgToDxf(msg.path, { dwg2dxfPath, odaPath }),
          (data) => ({
            type: 'dwgConvertedContent',
            requestId: msg.requestId,
            data,
          }),
          (error) => ({
            type: 'dwgConvertedContent',
            requestId: msg.requestId,
            data: null,
            error,
          })
        );
        return true;

      case 'requestEbookConvert':
        forwardRpc(
          post,
          () => ipcApi.convertEbookToEpub(msg.path, { calibrePath }),
          (data) => ({
            type: 'ebookConvertedContent',
            requestId: msg.requestId,
            data,
          }),
          (error) => ({
            type: 'ebookConvertedContent',
            requestId: msg.requestId,
            data: null,
            error,
          })
        );
        return true;

      case 'requestFileBytes':
        // pdf-viewer can't `fetch(whale-file://)` — Chromium CORS blocks
        // cross-origin fetch to custom schemes (only http/https/data/chrome
        // are allowed) — so it asks the host to read the file and ship the
        // raw bytes back. Electron structured-clones the Uint8Array through
        // postMessage (one memcpy, no base64, no O(n²) decode). Mirrors
        // office-viewer's officePdfContent path.
        forwardRpc(
          post,
          () => ipcApi.readFile(msg.path),
          (buf) => ({
            type: 'fileBytes',
            requestId: msg.requestId,
            data: new Uint8Array(buf),
          }),
          (error) => ({
            type: 'fileBytes',
            requestId: msg.requestId,
            data: null,
            error,
          })
        );
        return true;

      case 'requestSaveImage':
        // §paste-image (md-editor): save the pasted clipboard image into the
        // .md's directory, return the absolute path so the editor can link it.
        forwardRpc(
          post,
          () => ipcApi.saveImageToFile(msg.dataURL, msg.dirPath, msg.ext),
          (savedPath) => ({
            type: 'imageSaved',
            requestId: msg.requestId,
            path: savedPath,
          }),
          (error) => ({
            type: 'imageSaved',
            requestId: msg.requestId,
            path: null,
            error,
          })
        );
        return true;

      case 'requestReadEbookAnnotations':
        forwardRpc(
          post,
          () => ipcApi.readEbookAnnotations(msg.path),
          (payload) => ({
            type: 'ebookAnnotations',
            requestId: msg.requestId,
            ok: true,
            payload: payload ?? null,
          }),
          (error) => ({
            type: 'ebookAnnotations',
            requestId: msg.requestId,
            ok: false,
            payload: null,
            error,
          })
        );
        return true;

      case 'requestWriteEbookAnnotations':
        forwardRpc(
          post,
          () =>
            ipcApi.writeEbookAnnotations(
              msg.path,
              msg.payload as Parameters<typeof ipcApi.writeEbookAnnotations>[1]
            ),
          () => ({
            type: 'ebookAnnotations',
            requestId: msg.requestId,
            ok: true,
            payload: null,
          }),
          (error) => ({
            type: 'ebookAnnotations',
            requestId: msg.requestId,
            ok: false,
            payload: null,
            error,
          })
        );
        return true;

      case 'requestArchiveList':
        forwardRpc(
          post,
          () =>
            ipcApi.listArchive(msg.path, {
              maxEntries: msg.maxEntries,
              password: msg.password,
            }),
          ({ entries, truncated }) => ({
            type: 'archiveList',
            requestId: msg.requestId,
            entries,
            truncated,
          }),
          (error) => ({
            type: 'archiveList',
            requestId: msg.requestId,
            entries: [],
            truncated: false,
            error,
          })
        );
        return true;

      case 'requestArchiveEntry':
        forwardRpc(
          post,
          () =>
            ipcApi.readArchiveEntry(msg.path, msg.entryPath, {
              password: msg.password,
              force: msg.force,
            }),
          (result) => ({
            type: 'archiveEntryContent',
            requestId: msg.requestId,
            base64: result?.base64 ?? '',
            size: result?.size ?? 0,
          }),
          (error) => ({
            type: 'archiveEntryContent',
            requestId: msg.requestId,
            base64: '',
            size: 0,
            error,
          })
        );
        return true;

      case 'requestArchiveExtract':
        forwardRpc(
          post,
          () =>
            ipcApi.extractArchive(msg.path, msg.destDir, {
              password: msg.password,
              flatten: msg.flatten,
            }),
          ({ written, skipped, errors }) => ({
            type: 'archiveExtracted',
            requestId: msg.requestId,
            written,
            skipped,
            errors,
          }),
          (error) => ({
            type: 'archiveExtracted',
            requestId: msg.requestId,
            written: 0,
            skipped: [],
            errors: [],
            error,
          })
        );
        return true;

      case 'requestDirectoryDialog':
        forwardRpc(
          post,
          () => ipcApi.openDirectoryDialog(),
          (selected) => ({
            type: 'directoryDialogResult',
            requestId: msg.requestId,
            path: selected,
          }),
          () => ({
            type: 'directoryDialogResult',
            requestId: msg.requestId,
            path: null,
          })
        );
        return true;

      case 'requestClipboardText':
        // md-editor context menu Paste — read the clipboard in the main
        // process (the iframe's own Clipboard API is Permissions-Policy-gated).
        forwardRpc(
          post,
          () => ipcApi.readClipboardText(),
          (text) => ({
            type: 'clipboardText',
            requestId: msg.requestId,
            text,
          }),
          () => ({
            type: 'clipboardText',
            requestId: msg.requestId,
            text: '',
          })
        );
        return true;

      default:
        return false;
    }
  };
}
