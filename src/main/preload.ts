import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { WhaleApi } from '../shared/ipc-types';
import type { SidecarMeta, FolderMeta } from '../shared/whale-meta';
import type { SearchQuery } from '../shared/search-query';
import type { ExtensionRegistry, RevisionInfo } from '../shared/extension-types';
import type {
  AiApprovalRequest,
  AiQueryPayload,
  ApprovalDecision,
  StreamChunk,
} from '../shared/ai-types';

/**
 * Preload bridge: the ONLY channel between the (untrusted) renderer and the
 * (privileged) main process. Runs with contextIsolation enabled, so the
 * renderer never touches Node/Electron directly — only the `window.whale`
 * surface defined here.
 *
 * Every method is a thin `ipcRenderer.invoke` over a channel handled in ipc.ts.
 */
const whaleApi: WhaleApi = {
  // Read / navigate
  homeDir: () => ipcRenderer.invoke('fs:homeDir'),
  parentDir: (dirPath: string) =>
    ipcRenderer.invoke('fs:parentDir', dirPath),
  listDirectory: (dirPath: string) =>
    ipcRenderer.invoke('fs:listDirectory', dirPath),
  listDirectoryRecursive: (dirPath: string, options?: { maxDepth?: number }) =>
    ipcRenderer.invoke('fs:listDirectoryRecursive', dirPath, options),
  readTextFile: (filePath: string) =>
    ipcRenderer.invoke('fs:readTextFile', filePath),
  readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
  pathExists: (targetPath: string) => ipcRenderer.invoke('fs:pathExists', targetPath),
  openDirectoryDialog: () => ipcRenderer.invoke('dialog:openDirectory'),
  openImageFileDialog: () => ipcRenderer.invoke('dialog:openImageFile'),
  openComponentFileDialog: () => ipcRenderer.invoke('dialog:openComponentFile'),

  // Lets the renderer register its configured location roots so the main
  // process can confine writes to them (defense-in-depth).
  setAllowedRoots: (roots: string[]) =>
    ipcRenderer.invoke('fs:setAllowedRoots', roots),

  // Mutations
  rename: (oldPath: string, newPath: string) =>
    ipcRenderer.invoke('fs:rename', oldPath, newPath),
  move: (oldPath: string, newPath: string) =>
    ipcRenderer.invoke('fs:move', oldPath, newPath),
  copy: (sourcePath: string, destPath: string) =>
    ipcRenderer.invoke('fs:copy', sourcePath, destPath),
  importExternal: (sources: string[], destDir: string) =>
    ipcRenderer.invoke('fs:importExternal', sources, destDir),
  // Resolve a dropped DOM File to its absolute filesystem path. Electron removed
  // File.path (≥32); webUtils.getPathForFile is the supported replacement and
  // must be called from the preload (it's not on the isolated window).
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  deletePath: (targetPath: string, useTrash?: boolean) =>
    ipcRenderer.invoke('fs:delete', targetPath, useTrash),
  createDirectory: (dirPath: string) =>
    ipcRenderer.invoke('fs:mkdir', dirPath),
  createTextFile: (filePath: string, content: string) =>
    ipcRenderer.invoke('fs:createTextFile', filePath, content),
  openNative: (targetPath: string) =>
    ipcRenderer.invoke('fs:openNative', targetPath),
  runCommand: (template: string, targetPath: string) =>
    ipcRenderer.invoke('shell:runCommand', template, targetPath),

  // Zip a folder into a sibling `<dir>.zip`; resolves with the archive path.
  zipDirectory: (dirPath: string) =>
    ipcRenderer.invoke('fs:zipDirectory', dirPath),

  // Zip a set of selected entries into a user-named archive.
  zipEntries: (paths: string[], zipPath: string) =>
    ipcRenderer.invoke('fs:zipEntries', paths, zipPath),

  // Opens the OS recycle bin / trash so the user can find deleted files.
  openTrash: () => ipcRenderer.invoke('shell:openTrash'),

  // Reveal a file/folder in the OS file manager.
  revealPath: (targetPath: string) =>
    ipcRenderer.invoke('shell:revealPath', targetPath),
  // H.23 P1-7: highlight the file inside its parent (Explorer/Finder/Nautilus).
  revealAndSelect: (targetPath: string) =>
    ipcRenderer.invoke('shell:revealAndSelect', targetPath),

  // EXIF / GPS extraction for the Mapique perspective.
  extractGps: (filePath: string) => ipcRenderer.invoke('exif:extractGps', filePath),
  // P3-7: popup EXIF summary (dateTaken / camera / lens / focalLength /
  // iso / shutterSpeed). Lazy — only fetched when the user opens a popup.
  getExifSummary: (filePath: string) =>
    ipcRenderer.invoke('exif:get-summary', filePath),
  // P3-4: EXIF extraction cache persisted in `index.db`.
  loadExifProcessed: (rootPath: string) =>
    ipcRenderer.invoke('exif:load-processed', rootPath),
  markExifProcessed: (rootPath: string, record: unknown) =>
    ipcRenderer.invoke('exif:mark-processed', rootPath, record),
  markExifProcessedMany: (rootPath: string, records: unknown) =>
    ipcRenderer.invoke('exif:mark-processed-many', rootPath, records),
  clearExifProcessed: (rootPath: string) =>
    ipcRenderer.invoke('exif:clear-processed', rootPath),

  // Index (SQLite — plan §6.6 P2)
  buildLocationIndex: (rootPath: string) =>
    ipcRenderer.invoke('index:build', rootPath),
  queryIndex: (rootPath: string, q: string) =>
    ipcRenderer.invoke('index:query', rootPath, q),
  advancedIndex: (rootPath: string, q: SearchQuery) =>
    ipcRenderer.invoke('index:advanced', rootPath, q),
  indexTags: (rootPath: string) =>
    ipcRenderer.invoke('index:tags', rootPath),
  indexStatus: (rootPath: string) =>
    ipcRenderer.invoke('index:status', rootPath),

  // Full-text index
  buildFulltextIndex: (rootPath: string) =>
    ipcRenderer.invoke('fulltext:build', rootPath),
  searchFulltext: (rootPath: string, query: string) =>
    ipcRenderer.invoke('fulltext:search', rootPath, query),
  hasFulltextIndex: (rootPath: string) =>
    ipcRenderer.invoke('fulltext:has', rootPath),

  // Sidecar metadata
  readSidecars: (dirPath: string, names: string[]) =>
    ipcRenderer.invoke('sidecar:readMany', dirPath, names),
  readSidecardsForPaths: (filePaths: string[]) =>
    ipcRenderer.invoke('sidecar:readForPaths', filePaths),
  writeSidecar: (filePath: string, meta: SidecarMeta) =>
    ipcRenderer.invoke('sidecar:write', filePath, meta),

  // Folder metadata
  readFolderMeta: (dirPath: string) =>
    ipcRenderer.invoke('folderMeta:read', dirPath),
  writeFolderMeta: (dirPath: string, patch: Partial<FolderMeta>) =>
    ipcRenderer.invoke('folderMeta:write', dirPath, patch),

  // Per-location tag library (`.whale/wtaglib.json`)
  readTagLibrary: (locationRoot: string) =>
    ipcRenderer.invoke('tagLibrary:read', locationRoot),
  setTagLibraryDescription: (
    locationRoot: string,
    tag: string,
    description: string
  ) =>
    ipcRenderer.invoke(
      'tagLibrary:setDescription',
      locationRoot,
      tag,
      description
    ),
  clearTagLibraryDescription: (locationRoot: string, tag: string) =>
    ipcRenderer.invoke('tagLibrary:clearDescription', locationRoot, tag),

  // Ebook-viewer annotation persistence (`.whale/ebook-annotations/<basename>.json`)
  readEbookAnnotations: (filePath: string) =>
    ipcRenderer.invoke('ebookAnnotations:read', filePath),
  writeEbookAnnotations: (filePath: string, payload: unknown) =>
    ipcRenderer.invoke('ebookAnnotations:write', filePath, payload),

  // Image thumbnails
  generateThumbnail: (filePath: string, options?: { sofficePath?: string | null }) =>
    ipcRenderer.invoke('thumbnail:generate', filePath, options),
  loadThumbnail: (filePath: string) =>
    ipcRenderer.invoke('thumbnail:load', filePath),

  // Folder thumbnails / backgrounds
  loadFolderThumbnail: (dirPath: string) =>
    ipcRenderer.invoke('thumbnail:loadFolder', dirPath),
  loadFolderBackground: (dirPath: string) =>
    ipcRenderer.invoke('thumbnail:loadFolderBackground', dirPath),
  setFolderThumbnail: (dirPath: string, sourcePath: string) =>
    ipcRenderer.invoke('thumbnail:setFolderThumbnail', dirPath, sourcePath),
  setFolderBackground: (dirPath: string, sourcePath: string) =>
    ipcRenderer.invoke('thumbnail:setFolderBackground', dirPath, sourcePath),
  clearFolderThumbnail: (dirPath: string) =>
    ipcRenderer.invoke('thumbnail:clearFolderThumbnail', dirPath),
  clearFolderBackground: (dirPath: string) =>
    ipcRenderer.invoke('thumbnail:clearFolderBackground', dirPath),

  // Phase 4 — Extension system (viewers / editors / revisions)
  loadExtensionRegistry: () =>
    ipcRenderer.invoke('ext:loadRegistry') as Promise<ExtensionRegistry | null>,
  backupRevision: (filePath: string) =>
    ipcRenderer.invoke('ext:backupRevision', filePath),
  deleteRevision: (revisionPath: string) =>
    ipcRenderer.invoke('ext:deleteRevision', revisionPath),
  writeFileWithRevision: (filePath: string, content: string) =>
    ipcRenderer.invoke('ext:writeFile', filePath, content),
  listRevisions: (filePath: string) =>
    ipcRenderer.invoke('ext:listRevisions', filePath) as Promise<RevisionInfo[]>,
  restoreRevision: (filePath: string, revisionPath: string) =>
    ipcRenderer.invoke('ext:restoreRevision', filePath, revisionPath),
  cleanupRevisions: (maxAgeDays: number) =>
    ipcRenderer.invoke('ext:cleanupRevisions', maxAgeDays),
  getPdfAsset: (kind: string, filename: string) =>
    ipcRenderer.invoke('ext:getPdfAsset', kind, filename),
  getCadWasm: () => ipcRenderer.invoke('ext:getCadWasm'),
  getHeicWasm: () => ipcRenderer.invoke('ext:getHeicWasm'),
  convertOfficeToPdf: (
    filePath: string,
    options?: { sofficePath?: string | null }
  ) => ipcRenderer.invoke('ext:convertOfficeToPdf', filePath, options),
  convertDwgToDxf: (
    filePath: string,
    options?: { dwg2dxfPath?: string | null; odaPath?: string | null }
  ) => ipcRenderer.invoke('ext:convertDwgToDxf', filePath, options),
  detectDwgConverters: () =>
    ipcRenderer.invoke('ext:detectDwgConverters') as Promise<{
      dwg2dxf: string | null;
      oda: string | null;
    }>,
  convertEbookToEpub: (
    filePath: string,
    options?: { calibrePath?: string | null }
  ) => ipcRenderer.invoke('ext:convertEbookToEpub', filePath, options),
  detectEbookConverter: () =>
    ipcRenderer.invoke('ext:detectEbookConverter') as Promise<{
      calibre: string | null;
    }>,
  isSofficeAvailable: () =>
    ipcRenderer.invoke('ext:isSofficeAvailable') as Promise<boolean>,
  mapiqueGeocode: (query: string) =>
    ipcRenderer.invoke('mapique:geocode', query) as Promise<{
      results: { name: string; lat: number; lng: number }[];
    }>,

  // Phase 4b — Archive viewer main-process decoder
  listArchive: (filePath: string, options?) =>
    ipcRenderer.invoke('archive:listArchive', filePath, options),
  readArchiveEntry: (filePath: string, entryPath: string, options?) =>
    ipcRenderer.invoke('archive:readEntry', filePath, entryPath, options),
  extractArchive: (filePath: string, destDir: string, options?) =>
    ipcRenderer.invoke('archive:extract', filePath, destDir, options),

  saveImageDialog: (defaultPath: string) =>
    ipcRenderer.invoke('dialog:saveImage', defaultPath),
  writeBinaryFile: (filePath: string, base64: string) =>
    ipcRenderer.invoke('fs:writeBinaryFile', filePath, base64),
  captureRegion: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('window:captureRegion', rect),
  // Frameless title-bar window controls.
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximizeToggle: () => ipcRenderer.invoke('window:maximizeToggle'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onWindowMaximizeChange: (
    callback: (maximized: boolean) => void
  ): (() => void) => {
    const listener = (_event: unknown, maximized: boolean): void =>
      callback(maximized);
    ipcRenderer.on('window:maximizeChange', listener);
    return () => ipcRenderer.off('window:maximizeChange', listener);
  },
  startFileDrag: (filePath: string) =>
    ipcRenderer.send('drag:startFile', filePath),

  // Phase 5 — AI assistant (Claude Code CLI, embedded in main).
  //
  // Streaming is the one place Whale pushes main→renderer: `aiQuery` returns
  // immediately and the turn's StreamChunks arrive via the `onAiChunk`
  // subscription. Each subscription returns an unsubscribe function and is
  // scoped to a fixed `ai:*` channel — the bridge is NOT generalized.
  aiQuery: (payload: AiQueryPayload) =>
    ipcRenderer.invoke('ai:query', payload),
  aiCancel: (conversationId: string) =>
    ipcRenderer.invoke('ai:cancel', conversationId),
  aiPrewarm: (payload: AiQueryPayload) =>
    ipcRenderer.invoke('ai:prewarm', payload),
  aiGenerateTitle: (
    args: {
      settings: AiQueryPayload['settings'];
      history: AiQueryPayload['history'];
    }
  ) => ipcRenderer.invoke('ai:generateTitle', args),
  aiInlineEdit: (
    args: {
      settings: AiQueryPayload['settings'];
      selection: string;
      instruction: string;
    }
  ) => ipcRenderer.invoke('ai:inlineEdit', args),
  aiSetApiKey: (key: string) => ipcRenderer.invoke('ai:setApiKey', key),
  aiClearApiKey: () => ipcRenderer.invoke('ai:clearApiKey'),
  aiHasApiKey: () => ipcRenderer.invoke('ai:hasApiKey'),
  aiDiscoverCli: (override: string | null) =>
    ipcRenderer.invoke('ai:discoverCli', override),
  aiResolveApproval: (reqId: string, decision: ApprovalDecision) =>
    ipcRenderer.invoke('ai:resolveApproval', { reqId, decision }),
  aiSetOpenaiKey: (key: string) =>
    ipcRenderer.invoke('ai:setOpenaiKey', key),
  aiClearOpenaiKey: () => ipcRenderer.invoke('ai:clearOpenaiKey'),
  aiHasOpenaiKey: () => ipcRenderer.invoke('ai:hasOpenaiKey'),
  aiGetComponentState: () => ipcRenderer.invoke('ai:getComponentState'),
  aiInstallComponent: (filePath: string) =>
    ipcRenderer.invoke('ai:installComponent', filePath),
  aiUninstallComponent: () => ipcRenderer.invoke('ai:uninstallComponent'),
  onAiChunk: (
    cb: (e: { conversationId: string; chunk: StreamChunk }) => void
  ) => {
    const listener = (
      _e: unknown,
      payload: { conversationId: string; chunk: StreamChunk }
    ): void => cb(payload);
    ipcRenderer.on('ai:chunk', listener);
    return () => ipcRenderer.off('ai:chunk', listener);
  },
  onAiError: (
    cb: (e: { conversationId: string; message: string }) => void
  ) => {
    const listener = (
      _e: unknown,
      payload: { conversationId: string; message: string }
    ): void => cb(payload);
    ipcRenderer.on('ai:error', listener);
    return () => ipcRenderer.off('ai:error', listener);
  },
  onAiApprovalRequest: (cb: (req: AiApprovalRequest) => void) => {
    const listener = (_e: unknown, payload: AiApprovalRequest): void =>
      cb(payload);
    ipcRenderer.on('ai:approvalRequest', listener);
    return () => ipcRenderer.off('ai:approvalRequest', listener);
  },

  // Lifecycle: let the renderer flush redux-persist before the window closes.
  onBeforeUnloadFlush: (cb: () => void | Promise<void>) => {
    const listener = (): void => void cb();
    ipcRenderer.on('app:request-flush', listener);
    return () => ipcRenderer.off('app:request-flush', listener);
  },
  flushComplete: () => ipcRenderer.send('app:flush-complete'),
  requestQuit: () => ipcRenderer.send('app:request-quit'),

  // Redux-persist storage backed by synchronous main-process file IO.
  persistRead: (key: string) => ipcRenderer.invoke('persist:read', key),
  persistWrite: (key: string, value: string) =>
    ipcRenderer.invoke('persist:write', key, value),
  persistDelete: (key: string) =>
    ipcRenderer.invoke('persist:delete', key),
  persistReadSync: (key: string) =>
    ipcRenderer.sendSync('persist:readSync', key),
  persistWriteSync: (key: string, value: string) =>
    ipcRenderer.sendSync('persist:writeSync', key, value),
  persistDeleteSync: (key: string) =>
    ipcRenderer.sendSync('persist:deleteSync', key),
};

contextBridge.exposeInMainWorld('whale', whaleApi);

export type WhaleGlobal = typeof whaleApi;
