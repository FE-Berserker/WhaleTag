/**
 * Types shared between the host (renderer main app) and built-in extensions.
 * Keep this file free of Node-only or DOM-only imports.
 */

export const EXT_PROTOCOL_VERSION = 1;

export type ExtensionType = 'viewer' | 'editor';

export interface ExtensionManifest {
  id: string;
  name: string;
  type: ExtensionType;
  /** Hex color used for icons / accents. */
  color: string;
  /** Lowercase extensions without the leading dot, e.g. ['txt', 'md']. */
  fileTypes: string[];
  /** Entry HTML file, relative to the extension's dist folder. */
  entryPoint: string;
  enabled: boolean;
  isDefault: boolean;
}

export interface ExtensionRegistry {
  extensions: ExtensionManifest[];
  generatedAt: string;
}

export type MessageSource = 'host' | 'extension';

export interface ExtensionEnvelope<T = unknown> {
  protocolVersion: number;
  source: MessageSource;
  message: T;
}

// Host -> Extension messages

export interface FileContentMessage {
  type: 'fileContent';
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
  readOnly: boolean;
  /** File size in bytes, supplied by the host when available. Optional so
   *  older hosts/extensions stay compatible. The extension uses it for the
   *  status bar; if absent the extension falls back to `—`. */
  size?: number;
  /**
   * Absolute directory of the file, supplied by the host when available.
   * Optional so older hosts stay compatible. Extensions that render images
   * (e.g. md-editor) use this to resolve `<img src="./relative.png">` into
   * a streamable `whale-file://` URL. The host should compute it once
   * (e.g. via `path.dirname(filePath)`) and pass it as-is — the extension
   * does no further normalization. If absent, the extension treats any
   * relative `src` as a remote URL and lets it 404.
   */
  dirPath?: string;
}

export interface SavingFileMessage {
  type: 'savingFile';
  path: string;
}

export interface SetThemeMessage {
  type: 'setTheme';
  theme: 'light' | 'dark';
}

export interface SetReadOnlyMessage {
  type: 'setReadOnly';
  readOnly: boolean;
}

/** Host -> Extension: the host UI language (e.g. 'en', 'zh'). Sent on ready and
 *  whenever the user switches language, so the extension panel can re-render its
 *  own strings. Extensions carry their own small string catalogs (the host does
 *  not ship per-extension translations). */
export interface SetLocaleMessage {
  type: 'setLocale';
  locale: string;
}

export interface RequestSaveMessage {
  type: 'requestSave';
  path: string;
}

/** Host -> Extension (inline edit): ask the editor for its current selection.
 *  The extension responds with {@link EditorSelectionMessage} carrying the same
 *  `requestId`. */
export interface RequestSelectionMessage {
  type: 'requestSelection';
  requestId: string;
}

/** Host -> Extension (inline edit): replace the given document range with the
 *  AI-produced text (originally the selection range). */
export interface ApplyReplacementMessage {
  type: 'applyReplacement';
  from: number;
  to: number;
  text: string;
}

/** Host -> Extension: binary asset bytes requested by the PDF viewer's data
 *  factory (cmap / standard font / wasm). `data` is null when not found. */
export interface PdfAssetMessage {
  type: 'pdfAsset';
  requestId: string;
  data: ArrayBuffer | null;
  error?: string;
}

/** Host -> Extension: the occt-import-js wasm bytes requested by cad-viewer.
 *  Fetching `whale-extension://` is unreliable in this Electron build, so the
 *  extension asks the host for the wasm and passes it as emscripten
 *  `wasmBinary`. `data` is null on read failure. */
export interface CadWasmMessage {
  type: 'cadWasm';
  requestId: string;
  data: ArrayBuffer | null;
  error?: string;
}

/** Host -> Extension: the libheif-js wasm bytes requested by heic-viewer.
 *  Same bridge pattern as CadWasmMessage — fetch on `whale-extension://` is
 *  unreliable, so the extension requests the wasm and feeds it to emscripten
 *  as `wasmBinary`. `data` is null on read failure. */
export interface HeicWasmMessage {
  type: 'heicWasm';
  requestId: string;
  data: ArrayBuffer | null;
  error?: string;
}

/** Host -> Extension: DXF bytes produced from a DWG file by an external
 *  converter (LibreDWG dwg2dxf / ODA File Converter). `data` is null when no
 *  converter is installed or the conversion failed. */
export interface DwgConvertedContentMessage {
  type: 'dwgConvertedContent';
  requestId: string;
  data: ArrayBuffer | null;
  error?: string;
}

/** Host -> Extension: a file is being dragged from Whale's directory tree over
 *  the extension (e.g. into the Excalidraw canvas). The iframe can't read the
 *  dropped File's path, so the host supplies it. active=false on drag end. */
export interface ExternalDragMessage {
  type: 'externalDrag';
  active: boolean;
  path?: string;
  name?: string;
  /** Images embed natively via the OS drop; non-images get a thumbnail+link. */
  isImage?: boolean;
  /** True when the dragged item is a directory (folders are never image-native
   *  drops, so extensions that insert a thumbnail always go through the
   *  `requestFileEmbed` round-trip). */
  isDirectory?: boolean;
}

/** Host -> Extension: thumbnail + metadata for a dropped non-image file, so the
 *  editor can insert a linked thumbnail element. */
export interface FileEmbedMessage {
  type: 'fileEmbed';
  path: string;
  name: string;
  /** A data: URL (real thumbnail, or a generic file-type icon as fallback). */
  thumbnailDataUrl: string;
}

/** Host -> Extension: the list of sibling files the extension can navigate
 *  to (e.g. image-viewer's prev/next within the current directory). Sent
 *  alongside `fileContent` so the viewer can light up its prev/next buttons
 *  immediately, and request a different path with `RequestFileMessage` when
 *  the user presses `←`/`→` or clicks a sibling button.
 *  - `current` is the file the extension is currently displaying (member of
 *    `paths`, or absent if the current file lives in another directory).
 *  - `paths` is a flat list of absolute paths in display order. The viewer is
 *    free to wrap around; the host does not pre-send file contents. */
export interface SiblingsMessage {
  type: 'siblings';
  current: string;
  paths: string[];
}

/** Host -> Extension: PDF bytes produced by converting an Office document.
 *  `data` is null when conversion failed; `error` carries a human-readable reason. */
export interface OfficePdfContentMessage {
  type: 'officePdfContent';
  requestId: string;
  data: Uint8Array | null;
  error?: string;
}

/** Host -> Extension: a file's thumbnail as a `data:image/jpeg;base64,...` URL
 *  (or `null` when no thumbnail has been generated yet). Used by office-viewer
 *  as an instant first-page placeholder while LibreOffice cold-converts the
 *  document to PDF (docs/15 P3-1). Same bytes the file-browser thumbnail
 *  pipeline already cached at `<dir>/.whale/thumbs/<basename>.jpg`. */
export interface ThumbnailContentMessage {
  type: 'thumbnailContent';
  requestId: string;
  dataUrl: string | null;
}

/** Host -> Extension: EPUB bytes produced by converting a MOBI/AZW/AZW3 ebook
 *  with Calibre. `data` is null when conversion failed; `error` carries the reason. */
export interface EbookConvertedContentMessage {
  type: 'ebookConvertedContent';
  requestId: string;
  data: ArrayBuffer | null;
  error?: string;
}

/** Host -> Extension: the list of entries inside an archive, produced by the
 *  main-process decoder. Paths are POSIX-style. */
export interface ArchiveListMessage {
  type: 'archiveList';
  requestId: string;
  entries: Array<{ path: string; size: number; compressedSize: number; mtime: number; isDir: boolean }>;
  truncated: boolean;
  error?: string;
}

/** Host -> Extension: base64-encoded bytes for a single archive entry. */
export interface ArchiveEntryContentMessage {
  type: 'archiveEntryContent';
  requestId: string;
  base64: string;
  size: number;
  error?: string;
}

/** Host -> Extension: result of extracting an archive to a directory. */
export interface ArchiveExtractedMessage {
  type: 'archiveExtracted';
  requestId: string;
  written: number;
  skipped: string[];
  errors: string[];
  error?: string;
}

/** Host -> Extension: result of a directory-picker dialog requested by an
 *  extension (e.g. archive-viewer's "Extract to folder"). */
export interface DirectoryDialogResultMessage {
  type: 'directoryDialogResult';
  requestId: string;
  path: string | null;
}

/** Host -> Extension: a streaming URL (`whale-file://...`) for large media files
 *  that the browser can fetch with Range requests. Replaces buffering the entire
 *  file into the renderer for video and native-playable audio. */
export interface StreamingUrlMessage {
  type: 'streamingUrl';
  path: string;
  url: string;
}

/** Host -> Extension: answer to `requestSofficeCheck` — whether LibreOffice
 *  (`soffice`) is installed. The office-viewer uses this to show install
 *  guidance up front instead of a bare "soffice not found" dead-end
 *  (docs/09 §16.16). */
export interface SofficeCheckResultMessage {
  type: 'sofficeCheckResult';
  requestId: string;
  available: boolean;
}

export type HostMessage =
  | FileContentMessage
  | SavingFileMessage
  | SetThemeMessage
  | SetReadOnlyMessage
  | SetLocaleMessage
  | RequestSaveMessage
  | PdfAssetMessage
  | CadWasmMessage
  | HeicWasmMessage
  | DwgConvertedContentMessage
  | OfficePdfContentMessage
  | SofficeCheckResultMessage
  | ThumbnailContentMessage
  | EbookConvertedContentMessage
  | ArchiveListMessage
  | ArchiveEntryContentMessage
  | ArchiveExtractedMessage
  | DirectoryDialogResultMessage
  | ExternalDragMessage
  | FileEmbedMessage
  | SiblingsMessage
  | EbookAnnotationsMessage
  | RequestSelectionMessage
  | ApplyReplacementMessage
  | StreamingUrlMessage;

// Extension -> Host messages

export interface ReadyMessage {
  type: 'ready';
}

export interface LoadDefaultTextContentMessage {
  type: 'loadDefaultTextContent';
  path: string;
}

export interface ParentSaveDocumentMessage {
  type: 'parentSaveDocument';
  path: string;
  content: string;
}

export interface ContentChangedMessage {
  type: 'contentChangedInEditor';
  path: string;
  dirty: boolean;
}

export interface EditDocumentMessage {
  type: 'editDocument';
  path: string;
}

export interface PlaybackEndedMessage {
  type: 'playbackEnded';
}

export interface ThumbnailGeneratedMessage {
  type: 'thumbnailGenerated';
  path: string;
  thumbnailBase64: string;
}

export interface OpenLinkExternallyMessage {
  type: 'openLinkExternally';
  url: string;
}

export interface ErrorMessage {
  type: 'error';
  path: string;
  message: string;
}

/** Extension -> Host: PDF viewer requesting cmap / font / wasm asset bytes. */
export interface RequestPdfAssetMessage {
  type: 'requestPdfAsset';
  requestId: string;
  kind: 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl';
  filename: string;
}

/** Extension -> Host: cad-viewer requesting the occt-import-js wasm bytes. */
export interface RequestCadWasmMessage {
  type: 'requestCadWasm';
  requestId: string;
}

/** Extension -> Host: heic-viewer requesting the libheif-js wasm bytes. */
export interface RequestHeicWasmMessage {
  type: 'requestHeicWasm';
  requestId: string;
}

/** Extension -> Host: cad-viewer requesting DWG→DXF conversion (path-based:
 *  the main process reads the DWG from disk and shells out to a converter). */
export interface RequestDwgConvertMessage {
  type: 'requestDwgConvert';
  requestId: string;
  path: string;
}

/** Extension -> Host: request a thumbnail + metadata for a dropped non-image
 *  file so it can be inserted as a linked thumbnail (answered with fileEmbed).
 *  `isDirectory` switches the host between `loadThumbnail` (per-file pipeline)
 *  and `loadFolderThumbnail` (`<dir>/.whale/wst.jpg`). */
export interface RequestFileEmbedMessage {
  type: 'requestFileEmbed';
  path: string;
  isDirectory?: boolean;
}

/** Extension -> Host: office viewer requests the host convert the Office document
 *  to PDF bytes. The host answers with `officePdfContent`. */
export interface RequestOfficeConvertMessage {
  type: 'requestOfficeConvert';
  requestId: string;
  path: string;
}

/** Extension -> Host: office viewer requests the file's cached thumbnail (a
 *  `data:` URL) to show as an instant placeholder during the LibreOffice→PDF
 *  cold convert. The host answers with `thumbnailContent` (dataUrl null when
 *  no thumbnail exists yet). docs/15 P3-1. */
export interface RequestThumbnailMessage {
  type: 'requestThumbnail';
  requestId: string;
  path: string;
}

/** Extension -> Host: office-viewer asks whether LibreOffice (`soffice`) is
 *  installed, so it can show install guidance before attempting the doomed
 *  convert (docs/09 §16.16). The host answers with `sofficeCheckResult`. */
export interface RequestSofficeCheckMessage {
  type: 'requestSofficeCheck';
  requestId: string;
}

/** Extension -> Host: open `path` with the OS default application. Used as the
 *  fallback when LibreOffice is missing or conversion fails, so the user is
 *  never stuck on a dead-end error page (docs/09 §16.21). Fire-and-forget. */
export interface OpenWithSystemMessage {
  type: 'openWithSystem';
  path: string;
}

/** Extension -> Host: ebook viewer requests the host convert a MOBI/AZW/AZW3
 *  file to EPUB bytes using Calibre. The host answers with `ebookConvertedContent`. */
export interface RequestEbookConvertMessage {
  type: 'requestEbookConvert';
  requestId: string;
  path: string;
}

/** Extension -> Host: media-player requests a streaming URL for a media file
 *  so the browser can request ranges instead of buffering the whole file in
 *  the renderer. The host picks the scheme by extension: `whale-file://` for
 *  video / native-playable audio, `whale-audio://` for transcode-only formats
 *  (APE/WMA/etc) which the host live-transcodes to Opus and streams. */
export interface RequestStreamingUrlMessage {
  type: 'requestStreamingUrl';
  path: string;
}

/** Extension -> Host: request the main-process archive decoder list entries. */
export interface RequestArchiveListMessage {
  type: 'requestArchiveList';
  requestId: string;
  path: string;
  maxEntries?: number;
  password?: string;
}

/** Extension -> Host: ask the host to load and deliver the file at `path` as
 *  a normal `fileContent` message. Used by image-viewer's prev/next — the host
 *  already published the sibling list via `SiblingsMessage`, so the viewer
 *  just points at one of those paths and the host re-sends fileContent
 *  (re-encoding through `readFileContent` so the same base64 / utf8 plumbing
 *  is reused). The host is free to ignore requests for paths outside the
 *  active location. */
export interface RequestFileMessage {
  type: 'requestFile';
  path: string;
}

/** Extension -> Host (inline edit): the editor's current selection, in reply to
 *  {@link RequestSelectionMessage}. `selectedText` is empty when nothing is
 *  selected. `from`/`to` are CodeMirror document offsets. */
export interface EditorSelectionMessage {
  type: 'editorSelection';
  requestId: string;
  path: string;
  selectedText: string;
  from: number;
  to: number;
}

/** Extension -> Host: the background-music dock's "maximize" button. The host
 *  promotes the current track to a fullscreen media-player view (overlaying
 *  the dock); dock state is preserved so playback resumes from the bar when
 *  the user closes the viewer. */
export interface RequestOpenInViewMessage {
  type: 'requestOpenInView';
  path: string;
}

/** Extension -> Host: the background-music dock's "collapse" button. The host
 *  hides the dock until the next time the user enqueues a track or explicitly
 *  restores it. `dismissed` survives across mounts (persisted via localStorage). */
export interface RequestHideMessage {
  type: 'requestHide';
}

/** Extension -> Host: ebook-viewer asks for the persisted annotations file
 *  (`.whale/ebook-annotations/<basename>.json`). The host answers with
 *  `ebookAnnotations` carrying the same `requestId`. The file may not exist
 *  yet — `payload` is then `null`. */
export interface RequestReadEbookAnnotationsMessage {
  type: 'requestReadEbookAnnotations';
  requestId: string;
  path: string;
}

/** Extension -> Host: ebook-viewer pushes its full annotations snapshot for
 *  persistence. The extension owns the authoritative state — the host just
 *  stores it atomically under the per-directory lock. The host replies with
 *  `ebookAnnotations` carrying the same `requestId` and `ok: true`. */
export interface RequestWriteEbookAnnotationsMessage {
  type: 'requestWriteEbookAnnotations';
  requestId: string;
  path: string;
  payload: unknown;
}

/** Host -> Extension: response to a `requestReadEbookAnnotations` /
 *  `requestWriteEbookAnnotations`. `payload` is the parsed JSON content (or
 *  `null` for a fresh book / a successful write). `error` is set when the
 *  operation failed. */
export interface EbookAnnotationsMessage {
  type: 'ebookAnnotations';
  requestId: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

/** Extension -> Host: request a single archive entry's bytes (base64). */
export interface RequestArchiveEntryMessage {
  type: 'requestArchiveEntry';
  requestId: string;
  path: string;
  entryPath: string;
  password?: string;
  force?: boolean;
}

/** Extension -> Host: request extraction of the whole archive to destDir. */
export interface RequestArchiveExtractMessage {
  type: 'requestArchiveExtract';
  requestId: string;
  path: string;
  destDir: string;
  password?: string;
  flatten?: boolean;
}

/** Extension -> Host: request a directory picker dialog. The host answers with
 *  directoryDialogResult. */
export interface RequestDirectoryDialogMessage {
  type: 'requestDirectoryDialog';
  requestId: string;
}

export type ExtensionMessage =
  | ReadyMessage
  | LoadDefaultTextContentMessage
  | ParentSaveDocumentMessage
  | ContentChangedMessage
  | EditDocumentMessage
  | PlaybackEndedMessage
  | ThumbnailGeneratedMessage
  | OpenLinkExternallyMessage
  | ErrorMessage
  | RequestPdfAssetMessage
  | RequestCadWasmMessage
  | RequestHeicWasmMessage
  | RequestDwgConvertMessage
  | RequestOfficeConvertMessage
  | RequestSofficeCheckMessage
  | OpenWithSystemMessage
  | RequestThumbnailMessage
  | RequestEbookConvertMessage
  | RequestStreamingUrlMessage
  | RequestArchiveListMessage
  | RequestArchiveEntryMessage
  | RequestArchiveExtractMessage
  | RequestDirectoryDialogMessage
  | RequestFileEmbedMessage
  | RequestFileMessage
  | RequestReadEbookAnnotationsMessage
  | RequestWriteEbookAnnotationsMessage
  | EditorSelectionMessage
  | RequestOpenInViewMessage
  | RequestHideMessage;

/** Runtime API injected into each extension iframe as `window.whaleExt`. */
export interface WhaleExtApi {
  postMessage: (msg: ExtensionMessage) => void;
  onMessage: (handler: (msg: HostMessage) => void) => () => void;
  manifest: ExtensionManifest;
  /** Current host UI locale (e.g. 'en', 'zh'); defaults to 'en' until the host
   *  sends its first setLocale. */
  locale: string;
  /** Subscribe to locale changes. The handler fires immediately with the current
   *  locale and again whenever the host switches language. Returns unsubscribe. */
  onLocale: (handler: (locale: string) => void) => () => void;
  /** Pick the catalog entry for the current locale, falling back to the base
   *  language tag then to `en`. `catalog` is `{ en: {...}, zh: {...} }`. */
  t: <T>(catalog: Record<string, T>) => T;
}

export interface RevisionInfo {
  /** ISO-8601 timestamp of the backup. */
  timestamp: string;
  /** Absolute path to the revision file. */
  path: string;
  /** Size in bytes. */
  size: number;
}

/** Identifies the kind of file content an extension needs. */
export type ExtensionEncoding = 'utf8' | 'base64';

/** Returns whether a value is a valid ExtensionEnvelope from the expected source. */
export function isValidEnvelope<T>(
  data: unknown,
  expectedSource: MessageSource
): data is ExtensionEnvelope<T> {
  if (typeof data !== 'object' || data === null) return false;
  const env = data as Partial<ExtensionEnvelope<T>>;
  return (
    env.protocolVersion === EXT_PROTOCOL_VERSION &&
    env.source === expectedSource &&
    env.message !== undefined
  );
}
