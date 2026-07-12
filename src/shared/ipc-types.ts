/**
 * Types shared between the main process and the renderer via the preload bridge.
 * Keep this file free of Node-only or DOM-only imports.
 */
import type { LocationType, SidecarMeta, FolderMeta } from './whale-meta';
import type { SearchQuery } from './search-query';
import type { ExtensionRegistry, RevisionInfo } from './extension-types';
import type { EbookAnnotations } from './ebook-annotations';
import type {
  ListArchiveOptions,
  ListArchiveResult,
  ReadArchiveEntryOptions,
  ReadArchiveEntryResult,
  ExtractArchiveOptions,
  ExtractArchiveResult,
} from './archive-types';
import type {
  AiApprovalRequest,
  AiComponentInstallResult,
  AiComponentState,
  AiComponentUninstallResult,
  AiQueryPayload,
  ApprovalDecision,
  StreamChunk,
} from './ai-types';

export interface DirEntry {
  /** Display name, e.g. "report.pdf". */
  name: string;
  /** Absolute path (OS-native separators), e.g. "C:\\Users\\me\\report.pdf". */
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  /** Size in bytes (0 for directories). */
  size: number;
  /** ISO-8601 modification time. */
  modified: string;
  /** Lowercase extension without dot, e.g. "pdf". Empty for directories. */
  extension: string;
}

/** A flattened entry in a location's search index (`.whale/wsi.json`). */
export interface IndexEntry {
  name: string;
  /** Path relative to the location root, using '/' separators (portable). */
  path: string;
  isDir: boolean;
  size: number;
  /** Last modified, epoch milliseconds. */
  mtime: number;
  ext: string;
  /** Effective tags (filename-embedded ∪ sidecar) — used for tag search. */
  tags: string[];
}

/** A full-text search hit returned from a `wsft.jsonl` index. */
export interface FulltextHit {
  /** Absolute path to the matching file. */
  path: string;
  name: string;
  /** Short excerpt of the content around the first match. */
  snippet: string;
}

/**
 * P3-4: persisted result of an EXIF GPS extraction attempt. Stored in
 * `index.db` per root so reopening a directory doesn't re-decode every
 * image. The renderer reads the cache on directory mount to skip files
 * already known to lack GPS, and writes back after each attempt.
 */
export interface ExifProcessedRecord {
  path: string;
  /** 'ok' = file has GPS; 'none' = no GPS data (definitively). */
  status: 'ok' | 'none';
  /** Populated only when status === 'ok'. */
  lat: number | null;
  lng: number | null;
  /** Millisecond epoch when the result was recorded. */
  triedAt: number;
}

/**
 * P3-7: a small, render-friendly subset of EXIF metadata for the
 * map-marker popup. Every field is optional — only what the file actually
 * carries comes through. The renderer treats an all-null summary as
 * "EXIF unavailable" and hides the section.
 *
 * Kept in the shared types layer (rather than main-only) so the renderer's
 * cache can hold `ExifSummary` values directly without re-declaring.
 */
export interface ExifSummary {
  dateTaken: string | null;
  camera: string | null;
  lens: string | null;
  focalLength: number | null;
  iso: number | null;
  shutterSpeed: string | null;
}

/** A configured location (root folder) Whale can browse. */
export interface WhaleLocation {
  id: string;
  name: string;
  /** Absolute path to the root directory. */
  path: string;
  type: LocationType;
  isReadOnly: boolean;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

export interface GenerateThumbnailOptions {
  /** Explicit path to the LibreOffice `soffice` binary; null = auto-detect. */
  sofficePath?: string | null;
}

/**
 * The surface exposed on `window.whale` by preload.ts.
 * Mirrored here so both sides agree on the contract.
 */
export interface WhaleApi {
  // Read / navigate
  homeDir: () => Promise<string>;
  parentDir: (dirPath: string) => Promise<string>;
  listDirectory: (dirPath: string) => Promise<DirEntry[]>;
  /** Recursively list entries under `dirPath` up to `maxDepth` levels deep. */
  listDirectoryRecursive: (
    dirPath: string,
    options?: { maxDepth?: number }
  ) => Promise<DirEntry[]>;
  readTextFile: (filePath: string) => Promise<string>;
  /** Reads an arbitrary file as an ArrayBuffer (for creating blob URLs in the renderer). */
  readFile: (filePath: string) => Promise<ArrayBuffer>;
  pathExists: (targetPath: string) => Promise<boolean>;
  openDirectoryDialog: () => Promise<string | null>;
  /** Shows the native file picker restricted to images. Returns null if cancelled. */
  openImageFileDialog: () => Promise<string | null>;
  openComponentFileDialog: () => Promise<string | null>;

  /** Register configured location roots so main can confine writes to them. */
  setAllowedRoots: (roots: string[]) => Promise<void>;

  // Mutations (reject on failure — never resolve success on error)
  rename: (oldPath: string, newPath: string) => Promise<void>;
  move: (oldPath: string, newPath: string) => Promise<void>;
  copy: (sourcePath: string, destPath: string) => Promise<void>;
  /** Copy external files/folders (dragged in) into `destDir`; never overwrites. */
  importExternal: (
    sources: string[],
    destDir: string
  ) => Promise<{ copied: number; errors: string[]; importedPaths: string[] }>;
  /** Resolve a dropped DOM File to its absolute filesystem path (Electron webUtils). */
  getPathForFile: (file: File) => string;
  deletePath: (targetPath: string, useTrash?: boolean) => Promise<void>;
  createDirectory: (dirPath: string) => Promise<void>;
  createTextFile: (filePath: string, content: string) => Promise<void>;
  openNative: (targetPath: string) => Promise<void>;
  /**
   * Run a user-configured shell command (Settings → Commands) on a file/folder.
   * Main quotes the path + opens a terminal window; resolves `{ ok: true }`
   * once launched. Rejects with `Error(COMMAND_PATH_BLOCKED)` if the path can't
   * be safely substituted (e.g. `%` on Windows), or the assertWithinAllowedRoot
   * error if the path is outside a configured location.
   */
  runCommand: (template: string, targetPath: string) => Promise<{ ok: true }>;

  /**
   * Zips a directory into a sibling `<dir>.zip` (auto-suffixed if taken).
   * Resolves with the created archive's path. Reject on failure.
   */
  zipDirectory: (dirPath: string) => Promise<string>;

  /**
   * Zips an explicit set of entries (a multi-selection, all in one folder) into
   * the user-named `zipPath`. Rejects if `zipPath` already exists. Resolves with
   * the archive path.
   */
  zipEntries: (paths: string[], zipPath: string) => Promise<string>;

  /** Opens the OS recycle bin / trash. */
  openTrash: () => Promise<void>;

  /** Reveal a file/folder in the OS file manager. */
  revealPath: (targetPath: string) => Promise<void>;
  /**
   * H.23 P1-7: like `revealPath`, but additionally **selects / highlights**
   * the file inside its parent (Explorer highlight, Finder select, Nautilus
   * `--select`). Implementation uses `child_process.execFile` per platform
   * (`explorer /select` / `open -R` / `xdg-open` + `nautilus --select`
   * fallback) — see `main/ipc.ts` for the exact branch. Resolves when the
   * file-manager process is launched (not when the user closes the window);
   * Linux tools often exit immediately so the renderer can't observe a
   * "real" completion.
   */
  revealAndSelect: (targetPath: string) => Promise<void>;

  // EXIF / GPS extraction for the Mapique perspective.
  extractGps: (filePath: string) => Promise<{ lat: number; lng: number } | null>;
  // P3-7: popup EXIF summary (dateTaken / camera / lens / focalLength /
  // iso / shutterSpeed). Fetched lazily on marker click — never blocks
  // the initial map render.
  getExifSummary: (filePath: string) => Promise<ExifSummary>;
  // P3-4: EXIF extraction cache. Persists "already tried" results in
  // `index.db` so reopening a directory doesn't re-decode every image.
  loadExifProcessed: (rootPath: string) => Promise<ExifProcessedRecord[]>;
  markExifProcessed: (
    rootPath: string,
    record: ExifProcessedRecord
  ) => Promise<void>;
  /** Batched variant — one IPC + one SQLite transaction per batch instead of
   *  per image (used by the Mapique folder EXIF extractor). */
  markExifProcessedMany: (
    rootPath: string,
    records: ExifProcessedRecord[]
  ) => Promise<void>;
  clearExifProcessed: (rootPath: string) => Promise<void>;

  // Index (Phase 2)
  buildLocationIndex: (rootPath: string) => Promise<{ count: number }>;
  /** Filename/path/tags fuzzy search via FTS5 (plan §6.6 P2). */
  queryIndex: (rootPath: string, q: string) => Promise<IndexEntry[]>;
  /** Structured (advanced) search compiled to SQL. */
  advancedIndex: (rootPath: string, q: SearchQuery) => Promise<IndexEntry[]>;
  /** Distinct tags across the index (for the advanced-search tag picker). */
  indexTags: (rootPath: string) => Promise<string[]>;
  /** Index status: row count + whether a db exists. */
  indexStatus: (rootPath: string) => Promise<{ count: number; ready: boolean }>;

  // Full-text index (Phase 2) — keyed by an arbitrary directory root.
  buildFulltextIndex: (rootPath: string) => Promise<{ count: number }>;
  searchFulltext: (rootPath: string, query: string) => Promise<FulltextHit[]>;
  hasFulltextIndex: (rootPath: string) => Promise<boolean>;

  // Sidecar metadata (`.whale/<file>.json`)
  readSidecars: (
    dirPath: string,
    names: string[]
  ) => Promise<Record<string, SidecarMeta>>;
  // H.24 R7: read sidecars for an arbitrary set of file paths in a single
  // round trip. The renderer (DirectoryContentContextProvider) groups the
  // recursive scan's flat entry list by parent directory, but the key in the
  // returned record is the FULL input path so that two same-named files in
  // different subdirs don't collide. Missing entries are omitted.
  readSidecardsForPaths: (
    filePaths: string[]
  ) => Promise<Record<string, SidecarMeta>>;
  writeSidecar: (filePath: string, meta: SidecarMeta) => Promise<void>;

  // Folder metadata (`.whale/wsm.json`) — read returns {} if absent; write
  // merges the given keys (never clobbers untouched fields).
  readFolderMeta: (dirPath: string) => Promise<FolderMeta>;
  writeFolderMeta: (
    dirPath: string,
    patch: Partial<FolderMeta>
  ) => Promise<void>;

  // Per-location tag library (`.whale/wtaglib.json`): the location's vocabulary
  // — currently just a free-form description per tag, editable from both the
  // right-side tag library panel and the file tray. One tag, one description
  // per location; descriptions are NOT inherited from a parent location.
  readTagLibrary: (locationRoot: string) => Promise<Record<string, string>>;
  setTagLibraryDescription: (
    locationRoot: string,
    tag: string,
    description: string
  ) => Promise<void>;
  clearTagLibraryDescription: (
    locationRoot: string,
    tag: string
  ) => Promise<void>;

  // Ebook-viewer annotation persistence (`.whale/ebook-annotations/<basename>.json`).
  // `readEbookAnnotations` returns `null` when the file does not exist yet
  // (i.e. fresh book, no user data). `writeEbookAnnotations` deletes the file
  // when the payload carries only defaults.
  readEbookAnnotations: (filePath: string) => Promise<EbookAnnotations | null>;
  writeEbookAnnotations: (
    filePath: string,
    payload: EbookAnnotations
  ) => Promise<void>;

  // Image thumbnails — generate writes `.whale/thumbs/<file>.jpg`; load returns
  // a data: URL (null if none yet). See plan §6.6 P1.
  generateThumbnail: (
    filePath: string,
    options?: GenerateThumbnailOptions
  ) => Promise<void>;
  loadThumbnail: (filePath: string) => Promise<string | null>;

  // Folder thumbnails / backgrounds (`wst.jpg` / `wsb.jpg`).
  loadFolderThumbnail: (dirPath: string) => Promise<string | null>;
  loadFolderBackground: (dirPath: string) => Promise<string | null>;
  setFolderThumbnail: (dirPath: string, sourcePath: string) => Promise<void>;
  setFolderBackground: (dirPath: string, sourcePath: string) => Promise<void>;
  clearFolderThumbnail: (dirPath: string) => Promise<void>;
  clearFolderBackground: (dirPath: string) => Promise<void>;

  // Phase 4 — Extension system (viewers / editors / revisions)
  loadExtensionRegistry: () => Promise<ExtensionRegistry | null>;
  backupRevision: (filePath: string) => Promise<void>;
  deleteRevision: (revisionPath: string) => Promise<void>;
  writeFileWithRevision: (filePath: string, content: string) => Promise<void>;
  listRevisions: (filePath: string) => Promise<RevisionInfo[]>;
  restoreRevision: (
    filePath: string,
    revisionPath: string
  ) => Promise<void>;
  cleanupRevisions: (maxAgeDays: number) => Promise<void>;
  /** Read a pdfjs-dist asset (cmap / standard font / wasm) for the PDF viewer
   *  extension, by kind and bare filename. */
  getPdfAsset: (kind: string, filename: string) => Promise<ArrayBuffer>;
  /** Read the occt-import-js wasm bundled into the cad-viewer extension, so it
   *  can be passed to emscripten as `wasmBinary` (fetch on whale-extension://
   *  is unreliable — see the cad-viewer getOcct() loader). */
  getCadWasm: () => Promise<ArrayBuffer>;
  /** Read the libheif-js wasm bundled into the heic-viewer extension, so it can
   *  be passed to emscripten as `wasmBinary` (same fetch-bypass bridge as
   *  getCadWasm — see the heic-viewer getLibheif() loader). */
  getHeicWasm: () => Promise<ArrayBuffer>;
  /** Convert an Office document to PDF bytes using LibreOffice. Returns the PDF
   *  as an ArrayBuffer. Throws if LibreOffice is missing or conversion fails. */
  convertOfficeToPdf: (
    filePath: string,
    options?: { sofficePath?: string | null }
  ) => Promise<ArrayBuffer>;
  /** Convert a DWG file to DXF bytes via an external converter (LibreDWG
   *  `dwg2dxf`, or ODA File Converter as fallback). Returns the DXF as an
   *  ArrayBuffer. Throws if no converter is installed or conversion fails. */
  convertDwgToDxf: (
    filePath: string,
    options?: { dwg2dxfPath?: string | null; odaPath?: string | null }
  ) => Promise<ArrayBuffer>;
  /** Probe for the DWG converters used by {@link convertDwgToDxf}. Returns the
   *  detected binary paths (or null) so the settings UI can show whether DWG
   *  preview will work without actually converting a file. */
  detectDwgConverters: () => Promise<{
    dwg2dxf: string | null;
    oda: string | null;
  }>;
  /** Convert a MOBI/AZW/AZW3 ebook to EPUB bytes using Calibre's ebook-convert.
   *  Returns the EPUB as an ArrayBuffer. Throws if Calibre is missing or the
   *  conversion fails. */
  convertEbookToEpub: (
    filePath: string,
    options?: { calibrePath?: string | null }
  ) => Promise<ArrayBuffer>;
  /** Probe for the Calibre `ebook-convert` binary used by
   *  {@link convertEbookToEpub}. Returns the detected binary path (or null) so
   *  the settings UI can show whether MOBI/AZW/AZW3 preview will work without
   *  actually converting a file. */
  detectEbookConverter: () => Promise<{ calibre: string | null }>;
  /** Transcode an audio file Chromium can't decode (APE/WMA/etc) into Opus
   *  bytes via the bundled ffmpeg, serving from the `.whale/transcodes/` cache
   *  when fresh. Throws when ffmpeg is missing or the transcode fails. */
  convertAudio: (filePath: string) => Promise<ArrayBuffer>;
  // Phase 4b — Archive viewer (main-process decoder)
  /** List the entries of a supported archive (zip/tar/tgz/7z/bz2/xz/gz).
   *  Throws if the format is unsupported or the archive is unreadable. */
  listArchive: (
    filePath: string,
    options?: ListArchiveOptions
  ) => Promise<ListArchiveResult>;
  /** Read a single archive entry as base64 bytes. Throws on error. */
  readArchiveEntry: (
    filePath: string,
    entryPath: string,
    options?: ReadArchiveEntryOptions
  ) => Promise<ReadArchiveEntryResult | null>;
  /** Extract all safe entries from an archive to destDir. Throws on error. */
  extractArchive: (
    filePath: string,
    destDir: string,
    options?: ExtractArchiveOptions
  ) => Promise<ExtractArchiveResult>;
  /** Native "save as" dialog for images; resolves to the chosen path or null. */
  saveImageDialog: (defaultPath: string) => Promise<string | null>;
  /** Write a base64-encoded file (e.g. an exported chart image) to disk. */
  writeBinaryFile: (filePath: string, base64: string) => Promise<void>;
  /** Capture a rectangle of the focused BrowserWindow as a base64 PNG.
   *  Used to export perspectives that cannot be read from canvas due to
   *  cross-origin content (Leaflet tiles, React Flow DOM/SVG). */
  captureRegion: (rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => Promise<string>;
  /** Frameless title-bar window controls (minimize / maximize-toggle / close). */
  windowMinimize: () => Promise<void>;
  windowMaximizeToggle: () => Promise<void>;
  windowClose: () => Promise<void>;
  windowIsMaximized: () => Promise<boolean>;
  /** Subscribe to maximize state changes (for the toggle button icon). Returns an unsubscribe. */
  onWindowMaximizeChange: (callback: (maximized: boolean) => void) => () => void;
  /** Start a native OS drag of a file (Electron webContents.startDrag) so it can
   *  be dropped into sandboxed extension iframes (e.g. an image into Excalidraw).
   *  Fire-and-forget; must be called during the renderer's dragstart. */
  startFileDrag: (filePath: string) => void;

  // Phase 5 — AI assistant. `aiQuery` returns immediately and streams
  // `StreamChunk`s via `onAiChunk` (the only main→renderer push channel).
  aiQuery: (payload: AiQueryPayload) => Promise<{ ok: true }>;
  aiCancel: (conversationId: string) => Promise<{ ok: true }>;
  /** Pre-warm the Claude CLI for the given options (best-effort, no-op for HTTP). */
  aiPrewarm: (payload: AiQueryPayload) => Promise<{ ok: true }>;
  /** Generate a short conversation title (HTTP providers; '' for Claude CLI). */
  aiGenerateTitle: (args: {
    settings: AiQueryPayload['settings'];
    history: AiQueryPayload['history'];
  }) => Promise<{ title: string }>;
  /** Rewrite an editor selection per an instruction (HTTP providers only). */
  aiInlineEdit: (args: {
    settings: AiQueryPayload['settings'];
    selection: string;
    instruction: string;
  }) => Promise<{ replacement: string }>;
  /** Encrypts the key with Electron safeStorage; plaintext never crosses IPC. */
  aiSetApiKey: (key: string) => Promise<{ ok: true }>;
  aiClearApiKey: () => Promise<{ ok: true }>;
  /** True if a key is stored (does not reveal it). */
  aiHasApiKey: () => Promise<boolean>;
  /** Resolve the Claude Code CLI path, honoring a settings override. */
  aiDiscoverCli: (
    override: string | null
  ) => Promise<{ path: string | null }>;
  /** Resolve a pushed approval request (from `onAiApprovalRequest`). */
  aiResolveApproval: (
    reqId: string,
    decision: ApprovalDecision
  ) => Promise<{ ok: true }>;
  /** OpenAI-compatible provider key (encrypted; never reveals plaintext). */
  aiSetOpenaiKey: (key: string) => Promise<{ ok: true }>;
  aiClearOpenaiKey: () => Promise<{ ok: true }>;
  aiHasOpenaiKey: () => Promise<boolean>;
  // Optional AI component (user-installed .whaleai → <userData>/components/ai).
  aiGetComponentState: () => Promise<AiComponentState>;
  aiInstallComponent: (filePath: string) => Promise<AiComponentInstallResult>;
  aiUninstallComponent: () => Promise<AiComponentUninstallResult>;
  /** Subscribe to tool-call approval requests. Returns unsubscribe. */
  onAiApprovalRequest: (cb: (req: AiApprovalRequest) => void) => () => void;
  /** Subscribe to streamed chunks for the active turn. Returns unsubscribe. */
  onAiChunk: (
    cb: (e: { conversationId: string; chunk: StreamChunk }) => void
  ) => () => void;
  /** Subscribe to fatal turn errors. Returns unsubscribe. */
  onAiError: (
    cb: (e: { conversationId: string; message: string }) => void
  ) => () => void;

  /**
   * Lifecycle hook: the main process fires this right before the window closes
   * so the renderer can flush redux-persist (settings, locations, etc.) before
   * the renderer is torn down. The callback should be async and call
   * `flushComplete()` when done so the main process can finish quitting.
   */
  onBeforeUnloadFlush: (cb: () => void | Promise<void>) => () => void;
  /** Notify the main process that the renderer has finished flushing state. */
  flushComplete: () => void;
  /** Ask the main process to close the window (triggers graceful flush). */
  requestQuit: () => void;

  /**
   * Redux-persist storage backed by the main process. localStorage is not
   * reliable in Electron because Chromium flushes it asynchronously; this
   * writes to a JSON file synchronously on disk before returning.
   */
  persistRead: (key: string) => Promise<string | null>;
  persistWrite: (key: string, value: string) => Promise<void>;
  persistDelete: (key: string) => Promise<void>;
  /** Synchronous variants used by the redux-persist storage adapter. */
  persistReadSync: (key: string) => string | null;
  persistWriteSync: (key: string, value: string) => void;
  persistDeleteSync: (key: string) => void;
}
