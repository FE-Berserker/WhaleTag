import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  WhaleApi,
  AppUpdateAvailablePayload,
  AppUpdateProgressPayload,
  AppUpdateInfoPayload,
  IndexProgressEvent,
  DirChangedEvent,
} from '../shared/ipc-types';

/** Payloads the main process pushes per update channel — mirrors the
 *  `onAppUpdateEvent` callback contract in `WhaleApi` so the preload bridge
 *  stays in lockstep with the interface. */
type AppUpdateEventPayload =
  | AppUpdateAvailablePayload
  | AppUpdateProgressPayload
  | AppUpdateInfoPayload
  | string;
import type { SidecarMeta, FolderMeta } from '../shared/whale-meta';
import type { SearchQuery } from '../shared/search-query';
import type { McpApprovalRequest } from '../shared/mcp-types';
import type {
  ExtensionRegistry,
  RevisionInfo,
} from '../shared/extension-types';

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
  syncFulltextPaths: (paths: string[]) =>
    ipcRenderer.invoke('fulltext:syncPaths', paths),

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

  // Image thumbnails
  generateThumbnail: (filePath: string) =>
    ipcRenderer.invoke('thumbnail:generate', filePath),
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
  deleteRevision: (filePath: string, revisionPath: string) =>
    ipcRenderer.invoke('ext:deleteRevision', filePath, revisionPath),
  writeFileWithRevision: (filePath: string, content: string) =>
    ipcRenderer.invoke('ext:writeFile', filePath, content),
  listRevisions: (filePath: string) =>
    ipcRenderer.invoke('ext:listRevisions', filePath) as Promise<RevisionInfo[]>,
  restoreRevision: (filePath: string, revisionPath: string) =>
    ipcRenderer.invoke('ext:restoreRevision', filePath, revisionPath),
  cleanupRevisions: (maxAgeDays: number) =>
    ipcRenderer.invoke('ext:cleanupRevisions', maxAgeDays),
  getHeicWasm: () => ipcRenderer.invoke('ext:getHeicWasm'),

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

  // Local MCP server (docs/21) — status polling + approval decisions.
  mcpGetStatus: () => ipcRenderer.invoke('mcp:getStatus'),
  mcpSetEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('mcp:setEnabled', enabled),
  mcpSetReadOnly: (readOnly: boolean) =>
    ipcRenderer.invoke('mcp:setReadOnly', readOnly),
  mcpRegenerateToken: () => ipcRenderer.invoke('mcp:regenerateToken'),
  mcpResolveApproval: (reqId: string, allowed: boolean) =>
    ipcRenderer.invoke('mcp:resolveApproval', reqId, allowed),
  mcpPendingApprovals: () => ipcRenderer.invoke('mcp:pendingApprovals'),
  onMcpApprovalRequest: (cb: (req: McpApprovalRequest) => void) => {
    const listener = (_e: unknown, payload: McpApprovalRequest): void =>
      cb(payload);
    ipcRenderer.on('mcp:approvalRequest', listener);
    return () => ipcRenderer.off('mcp:approvalRequest', listener);
  },

  onIndexProgress: (cb: (ev: IndexProgressEvent) => void) => {
    const listener = (_e: unknown, payload: IndexProgressEvent): void =>
      cb(payload);
    ipcRenderer.on('index:progress', listener);
    return () => ipcRenderer.off('index:progress', listener);
  },
  onDirChanged: (cb: (ev: DirChangedEvent) => void) => {
    const listener = (_e: unknown, payload: DirChangedEvent): void =>
      cb(payload);
    ipcRenderer.on('fs:dirChanged', listener);
    return () => ipcRenderer.off('fs:dirChanged', listener);
  },

  // Lifecycle: let the renderer flush redux-persist before the window closes.
  onBeforeUnloadFlush: (cb: () => void | Promise<void>) => {
    const listener = (): void => void cb();
    ipcRenderer.on('app:request-flush', listener);
    return () => ipcRenderer.off('app:request-flush', listener);
  },
  flushComplete: () => ipcRenderer.send('app:flush-complete'),
  requestQuit: () => ipcRenderer.send('app:request-quit'),

  // Redux-persist storage backed by main-process JSON file IO (async invoke).
  persistRead: (key: string) => ipcRenderer.invoke('persist:read', key),
  persistWrite: (key: string, value: string) =>
    ipcRenderer.invoke('persist:write', key, value),
  persistDelete: (key: string) =>
    ipcRenderer.invoke('persist:delete', key),

  // Application auto-update (electron-updater + GitHub Releases). The
  // main-side state machine lives in `auto-update.ts`; preload is a thin
  // bridge to the IPC channels declared in the `WhaleApi` interface.
  appGetVersion: () => ipcRenderer.invoke('app:getVersion'),
  appCheckForUpdates: () => ipcRenderer.invoke('app:update-check'),
  appDownloadUpdate: () => ipcRenderer.invoke('app:update-download'),
  appQuitAndInstall: () => ipcRenderer.send('app:update-quit-and-install'),
  onAppUpdateEvent: (
    channel: 'available' | 'progress' | 'downloaded' | 'error',
    callback: (data: AppUpdateEventPayload) => void
  ) => {
    const wireChannel = `app:update-${channel}`;
    const listener = (_e: unknown, payload: unknown): void =>
      callback(payload as AppUpdateEventPayload);
    ipcRenderer.on(wireChannel, listener);
    return () => ipcRenderer.off(wireChannel, listener);
  },
};

contextBridge.exposeInMainWorld('whale', whaleApi);

export type WhaleGlobal = typeof whaleApi;
