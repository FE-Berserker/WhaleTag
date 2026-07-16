import path from 'path';
import os from 'os';
import { existsSync, promises as fsp } from 'fs';
import { ipcMain, dialog, shell, nativeImage, BrowserWindow, app } from 'electron';
import { exec, execFile } from 'child_process';
import { DirEntry } from '../shared/ipc-types';
import { nextAvailableName } from '../shared/dedupe-name';
// P0-2: the SQLite / FTS5 / EXIF pipeline (formerly imported from
// ./indexer, ./index-db, ./fulltext) now runs in a utilityProcess. The
// 11 channels below forward each request to the worker via `request()`
// — the renderer-facing API (channel names, request/response shapes) is
// unchanged.
import { request } from './index-worker-host';
import type { SearchQuery } from '../shared/search-query';
import { readSidecars, readSidecardsForPaths, writeSidecar, removeSidecar, moveSidecar, copySidecar } from './sidecar';
import { readFolderMeta, writeFolderMeta } from './folder-meta';
import {
  readTagLibrary,
  setTagLibraryDescription,
  clearTagLibraryDescription,
} from './tag-library';
import { readEbookAnnotations, writeEbookAnnotations } from './ebook-annotations';
import {
  generateThumbnail,
  loadThumbnail,
  removeThumbnail,
  moveThumbnail,
  copyThumbnail,
  loadFolderThumbnail,
  loadFolderBackground,
  setFolderThumbnail,
  setFolderBackground,
  clearFolderThumbnail,
  clearFolderBackground,
} from './thumbnail';
import { mapWithConcurrency } from './concurrency';
import { extractGps, getExifSummary } from './exif';
import { getCanvas, getChardet, getIconv } from './lazy-native';
import type { SidecarMeta } from '../shared/whale-meta';
import type { FolderMeta } from '../shared/whale-meta';
import { assertWithinAllowedRoot, setAllowedRoots, getAllowedRoots } from './allowed-roots';
import {
  backupRevision,
  backupRevisionBinary,
  listRevisions,
  restoreRevision,
  cleanupRevisionsForLocation,
  deleteRevision,
} from './revisions';
import { atomicWriteText, atomicWriteBytes } from './atomic-write';
import { persistRead, persistWrite, persistDelete } from './persist-storage';
import {
  loadOfficePdf,
  removeOfficePdf,
  moveOfficePdf,
  copyOfficePdf,
} from './office-cache';
import { isSofficeAvailable } from './office-convert';
import { geocodeNominatim } from './geocode';
import { loadRecursiveScan, invalidateRecursiveScan } from './recursive-cache';
import { convertDwgToDxf, dwg2dxfBinary, odaConverterBinary } from './cad-convert';
import { convertEbookToEpub, ebookConvertBinary } from './ebook-convert';
import { runUserCommand } from './shell-command';
import {
  listArchive,
  readArchiveEntry,
  extractArchive,
} from './archive';
import {
  removeTranscode,
  moveTranscode,
  copyTranscode,
} from './transcode-cache';
import type { ExtensionRegistry } from '../shared/extension-types';
import { createRequire } from 'module';

/** Names of entries that are never useful to show in a file browser. */
const HIDDEN = new Set(['.DS_Store', 'Thumbs.db', 'ehthumbs.db']);

/** Cached generic "document" drag icon (Electron's startDrag rejects an empty or
 *  tiny icon, so non-previewable files need a real one). Built once on demand. */
let dragFallbackIcon: Electron.NativeImage | null = null;
function getDragFallbackIcon(): Electron.NativeImage {
  if (dragFallbackIcon) return dragFallbackIcon;
  const c = getCanvas().createCanvas(64, 64);
  const g = c.getContext('2d');
  g.fillStyle = '#eef0f5';
  g.fillRect(12, 6, 40, 52);
  g.strokeStyle = '#9aa0b4';
  g.lineWidth = 2;
  g.strokeRect(12, 6, 40, 52);
  g.fillStyle = '#c5cad8';
  g.beginPath();
  g.moveTo(40, 6);
  g.lineTo(52, 18);
  g.lineTo(40, 18);
  g.closePath();
  g.fill();
  dragFallbackIcon = nativeImage.createFromBuffer(c.toBuffer('image/png'));
  return dragFallbackIcon;
}

function entryFromName(dirPath: string, name: string): DirEntry {
  const fullPath = path.join(dirPath, name);
  return {
    name,
    path: fullPath,
    isDirectory: false,
    isFile: true,
    size: 0,
    modified: '',
    extension: name.includes('.')
      ? name.slice(name.lastIndexOf('.') + 1).toLowerCase()
      : '',
  };
}

/**
 * Stats one directory entry (falling back to lstat for broken symlinks).
 * Returns null when the entry can't be read at all, so the caller can skip it.
 */
async function buildEntry(dirPath: string, name: string): Promise<DirEntry | null> {
  const entry = entryFromName(dirPath, name);
  try {
    const stat = await fsp.stat(entry.path);
    entry.isDirectory = stat.isDirectory();
    entry.isFile = stat.isFile();
    entry.size = stat.isFile() ? stat.size : 0;
    entry.modified = stat.mtime.toISOString();
    if (entry.isDirectory) entry.extension = '';
  } catch {
    // Broken symlink / unreadable entry: fall back to lstat, skip if still bad.
    try {
      const lstat = await fsp.lstat(entry.path);
      entry.isDirectory = lstat.isDirectory();
      entry.isFile = lstat.isFile();
    } catch {
      return null;
    }
  }
  return entry;
}

/** Resolves metadata for every direct child of `dirPath`. */
async function listDirectory(dirPath: string): Promise<DirEntry[]> {
  const names = (await fsp.readdir(dirPath)).filter((n) => !HIDDEN.has(n));
  // Stat entries with bounded concurrency — a 10k-file directory would
  // otherwise fan out 10k simultaneous stat syscalls.
  const entries = await mapWithConcurrency(names, 16, (name) =>
    buildEntry(dirPath, name)
  );
  const results = entries.filter((e): e is DirEntry => e !== null);

  // Folders first, then files, both alphabetical (case-insensitive).
  results.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return results;
}

/**
 * Recursively lists entries under `dirPath` up to `remainingDepth` levels deep.
 * The metadata folder `.whale` is excluded. Returns a flat list of DirEntry
 * objects with absolute paths, suitable for building a visualization tree.
 */
/**
 * Hard cap on the number of entries a single recursive scan returns. Mirrors
 * `MAX_RECURSIVE_ENTRIES` in `src/shared/recursive-entries.ts` — kept local
 * here because importing the shared module would pull renderer-only deps
 * (`extractTags` via `-/services/tags`) into the main bundle. When a scan
 * overflows, the renderer surfaces `<ErrorBanner>` (i18n
 * `recursiveEntriesTruncated`). Plan §H.24 R7: the cap is enforced on the
 * main side so a pathological tree (e.g. a 5-deep `node_modules`) can never
 * push a 100k-entry IPC payload that freezes the renderer.
 */
const MAX_RECURSIVE_ENTRIES = 10000;

async function listDirectoryRecursive(
  dirPath: string,
  remainingDepth: number,
  // Remaining entry budget for this subtree; the top-level caller uses the
  // full cap and each recursion spends what it collected so a runaway branch
  // is bounded by the original limit, not by per-call limits.
  cap = MAX_RECURSIVE_ENTRIES
): Promise<DirEntry[]> {
  const direct = (await listDirectory(dirPath)).filter(
    (e) => e.name !== '.whale'
  );
  if (direct.length >= cap) return direct.slice(0, cap);
  const all: DirEntry[] = [...direct];
  if (remainingDepth <= 1) return all;

  const dirs = direct.filter((e) => e.isDirectory);
  const nested = await mapWithConcurrency(dirs, 16, (d) =>
    listDirectoryRecursive(d.path, remainingDepth - 1, cap - all.length)
  );
  for (const children of nested) {
    all.push(...children);
    if (all.length >= cap) return all.slice(0, cap);
  }
  return all;
}

/** Reads a text file and returns it as UTF-8, auto-detecting non-UTF-8 encodings. */
async function readTextFile(filePath: string): Promise<string> {
  const buf = await fsp.readFile(filePath);

  // UTF-8 BOM: strip the marker and decode the remainder as UTF-8.
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf8', 3);
  }

  const utf8 = buf.toString('utf8');
  // chardet only needs a small byte sample to identify an encoding; running
  // it over a multi-MB buffer is wasted main-thread CPU. subarray is a
  // zero-copy view, so this is cheap.
  const CHARDET_SAMPLE = 256 * 1024;
  const detected = getChardet().detect(
    buf.length > CHARDET_SAMPLE ? buf.subarray(0, CHARDET_SAMPLE) : buf
  );
  const encoding = detected?.encoding?.toLowerCase() ?? 'utf8';
  const confidence = detected?.confidence ?? 0;

  // High-confidence UTF-8 / ASCII -> decode as UTF-8.
  if ((encoding === 'utf-8' || encoding === 'ascii') && confidence >= 0.8) {
    return utf8;
  }

  // Very low confidence usually means the sample is too short or ambiguous;
  // modern files are overwhelmingly UTF-8, so prefer that default.
  if (confidence < 0.3) {
    return utf8;
  }

  // Decode with the detected encoding. jschardet may report ASCII for files
  // that are mostly ASCII with a few non-UTF-8 bytes (common for older Chinese
  // Windows text), so keep the detected name as the iconv target unless it is
  // clearly a UTF-8 alias.
  const target = encoding === 'utf-8' || encoding === 'ascii' ? 'utf8' : encoding;
  const decoded = getIconv().decode(buf, target);

  // A legacy-encoded file may contain a handful of invalid bytes (e.g. a
  // corrupted download or mixed-encoding ebook). Forcing UTF-8 in that case
  // produces *millions* of replacement characters, so we pick whichever
  // decoding yields fewer replacements.
  // Count U+FFFD WITHOUT `s.match(/�/g)` — that builds a giant array
  // (millions of entries) when a legacy/mixed-encoding file has many invalid
  // bytes. indexOf walks the string with no allocation.
  const countReplacements = (s: string): number => {
    let count = 0;
    let idx = s.indexOf('�');
    while (idx !== -1) {
      count++;
      idx = s.indexOf('�', idx + 1);
    }
    return count;
  };
  const utf8Bad = countReplacements(utf8);
  const decodedBad = countReplacements(decoded);

  return decodedBad <= utf8Bad ? decoded : utf8;
}

/** Creates a directory (idempotent: no error if it already exists). */
async function createDirectory(dirPath: string): Promise<void> {
  assertWithinAllowedRoot(dirPath);
  await fsp.mkdir(dirPath, { recursive: true });
  // A new subfolder changes its ancestors' recursive listings — invalidate
  // them (best-effort, mirrors the cache cleanup in the other fs handlers).
  await invalidateRecursiveScan(dirPath).catch(() => undefined);
}

/**
 * Creates a UTF-8 text file. Rejects if it already exists — never silently
 * clobber an existing file (data-safety).
 */
async function createTextFile(filePath: string, content: string): Promise<void> {
  assertWithinAllowedRoot(filePath);
  if (existsSync(filePath)) {
    throw new Error(`File already exists: ${filePath}`);
  }
  await fsp.writeFile(filePath, content, 'utf8');
}

/** Writes a base64-encoded file (e.g. exported chart image) to disk. */
async function writeBinaryFile(filePath: string, base64: string): Promise<void> {
  assertWithinAllowedRoot(filePath);
  await atomicWriteBytes(filePath, Buffer.from(base64, 'base64'));
}

/**
 * Deletes a file or directory tree.
 *
 * - `useTrash=true` (default): moves to the system trash via shell.trashItem —
 *   recoverable. A path that no longer exists is treated as already-deleted
 *   (success) so the renderer's optimistic UI never reports a failure for
 *   something already gone. If trashing fails we RE-THROW rather than silently
 *   escalating to a permanent delete: the user asked for recoverable removal,
 *   and destroying data behind their back is worse than surfacing the error.
 * - `useTrash=false`: permanent `rm` (force:false → a missing path rejects).
 *
 * Either way the entry's sidecar is removed best-effort — sidecars are
 * app-internal metadata, not user data, so they need not be recoverable.
 */
async function deletePath(targetPath: string, useTrash = true): Promise<void> {
  assertWithinAllowedRoot(targetPath);
  // App-internal metadata (sidecar entry + thumbnail) is removed best-effort —
  // it need not be recoverable the way user data is.
  const cleanupMeta = () =>
    Promise.all([
      removeSidecar(targetPath).catch(() => undefined),
      removeThumbnail(targetPath).catch(() => undefined),
      removeTranscode(targetPath).catch(() => undefined),
      removeOfficePdf(targetPath).catch(() => undefined),
      invalidateRecursiveScan(targetPath).catch(() => undefined),
    ]);

  if (useTrash) {
    if (!existsSync(targetPath)) {
      await cleanupMeta(); // already gone — nothing to trash
      return;
    }
    await shell.trashItem(targetPath); // re-throws on failure — no silent hard-delete
    await cleanupMeta();
    return;
  }

  await fsp.rm(targetPath, { recursive: true, force: false });
  await cleanupMeta();
}

/** Opens a file/folder with the OS default handler. Rejects on OS error. */
async function openNative(targetPath: string): Promise<void> {
  const errorMessage = await shell.openPath(targetPath);
  if (errorMessage) {
    throw new Error(errorMessage);
  }
}

/**
 * Picks a non-colliding archive path for `dirPath`: `<dir>.zip`, then
 * `<dir> (1).zip`, `<dir> (2).zip`, … — so packaging never clobbers an existing
 * file (data-safety, consistent with the never-overwrite rule elsewhere).
 */
function freeZipPath(dirPath: string): string {
  const base = `${dirPath}.zip`;
  if (!existsSync(base)) return base;
  for (let i = 1; ; i += 1) {
    const candidate = `${dirPath} (${i}).zip`;
    if (!existsSync(candidate)) return candidate;
  }
}

/**
 * Runs the OS's built-in zip tool (no bundled dependency): PowerShell's
 * Compress-Archive on Windows, the `zip` CLI elsewhere. `sources` are absolute
 * paths to files/folders that share one parent directory (the selection always
 * comes from a single folder); they're stored in the archive by their leaf
 * names. Resolves once the archive exists; rejects (surfacing stderr) otherwise.
 */
function runOsZip(sources: string[], zipPath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const done = (err: Error | null) => {
      if (err) return reject(err);
      if (!existsSync(zipPath)) {
        return reject(new Error('Archive was not created'));
      }
      resolve(zipPath);
    };

    if (process.platform === 'win32') {
      // -LiteralPath: treat names verbatim (no wildcard globbing). Single quotes
      // are PowerShell string delimiters; escape by doubling. Multiple sources
      // are passed as a comma-separated list.
      const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
      const literal = sources.map(psQuote).join(',');
      const command = `Compress-Archive -LiteralPath ${literal} -DestinationPath ${psQuote(
        zipPath
      )}`;
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        (err) => done(err)
      );
    } else {
      // `zip -r` from the shared parent so entries are stored by relative name
      // (extract back to the same folder layout, not loose/absolute paths).
      execFile(
        'zip',
        ['-r', '-q', zipPath, ...sources.map((s) => path.basename(s))],
        { cwd: path.dirname(sources[0]) },
        (err) => done(err)
      );
    }
  });
}

/**
 * Zips a single directory into a sibling archive (auto-named to avoid clobber).
 * The SOURCE must sit inside a configured location; the archive itself is
 * treated like a move/copy destination (exempt), so packaging a location root —
 * whose sibling lives one level up — still works. Resolves with the archive path.
 */
function zipDirectory(dirPath: string): Promise<string> {
  assertWithinAllowedRoot(dirPath);
  return runOsZip([dirPath], freeZipPath(dirPath));
}

/**
 * Zips an explicit set of entries (the file-list multi-selection) into a
 * user-named `zipPath`. Sources are confined to configured locations; the
 * destination is rejected if it already exists (the user chose the name, so a
 * collision is surfaced rather than silently suffixed or clobbered).
 */
function zipEntries(paths: string[], zipPath: string): Promise<string> {
  if (!paths.length) throw new Error('Nothing selected to package');
  for (const p of paths) assertWithinAllowedRoot(p);
  if (existsSync(zipPath)) {
    throw new Error(`A file already exists at: ${zipPath}`);
  }
  return runOsZip(paths, zipPath);
}

/** Shows the native "select folder" dialog. Returns null if cancelled. */
async function openDirectoryDialog(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

/** Shows the native "select image file" dialog. Returns null if cancelled. */
async function openImageFileDialog(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

/** Shows the native "select AI component (.whaleai)" dialog. Returns null if cancelled. */
async function openComponentFileDialog(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'WhaleTag AI Component', extensions: ['whaleai'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

/**
 * Wires every `fs:*` / `dialog:*` channel to its handler.
 * Called once from main.ts after the app is ready.
 *
 * IMPORTANT (file-manager mindset): mutation handlers reject on failure so the
 * renderer can surface an error and suppress optimistic UI updates. Never
 * resolve a failed IO with a success sentinel.
 */
export function registerIpcHandlers(): void {
  ipcMain.handle('fs:homeDir', () => os.homedir());

  ipcMain.handle('fs:parentDir', (_event, dirPath: string) =>
    path.dirname(dirPath)
  );

  ipcMain.handle('fs:listDirectory', (_event, dirPath: string) =>
    listDirectory(dirPath)
  );

  ipcMain.handle(
    'fs:listDirectoryRecursive',
    (_event, dirPath: string, options?: { maxDepth?: number }) =>
      loadRecursiveScan(dirPath, options?.maxDepth ?? 3, listDirectoryRecursive)
  );

  ipcMain.handle('fs:readTextFile', (_event, filePath: string) =>
    readTextFile(filePath)
  );

  ipcMain.handle('fs:readFile', (_event, filePath: string) => fsp.readFile(filePath));

  ipcMain.handle('fs:pathExists', (_event, targetPath: string) =>
    existsSync(targetPath)
  );

  // The renderer syncs its configured locations here so write handlers can
  // confine mutations to those roots (see assertWithinAllowedRoot).
  ipcMain.handle('fs:setAllowedRoots', (_event, roots: string[]) => {
    setAllowedRoots(roots);
  });

  ipcMain.handle('dialog:openDirectory', () => openDirectoryDialog());
  ipcMain.handle('dialog:openImageFile', () => openImageFileDialog());
  ipcMain.handle('dialog:openComponentFile', () => openComponentFileDialog());

  ipcMain.handle(
    'fs:rename',
    (_event, oldPath: string, newPath: string) => rename(oldPath, newPath)
  );
  async function rename(oldPath: string, newPath: string): Promise<void> {
    assertWithinAllowedRoot(oldPath);
    assertWithinAllowedRoot(newPath);
    // Avoid silently overwriting an existing destination.
    if (existsSync(newPath)) {
      throw new Error(`A file already exists at: ${newPath}`);
    }
    await fsp.rename(oldPath, newPath);
    // Keep the sidecar in sync with the rename/move (best-effort: never fails
    // the rename itself if the sidecar can't be moved).
    try {
      await Promise.all([
        moveSidecar(oldPath, newPath),
        moveThumbnail(oldPath, newPath),
        moveTranscode(oldPath, newPath),
        moveOfficePdf(oldPath, newPath),
        invalidateRecursiveScan(oldPath),
        invalidateRecursiveScan(newPath),
      ]);
    } catch {
      // file rename already succeeded; metadata sync is non-critical
    }
  }

  ipcMain.handle(
    'fs:move',
    (_event, oldPath: string, newPath: string) => move(oldPath, newPath)
  );
  async function move(oldPath: string, newPath: string): Promise<void> {
    assertWithinAllowedRoot(oldPath); // destination may be any folder the user picked
    if (existsSync(newPath)) {
      throw new Error(`A file already exists at: ${newPath}`);
    }
    try {
      await fsp.rename(oldPath, newPath);
    } catch (e) {
      // rename fails with EXDEV across filesystems (e.g. C: -> D:, different
      // mounts). Fall back to copy-then-delete so the source stays intact
      // until the copy is durable (merge-over-wipe, never wipe-then-merge).
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      // `errorOnExist` keeps the merge-over-wipe guarantee: if a file appears
      // at the destination between the pre-check above and now, fail loudly
      // rather than silently overwriting it (matches importExternal / rename).
      await fsp.cp(oldPath, newPath, { recursive: true, errorOnExist: true });
      await fsp.rm(oldPath, { recursive: true, force: false });
    }
    try {
      await Promise.all([
        moveSidecar(oldPath, newPath),
        moveThumbnail(oldPath, newPath),
        moveTranscode(oldPath, newPath),
        moveOfficePdf(oldPath, newPath),
        invalidateRecursiveScan(oldPath),
        invalidateRecursiveScan(newPath),
      ]);
    } catch {
      // non-critical
    }
  }

  ipcMain.handle(
    'fs:copy',
    (_event, sourcePath: string, destPath: string) => copy(sourcePath, destPath)
  );
  async function copy(sourcePath: string, destPath: string): Promise<void> {
    assertWithinAllowedRoot(sourcePath); // destination may be any folder the user picked
    if (existsSync(destPath)) {
      throw new Error(`A file already exists at: ${destPath}`);
    }
    await fsp.cp(sourcePath, destPath, { recursive: true });
    try {
      await Promise.all([
        copySidecar(sourcePath, destPath),
        copyThumbnail(sourcePath, destPath),
        copyTranscode(sourcePath, destPath),
        copyOfficePdf(sourcePath, destPath),
        invalidateRecursiveScan(destPath),
      ]);
    } catch {
      // non-critical
    }
  }

  ipcMain.handle(
    'fs:importExternal',
    (_event, sources: string[], destDir: string) =>
      importExternal(sources, destDir)
  );
  /**
   * Copy external files/folders (dragged in from outside the app) into `destDir`.
   * The destination must be inside a registered location (write safety); the
   * sources are arbitrary user-chosen paths (read only). Never overwrites — on a
   * name clash the copy gets a " (n)" suffix (data-safety: see CLAUDE.md). Best-
   * effort per file so one failure doesn't abort the batch.
   */
  async function importExternal(
    sources: string[],
    destDir: string
  ): Promise<{ copied: number; errors: string[]; importedPaths: string[] }> {
    assertWithinAllowedRoot(destDir);
    // Seed the taken-name set from the directory so dropped names never clash
    // with existing files or with each other within this batch.
    const taken = new Set<string>(
      await fsp.readdir(destDir).catch(() => [] as string[])
    );
    // P3-5 (perf audit): copy in parallel (cap 4) instead of serially — a
    // multi-hundred-file drag-drop used to copy one at a time. Name dedup stays
    // race-free: `nextAvailableName` + `taken.add` run synchronously before the
    // first `await`, so each source reserves its name atomically (JS is
    // single-threaded; nothing interleaves between them).
    const outcomes = await mapWithConcurrency(sources, 4, async (source) => {
      try {
        const name = nextAvailableName(path.basename(source), taken);
        taken.add(name);
        const destPath = path.join(destDir, name);
        await fsp.cp(source, destPath, { recursive: true, errorOnExist: true });
        try {
          await Promise.all([
            copySidecar(source, destPath),
            copyThumbnail(source, destPath),
            copyTranscode(source, destPath),
            copyOfficePdf(source, destPath),
            invalidateRecursiveScan(destPath),
          ]);
        } catch {
          // sidecar/thumbnail carry-over is non-critical
        }
        return { destPath };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    });
    const importedPaths: string[] = [];
    const errors: string[] = [];
    for (const o of outcomes) {
      if ('destPath' in o) importedPaths.push(o.destPath);
      else errors.push(o.error);
    }
    return { copied: importedPaths.length, errors, importedPaths };
  }

  ipcMain.handle(
    'fs:delete',
    (_event, targetPath: string, useTrash = true) =>
      deletePath(targetPath, useTrash)
  );

  ipcMain.handle('fs:mkdir', (_event, dirPath: string) =>
    createDirectory(dirPath)
  );

  ipcMain.handle(
    'fs:createTextFile',
    (_event, filePath: string, content: string) =>
      createTextFile(filePath, content)
  );

  ipcMain.handle(
    'fs:writeBinaryFile',
    (_event, filePath: string, base64: string) =>
      writeBinaryFile(filePath, base64)
  );

  ipcMain.handle('fs:openNative', (_event, targetPath: string) =>
    openNative(targetPath)
  );

  ipcMain.handle('fs:zipDirectory', (_event, dirPath: string) =>
    zipDirectory(dirPath)
  );

  ipcMain.handle(
    'fs:zipEntries',
    (_event, paths: string[], zipPath: string) => zipEntries(paths, zipPath)
  );

  // Opens the OS recycle bin / trash so users can see & restore files deleted
  // via shell.trashItem (Whale has no in-app trash — it relies on the OS one).
  ipcMain.handle('shell:openTrash', () => {
    const cmd =
      process.platform === 'win32'
        ? 'explorer.exe shell:RecycleBinFolder'
        : process.platform === 'darwin'
          ? 'open trash://'
          : 'xdg-open trash://';
    return new Promise<void>((resolve) => {
      exec(cmd, () => resolve());
    });
  });

  // Reveal a file/folder in the OS file manager: open the folder itself, or
  // select the file inside its parent. Read-only — no allowedRoots check.
  ipcMain.handle('shell:revealPath', async (_event, targetPath: string) => {
    const stat = await fsp.stat(targetPath);
    if (stat.isDirectory()) {
      const errMsg = await shell.openPath(targetPath);
      if (errMsg) throw new Error(errMsg);
    } else {
      shell.showItemInFolder(targetPath);
    }
  });

  // H.23 P1-7: open the OS file manager AND highlight the file. Cross-
  // platform implementation:
  //   - Win:  `shell.showItemInFolder(path)` — opens Explorer with the file
  //           highlighted & selected. Replaces the prior
  //           `explorer /select,<path>` execFile approach, which silently
  //           failed on Win10/11 for paths containing spaces / commas /
  //           Unicode (Node's `execFile` quotes them, then `explorer.exe`
  //           mis-parses the comma in the switch).
  //   - macOS: `open -R <path>` reveals in Finder.
  //   - Linux: `xdg-open <parent>` first; if it errors (e.g. no
  //           `xdg-open` binary) fall back to `nautilus --select <path>`.
  //         The macOS / Linux paths keep `execFile` because the shell API
  //         doesn't expose a "select" primitive on those platforms. Spawn
  //         failures now reject so the renderer can surface the error
  //         instead of silently no-op'ing (the pre-fix `run` helper always
  //         resolved, which is what made this regression invisible).
  //         Read-only — no allowedRoots check (the parent reveal is a UX
  //         gesture, not an IO op).
  ipcMain.handle(
    'shell:revealAndSelect',
    async (_event, targetPath: string) => {
      const platform = process.platform;
      // Run a CLI helper and surface spawn errors back to the renderer.
      // The helper rejects on `error` (ENOENT / EACCES / spawn failures)
      // AND on non-zero exit codes for `open -R` / `nautilus --select`.
      // `xdg-open` is treated as best-effort: it may be missing on
      // stripped Linux distros, so we let the caller decide whether to
      // fall back by catching per-call.
      const run = (
        cmd: string,
        args: string[],
        opts: { tolerateNonZeroExit?: boolean } = {}
      ): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          const child = execFile(
            cmd,
            args,
            { windowsHide: true },
            (err) => {
              if (!err) {
                resolve();
                return;
              }
              if (opts.tolerateNonZeroExit && err.code !== 0) {
                console.warn(
                  `[shell:revealAndSelect] ${cmd} ${args.join(' ')} exited with ${err.code ?? err.message}`
                );
                resolve();
                return;
              }
              reject(
                new Error(
                  `${cmd} ${args.join(' ')} failed: ${err.code ?? err.message}`
                )
              );
            }
          );
          // `child.on('error')` fires when the process could not be
          // spawned at all (ENOENT for the binary, EACCES, etc.). Surface
          // that as a rejection so the caller can decide.
          child.on('error', (err) => {
            reject(
              new Error(
                `[shell:revealAndSelect] spawn ${cmd} failed: ${err.message}`
              )
            );
          });
        });
      if (platform === 'win32') {
        // Electron's official API. Handles path escaping correctly on
        // Win10/11 and selects the file in Explorer. The earlier execFile
        // approach was strictly worse here — see the header comment.
        shell.showItemInFolder(targetPath);
      } else if (platform === 'darwin') {
        await run('open', ['-R', targetPath]);
      } else {
        // Linux: open the parent dir; if it fails, try nautilus --select
        // as a fallback. Each helper rejects on hard spawn errors; we
        // catch the parent-open failure so a missing `xdg-open` still
        // gives the user nautilus.
        const parent = path.dirname(targetPath);
        try {
          await run('xdg-open', [parent], { tolerateNonZeroExit: true });
        } catch (e) {
          console.warn(
            `[shell:revealAndSelect] xdg-open unavailable, falling back to nautilus: ${
              e instanceof Error ? e.message : String(e)
            }`
          );
        }
        await run('nautilus', ['--select', targetPath]);
      }
    }
  );

  // Run a user-configured shell command (Settings → Commands) on a right-
  // clicked file/folder, with the path substituted into ${path}/${dir}/${name}.
  // Opens a NEW terminal window with the command; main quotes the path. See
  // shell-command.ts + docs/13-security.md.
  ipcMain.handle('shell:runCommand', (_event, template: string, targetPath: string) =>
    runUserCommand(template, targetPath)
  );

  // ---- EXIF / GPS (Mapique perspective) ----
  ipcMain.handle('exif:extractGps', (_event, filePath: string) =>
    extractGps(filePath)
  );

  // P3-4: persisted EXIF extraction cache. Reads return the full record set
  // for the current root; writes upsert a single record. The renderer reads
  // on directory mount to skip files already known to lack GPS, and writes
  // back after each attempt.
  ipcMain.handle('exif:load-processed', (_event, rootPath: string) => {
    assertWithinAllowedRoot(rootPath);
    return request('exif:load-processed', { rootPath });
  });
  // P3-7: popup EXIF summary. Lazy — the renderer fetches this when a
  // marker is clicked, never on the initial map render.
  ipcMain.handle('exif:get-summary', (_event, filePath: string) =>
    getExifSummary(filePath)
  );
  ipcMain.handle(
    'exif:mark-processed',
    (
      _event,
      rootPath: string,
      record: { path: string; status: 'ok' | 'none'; lat: number | null; lng: number | null; triedAt: number }
    ) => {
      assertWithinAllowedRoot(rootPath);
      return request('exif:mark-processed', { rootPath, record });
    }
  );
  // Batched variant — one IPC + one transaction (fsync) per batch instead of
  // per image. Used by the Mapique EXIF extractor for a whole folder at once.
  // P0-2: forwarded to the worker; the worker keeps the single-transaction
  // property (one WAL fsync per call, not per record).
  ipcMain.handle(
    'exif:mark-processed-many',
    (
      _event,
      rootPath: string,
      records: { path: string; status: 'ok' | 'none'; lat: number | null; lng: number | null; triedAt: number }[]
    ) => {
      assertWithinAllowedRoot(rootPath);
      return request('exif:mark-processed-many', { rootPath, records });
    }
  );
  ipcMain.handle('exif:clear-processed', (_event, rootPath: string) => {
    assertWithinAllowedRoot(rootPath);
    return request('exif:clear-processed', { rootPath });
  });

  // ---- Index (SQLite, plan §6.6 P2) ----
  // P0-2: each handler here is a thin forwarder to the index utilityProcess.
  // assertWithinAllowedRoot stays in the main process — never trust the
  // renderer with path validation, and never duplicate the check downstream.
  // The worker trusts the inputs it receives from main.
  ipcMain.handle('index:build', async (_event, rootPath: string) => {
    assertWithinAllowedRoot(rootPath); // writes <root>/.whale/index.db
    return request('index:build', { rootPath });
  });

  // Filename/path/tags fuzzy search (FTS5 trigram) — replaces the old in-memory
  // Fuse load+search. Returns IndexEntry[]; the renderer highlights client-side.
  ipcMain.handle('index:query', (_event, rootPath: string, q: string) =>
    request('index:query', { rootPath, q })
  );

  // Structured (advanced) search — the SearchQuery compiled to a SQL WHERE.
  ipcMain.handle('index:advanced', (_event, rootPath: string, q: SearchQuery) =>
    request('index:advanced', { rootPath, q })
  );

  ipcMain.handle('index:tags', (_event, rootPath: string) =>
    request('index:tags', { rootPath })
  );

  ipcMain.handle('index:status', (_event, rootPath: string) =>
    request('index:status', { rootPath })
  );

  // ---- Full-text index (SQLite FTS5, plan §6.6 P2) ----
  // buildFulltextIndex applies an incremental delta (insert changed/new, delete
  // removed, leave unchanged rows untouched), so there's no stale-incremental
  // state to clear first.
  ipcMain.handle('fulltext:build', (_event, rootPath: string) => {
    assertWithinAllowedRoot(rootPath);
    return request('fulltext:build', { rootPath });
  });

  ipcMain.handle('fulltext:search', (_event, rootPath: string, query: string) =>
    request('fulltext:search', { rootPath, q: query })
  );

  ipcMain.handle('fulltext:has', (_event, rootPath: string) =>
    request('fulltext:has', { rootPath })
  );

  // ---- Sidecar metadata (`.whale/<file>.json`) ----
  ipcMain.handle(
    'sidecar:readMany',
    (_event, dirPath: string, names: string[]) => readSidecars(dirPath, names)
  );
  // H.24 R7: batch-read sidecars for a recursive scan (files spread across
  // many subdirs) in one IPC round trip. Falls back to per-file legacy reads
  // for subdirs whose aggregated wsd.json doesn't exist yet (plan §N1).
  ipcMain.handle(
    'sidecar:readForPaths',
    (_event, filePaths: string[]) => readSidecardsForPaths(filePaths)
  );

  ipcMain.handle(
    'sidecar:write',
    (_event, filePath: string, meta: SidecarMeta) => writeSidecar(filePath, meta)
  );

  // ---- Folder metadata (`.whale/wsm.json`): tags/color/description + view prefs ----
  ipcMain.handle('folderMeta:read', (_event, dirPath: string) =>
    readFolderMeta(dirPath)
  );

  ipcMain.handle(
    'folderMeta:write',
    (_event, dirPath: string, patch: Partial<FolderMeta>) => {
      assertWithinAllowedRoot(dirPath); // writes under <dir>/.whale/
      return writeFolderMeta(dirPath, patch);
    }
  );

  // ---- Per-location tag library (`.whale/wtaglib.json`): one description per tag ----
  ipcMain.handle('tagLibrary:read', (_event, locationRoot: string) => {
    assertWithinAllowedRoot(locationRoot); // wtaglib lives under <root>/.whale/
    return readTagLibrary(locationRoot);
  });

  ipcMain.handle(
    'tagLibrary:setDescription',
    (
      _event,
      locationRoot: string,
      tag: string,
      description: string
    ) => {
      assertWithinAllowedRoot(locationRoot);
      return setTagLibraryDescription(locationRoot, tag, description);
    }
  );

  ipcMain.handle(
    'tagLibrary:clearDescription',
    (_event, locationRoot: string, tag: string) => {
      assertWithinAllowedRoot(locationRoot);
      return clearTagLibraryDescription(locationRoot, tag);
    }
  );

  // ---- Ebook-viewer annotation persistence (`.whale/ebook-annotations/<basename>.json`) ----
  // Both channels assert on the ebook's parent directory so a renderer can
  // never probe paths outside an allowed location root (the annotations file
  // itself does not exist yet on first write).
  ipcMain.handle(
    'ebookAnnotations:read',
    (_event, filePath: string) => {
      assertWithinAllowedRoot(path.dirname(filePath));
      return readEbookAnnotations(filePath);
    }
  );

  ipcMain.handle(
    'ebookAnnotations:write',
    (_event, filePath: string, payload: unknown) => {
      assertWithinAllowedRoot(path.dirname(filePath));
      return writeEbookAnnotations(
        filePath,
        payload as Parameters<typeof writeEbookAnnotations>[1]
      );
    }
  );

  // ---- Image thumbnails (`.whale/thumbs/<file>.jpg`) ----
  ipcMain.handle(
    'thumbnail:generate',
    (_event, filePath: string, options?: { sofficePath?: string | null }) => {
      assertWithinAllowedRoot(filePath); // writes under .whale/thumbs/
      return generateThumbnail(filePath, options);
    }
  );

  ipcMain.handle('thumbnail:load', (_event, filePath: string) =>
    loadThumbnail(filePath)
  );

  // ---- Folder thumbnails / backgrounds (`.whale/wst.jpg` / `.whale/wsb.jpg`) ----
  ipcMain.handle('thumbnail:loadFolder', (_event, dirPath: string) =>
    loadFolderThumbnail(dirPath)
  );
  ipcMain.handle('thumbnail:loadFolderBackground', (_event, dirPath: string) =>
    loadFolderBackground(dirPath)
  );
  ipcMain.handle(
    'thumbnail:setFolderThumbnail',
    (_event, dirPath: string, sourcePath: string) => {
      assertWithinAllowedRoot(dirPath);
      return setFolderThumbnail(dirPath, sourcePath);
    }
  );
  ipcMain.handle(
    'thumbnail:setFolderBackground',
    (_event, dirPath: string, sourcePath: string) => {
      assertWithinAllowedRoot(dirPath);
      return setFolderBackground(dirPath, sourcePath);
    }
  );
  ipcMain.handle(
    'thumbnail:clearFolderThumbnail',
    (_event, dirPath: string) => {
      assertWithinAllowedRoot(dirPath);
      return clearFolderThumbnail(dirPath);
    }
  );
  ipcMain.handle(
    'thumbnail:clearFolderBackground',
    (_event, dirPath: string) => {
      assertWithinAllowedRoot(dirPath);
      return clearFolderBackground(dirPath);
    }
  );

  // ---- Phase 4: Extension system (viewers / editors / revisions) ----
  ipcMain.handle('ext:loadRegistry', () => loadExtensionRegistry());

  ipcMain.handle('ext:backupRevision', (_event, filePath: string) =>
    backupRevision(filePath)
  );

  ipcMain.handle('ext:deleteRevision', (_event, revisionPath: string) =>
    deleteRevision(revisionPath)
  );

  ipcMain.handle(
    'ext:writeFile',
    (_event, filePath: string, content: string) =>
      writeFileWithRevision(filePath, content)
  );

  ipcMain.handle('ext:listRevisions', (_event, filePath: string) =>
    listRevisions(filePath)
  );

  ipcMain.handle(
    'ext:restoreRevision',
    (_event, filePath: string, revisionPath: string) =>
      restoreRevision(filePath, revisionPath)
  );

  ipcMain.handle('ext:cleanupRevisions', (_event, maxAgeDays: number) => {
    // The renderer passes the configured location roots; clean each one.
    const roots = getAllowedRoots();
    return Promise.all(
      roots.map((root) => cleanupRevisionsForLocation(root, maxAgeDays))
    );
  });

  ipcMain.handle(
    'ext:getPdfAsset',
    (_event, kind: string, filename: string) => readPdfAsset(kind, filename)
  );

  ipcMain.handle('ext:getCadWasm', () => readCadWasm());

  ipcMain.handle('ext:getHeicWasm', () => readHeicWasm());

  ipcMain.handle(
    'ext:convertOfficeToPdf',
    async (_event, filePath: string, options?: { sofficePath?: string | null }) => {
      // Return the Buffer directly — Electron IPC serializes it as a Uint8Array
      // on the renderer, so the previous `new ArrayBuffer + .set(buf)` was a
      // redundant memcpy on every office-PDF open (MBs to tens of MBs). The
      // office-viewer passes the bytes through to pdfjs without re-wrapping.
      // See docs/15 P1-4.
      return loadOfficePdf(filePath, options);
    }
  );

  ipcMain.handle(
    'ext:convertDwgToDxf',
    async (
      _event,
      filePath: string,
      options?: { dwg2dxfPath?: string | null; odaPath?: string | null }
    ) => {
      const buf = await convertDwgToDxf(filePath, options);
      const out = new ArrayBuffer(buf.byteLength);
      new Uint8Array(out).set(buf);
      return out;
    }
  );

  ipcMain.handle('ext:detectDwgConverters', async () => ({
    dwg2dxf: await dwg2dxfBinary(),
    oda: odaConverterBinary(),
  }));

  ipcMain.handle(
    'ext:convertEbookToEpub',
    async (_event, filePath: string, options?: { calibrePath?: string | null }) => {
      const buf = await convertEbookToEpub(filePath, options);
      const out = new ArrayBuffer(buf.byteLength);
      new Uint8Array(out).set(buf);
      return out;
    }
  );

  ipcMain.handle('ext:detectEbookConverter', async () => ({
    calibre: await ebookConvertBinary(),
  }));

  // docs/09 §16.16: office-viewer probes LibreOffice availability up front so it
  // can show install guidance (instead of a bare "soffice not found" dead-end)
  // before even attempting the doomed convert.
  ipcMain.handle('ext:isSofficeAvailable', () => isSofficeAvailable());

  // docs/05 §10: Mapique place-name search via Nominatim. Runs in main (renderer
  // CSP blocks external domains + Nominatim requires a User-Agent browser fetch
  // can't set). Returns WGS-84 — MapiqueView's toDisplay shifts to the tile datum.
  ipcMain.handle('mapique:geocode', async (_event, query: string) => ({
    results: await geocodeNominatim(query, {
      userAgent: `WhaleTag/${app.getVersion()}`,
    }),
  }));


  // Archive decoder for archive-viewer Phase 2+.
  ipcMain.handle(
    'archive:listArchive',
    async (_event, filePath: string, options?) => listArchive(filePath, options)
  );
  ipcMain.handle(
    'archive:readEntry',
    async (_event, filePath: string, entryPath: string, options?) =>
      readArchiveEntry(filePath, entryPath, options)
  );
  ipcMain.handle(
    'archive:extract',
    async (_event, filePath: string, destDir: string, options?) =>
      extractArchive(filePath, destDir, options)
  );

  ipcMain.handle(
    'dialog:saveImage',
    async (_event, defaultPath: string) => {
      const result = await dialog.showSaveDialog({
        defaultPath,
        filters: [
          {
            name: 'Images',
            extensions: ['jpg', 'jpeg', 'png', 'webp', 'tiff', 'tif', 'avif'],
          },
        ],
      });
      return result.canceled || !result.filePath ? null : result.filePath;
    }
  );

  ipcMain.handle(
    'window:captureRegion',
    async (event, rect: { x: number; y: number; width: number; height: number }) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) {
        throw new Error('No source window available for captureRegion');
      }
      const image = await win.webContents.capturePage(rect);
      return image.toPNG().toString('base64');
    }
  );

  // Frameless title-bar window controls. Each resolves the focused window from
  // the sender so the handlers work regardless of which window called them.
  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle('window:maximizeToggle', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle('window:isMaximized', (event) =>
    BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  );


  // Native OS drag of a file, so it can be dropped into sandboxed extension
  // iframes (e.g. dragging an image into the Excalidraw editor) where an
  // in-page HTML5 drag would not expose dataTransfer.files. Fire-and-forget
  // (ipcMain.on) because startDrag must run during the renderer's dragstart.
  ipcMain.on('drag:startFile', (event, filePath: string) => {
    try {
      let icon = nativeImage.createFromPath(filePath);
      if (icon.isEmpty()) {
        // Non-image (or unreadable) files have no preview → generic doc icon.
        icon = getDragFallbackIcon();
      } else {
        icon = icon.resize({ width: 64 });
      }
      event.sender.startDrag({ file: filePath, icon });
    } catch {
      // Drag is best-effort; ignore failures (e.g. file removed mid-drag).
    }
  });


  // ---- redux-persist storage backed by main-process JSON file ----
  // localStorage in Electron is asynchronously flushed by Chromium and can
  // lose data on process exit. These handlers use synchronous file IO so the
  // persisted state is on disk before the IPC call returns.
  //
  // We expose both async (handle) and sync (on/sendSync) variants because
  // redux-persist v5's default storage interface is synchronous. The renderer
  // adapter uses sendSync so rehydration blocks until the file is read.
  ipcMain.handle('persist:read', (_event, key: string) => persistRead(key));
  ipcMain.handle('persist:write', (_event, key: string, value: string) => {
    persistWrite(key, value);
  });
  ipcMain.handle('persist:delete', (_event, key: string) => {
    persistDelete(key);
  });

  ipcMain.on('persist:readSync', (event, key: string) => {
    event.returnValue = persistRead(key);
  });
  ipcMain.on('persist:writeSync', (event, key: string, value: string) => {
    persistWrite(key, value);
    event.returnValue = undefined;
  });
  ipcMain.on('persist:deleteSync', (event, key: string) => {
    persistDelete(key);
    event.returnValue = undefined;
  });
}

/** Maps a pdfjs binary-asset kind to its subdirectory under pdfjs-dist. */
const PDF_ASSET_DIRS: Record<string, string> = {
  cMapUrl: 'cmaps',
  standardFontDataUrl: 'standard_fonts',
  wasmUrl: 'wasm',
};

const nodeRequire = createRequire(__filename);
let pdfjsRootDir: string | null = null;
function getPdfjsRoot(): string {
  if (!pdfjsRootDir) {
    pdfjsRootDir = path.dirname(nodeRequire.resolve('pdfjs-dist/package.json'));
  }
  return pdfjsRootDir;
}

/**
 * Reads a pdfjs-dist data file (cmap / standard font / wasm) for the PDF viewer
 * extension, which renders in its iframe and cannot read the filesystem. The
 * filename is reduced to its basename to prevent path traversal.
 */
// P3-5 (perf audit): pdfjs data files (cmap / standard font / wasm) are
// immutable bundled assets — cache the source bytes by path so repeated viewer
// opens don't re-read from disk. A fresh ArrayBuffer copy is still returned per
// call (the bytes cross IPC → iframe and may be consumed by emscripten).
const pdfAssetCache = new Map<string, Buffer>();

async function readPdfAsset(kind: string, filename: string): Promise<ArrayBuffer> {
  const subDir = PDF_ASSET_DIRS[kind];
  if (!subDir) {
    throw new Error(`Unknown pdf asset kind: ${kind}`);
  }
  const safeName = path.basename(filename);
  const fullPath = path.join(getPdfjsRoot(), subDir, safeName);
  let buf = pdfAssetCache.get(fullPath);
  if (!buf) {
    buf = await fsp.readFile(fullPath);
    pdfAssetCache.set(fullPath, buf);
  }
  const out = new ArrayBuffer(buf.byteLength);
  new Uint8Array(out).set(buf);
  return out;
}

/**
 * Reads the occt-import-js wasm bundled into the cad-viewer extension's dist
 * folder, returning it as an ArrayBuffer. cad-viewer passes these bytes to
 * emscripten as `wasmBinary`, sidestepping the unreliable
 * `fetch('whale-extension://…')` path. Same root as the registry: the main
 * bundle lives in `dist/main/`, extensions in `dist/extensions/`.
 */
// P3-5 (perf audit): the bundled wasm is immutable — cache the source bytes so
// reopening a CAD file doesn't re-read from disk. Still returns a fresh copy.
let _cadWasmBuf: Buffer | undefined;
async function readCadWasm(): Promise<ArrayBuffer> {
  const fullPath = path.join(
    __dirname,
    '..',
    'extensions',
    'cad-viewer',
    'occt-import-js.wasm'
  );
  if (!_cadWasmBuf) _cadWasmBuf = await fsp.readFile(fullPath);
  const out = new ArrayBuffer(_cadWasmBuf.byteLength);
  new Uint8Array(out).set(_cadWasmBuf);
  return out;
}

/**
 * Reads the libheif-js wasm bundled into the heic-viewer extension's dist
 * folder, returning it as an ArrayBuffer. heic-viewer passes these bytes to
 * emscripten as `wasmBinary`, sidestepping the unreliable
 * `fetch('whale-extension://…')` path (same pattern as readCadWasm).
 */
// P3-5 (perf audit): see readCadWasm — immutable bundled wasm, cached source.
let _heicWasmBuf: Buffer | undefined;
async function readHeicWasm(): Promise<ArrayBuffer> {
  const fullPath = path.join(
    __dirname,
    '..',
    'extensions',
    'heic-viewer',
    'libheif.wasm'
  );
  if (!_heicWasmBuf) _heicWasmBuf = await fsp.readFile(fullPath);
  const out = new ArrayBuffer(_heicWasmBuf.byteLength);
  new Uint8Array(out).set(_heicWasmBuf);
  return out;
}

/** Reads the built-in extension registry from the packaged dist folder. */
async function loadExtensionRegistry(): Promise<ExtensionRegistry | null> {
  const registryPath = path.join(__dirname, '..', 'extensions', 'registry.json');
  if (!existsSync(registryPath)) return null;
  try {
    const raw = await fsp.readFile(registryPath, 'utf8');
    return JSON.parse(raw) as ExtensionRegistry;
  } catch {
    return null;
  }
}

async function writeFileWithRevision(
  filePath: string,
  content: string
): Promise<void> {
  assertWithinAllowedRoot(filePath);
  await backupRevision(filePath);
  await atomicWriteText(filePath, content);
}
