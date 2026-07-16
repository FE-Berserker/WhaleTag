import type {
  DirEntry,
  IndexEntry,
  FulltextHit,
  ExifProcessedRecord,
  ExifSummary,
  WhaleApi,
  GenerateThumbnailOptions,
} from '../../shared/ipc-types';
import type { SidecarMeta, FolderMeta } from '../../shared/whale-meta';
import type { SearchQuery } from '../../shared/search-query';
import type { ExtensionRegistry, RevisionInfo } from '../../shared/extension-types';
import type { EbookAnnotations } from '../../shared/ebook-annotations';
import type {
  AiApprovalRequest,
  AiComponentInstallResult,
  AiComponentState,
  AiComponentUninstallResult,
  AiQueryPayload,
  ApprovalDecision,
  StreamChunk,
} from '../../shared/ai-types';
import type {
  ListArchiveOptions,
  ListArchiveResult,
  ReadArchiveEntryOptions,
  ReadArchiveEntryResult,
  ExtractArchiveOptions,
  ExtractArchiveResult,
} from '../../shared/archive-types';

/**
 * Thin wrapper around the `window.whale` surface exposed by preload.
 * Centralizing it here keeps components from touching `window` directly and
 * gives a single place to add validation/telemetry later.
 */
const api: WhaleApi | undefined =
  typeof window !== 'undefined' ? window.whale : undefined;

function requireApi(): WhaleApi {
  if (!api) {
    throw new Error(
      'window.whale is undefined — preload bridge not available (running outside Electron?)'
    );
  }
  return api;
}

export const ipcApi = {
  // Read / navigate
  homeDir: (): Promise<string> => requireApi().homeDir(),
  parentDir: (dirPath: string): Promise<string> =>
    requireApi().parentDir(dirPath),
  listDirectory: (dirPath: string): Promise<DirEntry[]> =>
    requireApi().listDirectory(dirPath),
  listDirectoryRecursive: (
    dirPath: string,
    options?: { maxDepth?: number }
  ): Promise<DirEntry[]> => requireApi().listDirectoryRecursive(dirPath, options),
  readTextFile: (filePath: string): Promise<string> =>
    requireApi().readTextFile(filePath),
  readFile: (filePath: string): Promise<ArrayBuffer> =>
    requireApi().readFile(filePath),
  pathExists: (targetPath: string): Promise<boolean> =>
    requireApi().pathExists(targetPath),
  openDirectoryDialog: (): Promise<string | null> =>
    requireApi().openDirectoryDialog(),
  openImageFileDialog: (): Promise<string | null> =>
    requireApi().openImageFileDialog(),
  openComponentFileDialog: (): Promise<string | null> =>
    requireApi().openComponentFileDialog(),

  /** Register configured location roots so main can confine writes to them. */
  setAllowedRoots: (roots: string[]): Promise<void> =>
    requireApi().setAllowedRoots(roots),

  // Mutations
  rename: (oldPath: string, newPath: string): Promise<void> =>
    requireApi().rename(oldPath, newPath),
  move: (oldPath: string, newPath: string): Promise<void> =>
    requireApi().move(oldPath, newPath),
  copy: (sourcePath: string, destPath: string): Promise<void> =>
    requireApi().copy(sourcePath, destPath),
  importExternal: (
    sources: string[],
    destDir: string
  ): Promise<{ copied: number; errors: string[]; importedPaths: string[] }> =>
    requireApi().importExternal(sources, destDir),
  getPathForFile: (file: File): string => requireApi().getPathForFile(file),
  deletePath: (targetPath: string, useTrash?: boolean): Promise<void> =>
    requireApi().deletePath(targetPath, useTrash),
  createDirectory: (dirPath: string): Promise<void> =>
    requireApi().createDirectory(dirPath),
  createTextFile: (filePath: string, content: string): Promise<void> =>
    requireApi().createTextFile(filePath, content),
  openNative: (targetPath: string): Promise<void> =>
    requireApi().openNative(targetPath),
  runCommand: (template: string, targetPath: string): Promise<{ ok: true }> =>
    requireApi().runCommand(template, targetPath),

  /** Zip a folder into a sibling `<dir>.zip`; resolves with the archive path. */
  zipDirectory: (dirPath: string): Promise<string> =>
    requireApi().zipDirectory(dirPath),

  /** Zip selected entries into a user-named archive; resolves with its path. */
  zipEntries: (paths: string[], zipPath: string): Promise<string> =>
    requireApi().zipEntries(paths, zipPath),

  /** Opens the OS recycle bin / trash. */
  openTrash: (): Promise<void> => requireApi().openTrash(),

  /** Reveal a file/folder in the OS file manager. */
  revealPath: (targetPath: string): Promise<void> =>
    requireApi().revealPath(targetPath),
  // H.23 P1-7: highlight the file in its parent (Explorer / Finder /
  // Nautilus). Implementation lives in main/ipc.ts.
  revealAndSelect: (targetPath: string): Promise<void> =>
    requireApi().revealAndSelect(targetPath),

  // EXIF / GPS extraction for the Mapique perspective.
  extractGps: (
    filePath: string
  ): Promise<{ lat: number; lng: number } | null> =>
    requireApi().extractGps(filePath),
  // P3-7: popup EXIF summary — fetched lazily on marker click.
  getExifSummary: (filePath: string): Promise<ExifSummary> =>
    requireApi().getExifSummary(filePath),
  // P3-4: persisted EXIF cache. See `index-db.ts` `exif_processed` table.
  loadExifProcessed: (rootPath: string): Promise<ExifProcessedRecord[]> =>
    requireApi().loadExifProcessed(rootPath),
  markExifProcessed: (
    rootPath: string,
    record: ExifProcessedRecord
  ): Promise<void> => requireApi().markExifProcessed(rootPath, record),
  markExifProcessedMany: (
    rootPath: string,
    records: ExifProcessedRecord[]
  ): Promise<void> => requireApi().markExifProcessedMany(rootPath, records),
  clearExifProcessed: (rootPath: string): Promise<void> =>
    requireApi().clearExifProcessed(rootPath),

  // Index (SQLite — plan §6.6 P2)
  buildLocationIndex: (rootPath: string): Promise<{ count: number }> =>
    requireApi().buildLocationIndex(rootPath),
  queryIndex: (rootPath: string, q: string): Promise<IndexEntry[]> =>
    requireApi().queryIndex(rootPath, q),
  advancedIndex: (rootPath: string, q: SearchQuery): Promise<IndexEntry[]> =>
    requireApi().advancedIndex(rootPath, q),
  indexTags: (rootPath: string): Promise<string[]> =>
    requireApi().indexTags(rootPath),
  indexStatus: (rootPath: string): Promise<{ count: number; ready: boolean }> =>
    requireApi().indexStatus(rootPath),

  // Full-text index
  buildFulltextIndex: (rootPath: string): Promise<{ count: number }> =>
    requireApi().buildFulltextIndex(rootPath),
  searchFulltext: (rootPath: string, query: string): Promise<FulltextHit[]> =>
    requireApi().searchFulltext(rootPath, query),
  hasFulltextIndex: (rootPath: string): Promise<boolean> =>
    requireApi().hasFulltextIndex(rootPath),

  // Sidecar metadata
  readSidecars: (
    dirPath: string,
    names: string[]
  ): Promise<Record<string, SidecarMeta>> =>
    requireApi().readSidecars(dirPath, names),
  readSidecardsForPaths: (
    filePaths: string[]
  ): Promise<Record<string, SidecarMeta>> =>
    requireApi().readSidecardsForPaths(filePaths),
  writeSidecar: (filePath: string, meta: SidecarMeta): Promise<void> =>
    requireApi().writeSidecar(filePath, meta),

  // Folder metadata (`.whale/wsm.json`)
  readFolderMeta: (dirPath: string): Promise<FolderMeta> =>
    requireApi().readFolderMeta(dirPath),
  writeFolderMeta: (
    dirPath: string,
    patch: Partial<FolderMeta>
  ): Promise<void> => requireApi().writeFolderMeta(dirPath, patch),

  // Ebook-viewer annotation persistence (`.whale/ebook-annotations/<basename>.json`).
  // read returns null when the file does not exist (fresh book).
  readEbookAnnotations: (
    filePath: string
  ): Promise<EbookAnnotations | null> =>
    requireApi().readEbookAnnotations(filePath),
  writeEbookAnnotations: (
    filePath: string,
    payload: EbookAnnotations
  ): Promise<void> => requireApi().writeEbookAnnotations(filePath, payload),

  // Per-location tag library (`.whale/wtaglib.json`): one description per tag.
  // Read returns {} when absent; setDescription trims and removes empty entries;
  // clearDescription is idempotent.
  readTagLibrary: (locationRoot: string): Promise<Record<string, string>> =>
    requireApi().readTagLibrary(locationRoot),
  setTagLibraryDescription: (
    locationRoot: string,
    tag: string,
    description: string
  ): Promise<void> =>
    requireApi().setTagLibraryDescription(locationRoot, tag, description),
  clearTagLibraryDescription: (
    locationRoot: string,
    tag: string
  ): Promise<void> =>
    requireApi().clearTagLibraryDescription(locationRoot, tag),

  // Image thumbnails
  generateThumbnail: (
    filePath: string,
    options?: GenerateThumbnailOptions
  ): Promise<void> => requireApi().generateThumbnail(filePath, options),
  loadThumbnail: (filePath: string): Promise<string | null> =>
    requireApi().loadThumbnail(filePath),

  // Folder thumbnails / backgrounds
  loadFolderThumbnail: (dirPath: string): Promise<string | null> =>
    requireApi().loadFolderThumbnail(dirPath),
  loadFolderBackground: (dirPath: string): Promise<string | null> =>
    requireApi().loadFolderBackground(dirPath),
  setFolderThumbnail: (dirPath: string, sourcePath: string): Promise<void> =>
    requireApi().setFolderThumbnail(dirPath, sourcePath),
  setFolderBackground: (dirPath: string, sourcePath: string): Promise<void> =>
    requireApi().setFolderBackground(dirPath, sourcePath),
  clearFolderThumbnail: (dirPath: string): Promise<void> =>
    requireApi().clearFolderThumbnail(dirPath),
  clearFolderBackground: (dirPath: string): Promise<void> =>
    requireApi().clearFolderBackground(dirPath),

  // Phase 4 — Extension system (viewers / editors / revisions)
  loadExtensionRegistry: (): Promise<ExtensionRegistry | null> =>
    requireApi().loadExtensionRegistry(),
  backupRevision: (filePath: string): Promise<void> =>
    requireApi().backupRevision(filePath),
  deleteRevision: (revisionPath: string): Promise<void> =>
    requireApi().deleteRevision(revisionPath),
  writeFileWithRevision: (
    filePath: string,
    content: string
  ): Promise<void> => requireApi().writeFileWithRevision(filePath, content),
  listRevisions: (filePath: string): Promise<RevisionInfo[]> =>
    requireApi().listRevisions(filePath),
  restoreRevision: (
    filePath: string,
    revisionPath: string
  ): Promise<void> => requireApi().restoreRevision(filePath, revisionPath),
  cleanupRevisions: (maxAgeDays: number): Promise<void> =>
    requireApi().cleanupRevisions(maxAgeDays),
  getPdfAsset: (kind: string, filename: string): Promise<ArrayBuffer> =>
    requireApi().getPdfAsset(kind, filename),
  getCadWasm: (): Promise<ArrayBuffer> => requireApi().getCadWasm(),
  getHeicWasm: (): Promise<ArrayBuffer> => requireApi().getHeicWasm(),
  convertOfficeToPdf: (
    filePath: string,
    options?: { sofficePath?: string | null }
  ): Promise<Uint8Array> => requireApi().convertOfficeToPdf(filePath, options),
  isSofficeAvailable: (): Promise<boolean> =>
    requireApi().isSofficeAvailable(),
  mapiqueGeocode: (
    query: string
  ): Promise<{ results: { name: string; lat: number; lng: number }[] }> =>
    requireApi().mapiqueGeocode(query),
  convertDwgToDxf: (
    filePath: string,
    options?: { dwg2dxfPath?: string | null; odaPath?: string | null }
  ): Promise<ArrayBuffer> => requireApi().convertDwgToDxf(filePath, options),
  detectDwgConverters: () => requireApi().detectDwgConverters(),
  convertEbookToEpub: (
    filePath: string,
    options?: { calibrePath?: string | null }
  ): Promise<ArrayBuffer> => requireApi().convertEbookToEpub(filePath, options),
  detectEbookConverter: (): Promise<{ calibre: string | null }> =>
    requireApi().detectEbookConverter(),

  // Phase 4b — Archive viewer main-process decoder
  listArchive: (
    filePath: string,
    options?: ListArchiveOptions
  ): Promise<ListArchiveResult> => requireApi().listArchive(filePath, options),
  readArchiveEntry: (
    filePath: string,
    entryPath: string,
    options?: ReadArchiveEntryOptions
  ): Promise<ReadArchiveEntryResult | null> => requireApi().readArchiveEntry(filePath, entryPath, options),
  extractArchive: (
    filePath: string,
    destDir: string,
    options?: ExtractArchiveOptions
  ): Promise<ExtractArchiveResult> => requireApi().extractArchive(filePath, destDir, options),

  saveImageDialog: (defaultPath: string): Promise<string | null> =>
    requireApi().saveImageDialog(defaultPath),
  writeBinaryFile: (filePath: string, base64: string): Promise<void> =>
    requireApi().writeBinaryFile(filePath, base64),
  captureRegion: (rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<string> => requireApi().captureRegion(rect),
  windowMinimize: (): Promise<void> => requireApi().windowMinimize(),
  windowMaximizeToggle: (): Promise<void> => requireApi().windowMaximizeToggle(),
  windowClose: (): Promise<void> => requireApi().windowClose(),
  windowIsMaximized: (): Promise<boolean> => requireApi().windowIsMaximized(),
  onWindowMaximizeChange: (
    callback: (maximized: boolean) => void
  ): (() => void) => requireApi().onWindowMaximizeChange(callback),
  startFileDrag: (filePath: string): void => requireApi().startFileDrag(filePath),

  // Phase 5 — AI assistant (streaming chunks arrive via onAiChunk).
  aiQuery: (payload: AiQueryPayload): Promise<{ ok: true }> =>
    requireApi().aiQuery(payload),
  aiCancel: (conversationId: string): Promise<{ ok: true }> =>
    requireApi().aiCancel(conversationId),
  aiPrewarm: (payload: AiQueryPayload): Promise<{ ok: true }> =>
    requireApi().aiPrewarm(payload),
  aiGenerateTitle: (
    args: {
      settings: AiQueryPayload['settings'];
      history: AiQueryPayload['history'];
    }
  ): Promise<{ title: string }> => requireApi().aiGenerateTitle(args),
  aiInlineEdit: (
    args: {
      settings: AiQueryPayload['settings'];
      selection: string;
      instruction: string;
    }
  ): Promise<{ replacement: string }> => requireApi().aiInlineEdit(args),
  aiSetApiKey: (key: string): Promise<{ ok: true }> =>
    requireApi().aiSetApiKey(key),
  aiClearApiKey: (): Promise<{ ok: true }> => requireApi().aiClearApiKey(),
  aiHasApiKey: (): Promise<boolean> => requireApi().aiHasApiKey(),
  aiDiscoverCli: (override: string | null): Promise<{ path: string | null }> =>
    requireApi().aiDiscoverCli(override),
  aiResolveApproval: (
    reqId: string,
    decision: ApprovalDecision
  ): Promise<{ ok: true }> => requireApi().aiResolveApproval(reqId, decision),
  aiSetOpenaiKey: (key: string): Promise<{ ok: true }> =>
    requireApi().aiSetOpenaiKey(key),
  aiClearOpenaiKey: (): Promise<{ ok: true }> => requireApi().aiClearOpenaiKey(),
  aiHasOpenaiKey: (): Promise<boolean> => requireApi().aiHasOpenaiKey(),
  aiGetComponentState: (): Promise<AiComponentState> =>
    requireApi().aiGetComponentState(),
  aiInstallComponent: (
    filePath: string
  ): Promise<AiComponentInstallResult> =>
    requireApi().aiInstallComponent(filePath),
  aiUninstallComponent: (): Promise<AiComponentUninstallResult> =>
    requireApi().aiUninstallComponent(),
  onAiApprovalRequest: (
    cb: (req: AiApprovalRequest) => void
  ): (() => void) => requireApi().onAiApprovalRequest(cb),
  onAiChunk: (
    cb: (e: { conversationId: string; chunk: StreamChunk }) => void
  ): (() => void) => requireApi().onAiChunk(cb),
  onAiError: (
    cb: (e: { conversationId: string; message: string }) => void
  ): (() => void) => requireApi().onAiError(cb),
};
