import path from 'path';
import { existsSync, promises as fsp } from 'fs';
import { ipcMain, shell } from 'electron';
import { execFile } from 'child_process';
import { nextAvailableName } from '../../shared/dedupe-name';
import { removeSidecar, moveSidecar, copySidecar } from '../sidecar';
import { removeThumbnail, moveThumbnail, copyThumbnail } from '../thumbnail';
import { invalidateRecursiveScan } from '../recursive-cache';
import { atomicWriteBytes } from '../atomic-write';
import { mapWithConcurrency } from '../concurrency';
import { withLock } from '../dir-lock';
import { assertWithinAllowedRoot } from '../allowed-roots';
import { PYTHON_ZIP_SCRIPT, pythonZipPairs } from '../desktop-linux';

/**
 * Write-side `fs:*` handlers: rename / move / copy / import / delete /
 * mkdir / create-file / zip + `fs:openNative`. Split out of the old
 * god-registrar `ipc.ts` (docs/01 §12) — behavior is verbatim; only the
 * module boundary is new.
 *
 * IMPORTANT (file-manager mindset): mutation handlers reject on failure so
 * the renderer can surface an error and suppress optimistic UI updates.
 * Never resolve a failed IO with a success sentinel.
 */

/** Creates a directory (idempotent: no error if it already exists). */
export async function createDirectory(dirPath: string): Promise<void> {
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
export async function createTextFile(filePath: string, content: string): Promise<void> {
  assertWithinAllowedRoot(filePath);
  try {
    // Atomic no-clobber create: an existsSync + writeFile pair would allow a
    // second process to create the file in between and then get overwritten.
    await fsp.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`File already exists: ${filePath}`);
    }
    throw err;
  }
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
export async function deletePath(targetPath: string, useTrash = true): Promise<void> {
  assertWithinAllowedRoot(targetPath);
  // App-internal metadata (sidecar entry + thumbnail) is removed best-effort —
  // it need not be recoverable the way user data is. Failures are logged (a
  // stale sidecar would otherwise resurrect tags for a deleted path on the
  // next scan) instead of failing the delete the user already completed.
  const cleanupMeta = () =>
    Promise.all([
      removeSidecar(targetPath).catch((e) =>
        console.warn('[fs-write] failed to drop the sidecar after delete:', targetPath, e)
      ),
      removeThumbnail(targetPath).catch((e) =>
        console.warn('[fs-write] failed to drop the thumbnail after delete:', targetPath, e)
      ),
      invalidateRecursiveScan(targetPath).catch((e) =>
        console.warn('[fs-write] failed to invalidate the scan cache after delete:', targetPath, e)
      ),
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
 * Absolute ancestor chain of `p`, root first (`['/', '/a', '/a/b']`).
 * Used to find the deepest directory containing every zip source.
 */
function ancestorChain(p: string): string[] {
  const chain: string[] = [];
  let current = path.resolve(p);
  for (;;) {
    chain.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain.reverse();
}

/**
 * Deepest directory that contains every source. Archives are built from this
 * directory so entries keep their relative layout for sources from different
 * folders — `zip -r` with `cwd: dirname(sources[0])` silently dropped or
 * duplicated the rest (an MCP client can select across locations).
 */
export function commonParentDir(sources: string[]): string {
  if (sources.length === 0) {
    throw new Error('commonParentDir requires at least one path');
  }
  let common = ancestorChain(path.dirname(path.resolve(sources[0])));
  for (const source of sources.slice(1)) {
    const chain = ancestorChain(path.dirname(path.resolve(source)));
    let i = 0;
    while (i < common.length && i < chain.length && common[i] === chain[i]) {
      i += 1;
    }
    common = common.slice(0, i);
  }
  if (common.length === 0) {
    return path.parse(path.resolve(sources[0])).root;
  }
  return common[common.length - 1];
}

/**
 * Runs the OS's built-in zip tool (no bundled dependency): PowerShell's
 * Compress-Archive on Windows, the `zip` CLI elsewhere. `sources` are absolute
 * paths to files/folders inside configured locations; on POSIX the archive is
 * built from their deepest common parent so entries keep relative names.
 * Resolves once the archive exists; rejects (surfacing stderr) otherwise.
 */
function runOsZip(sources: string[], zipPath: string): Promise<string> {
  const archive = path.resolve(zipPath);
  return new Promise<string>((resolve, reject) => {
    const done = (err: Error | null) => {
      if (err) return reject(err);
      if (!existsSync(archive)) {
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
        archive
      )}`;
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        (err) => done(err)
      );
    } else {
      // `zip -r` from the shared parent so entries are stored by relative name
      // (extract back to the same folder layout, not loose/absolute paths).
      const cwd = commonParentDir(sources);
      execFile(
        'zip',
        ['-r', '-q', archive, ...sources.map((s) => path.relative(cwd, s))],
        { cwd },
        (err) => {
          if (!err) {
            done(null);
            return;
          }
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            done(err);
            return;
          }
          // `zip` is not installed by default on several distributions
          // (Ubuntu Desktop included); `python3` is. The fallback writes the
          // same relative layout (dirs walked, empty dirs skipped) so the
          // user still gets an archive instead of "打包失败" (docs/16 C-2).
          console.warn(
            '[fs-write] the zip CLI is not installed; falling back to python3 zipfile'
          );
          execFile(
            'python3',
            [
              '-c',
              PYTHON_ZIP_SCRIPT,
              JSON.stringify(pythonZipPairs(sources, cwd)),
              archive,
            ],
            { cwd },
            (pythonError) =>
              done(
                pythonError
                  ? new Error(
                      `zip is not installed and the python3 fallback failed: ${pythonError.message}`
                    )
                  : null
              )
          );
        }
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
export function zipDirectory(dirPath: string): Promise<string> {
  assertWithinAllowedRoot(dirPath);
  return runOsZip([dirPath], freeZipPath(dirPath));
}

/**
 * Zips an explicit set of entries (the file-list multi-selection) into a
 * user-named `zipPath`. Sources are confined to configured locations; the
 * destination is rejected if it already exists (the user chose the name, so a
 * collision is surfaced rather than silently suffixed or clobbered).
 */
export function zipEntries(paths: string[], zipPath: string): Promise<string> {
  if (!paths.length) throw new Error('Nothing selected to package');
  for (const p of paths) assertWithinAllowedRoot(p);
  if (existsSync(zipPath)) {
    throw new Error(`A file already exists at: ${zipPath}`);
  }
  return runOsZip(paths, zipPath);
}

/**
 * Rename (same-directory rename OR move) - shared by the `fs:rename` IPC and
 * the MCP tools. Never overwrites an existing destination; moves the sidecar
 * + thumbnail along best-effort.
 */
export async function renameEntry(oldPath: string, newPath: string): Promise<void> {
  assertWithinAllowedRoot(oldPath);
  assertWithinAllowedRoot(newPath);
  // Serialize check+rename per destination folder: two concurrent renames into
  // the same folder could both pass the exists check and the loser would be
  // silently replaced (the renderer batches, and MCP clients parallelize calls).
  await withLock(path.dirname(newPath), async () => {
    // Avoid silently overwriting an existing destination.
    if (existsSync(newPath)) {
      throw new Error(`A file already exists at: ${newPath}`);
    }
    await fsp.rename(oldPath, newPath);
  });
  // Keep the sidecar in sync with the rename/move (best-effort: never fails
  // the rename itself if the sidecar can't be moved).
  try {
    await Promise.all([
      moveSidecar(oldPath, newPath),
      moveThumbnail(oldPath, newPath),
      invalidateRecursiveScan(oldPath),
      invalidateRecursiveScan(newPath),
    ]);
  } catch {
    // file rename already succeeded; metadata sync is non-critical
  }
}

/**
 * Move an entry to an arbitrary destination (EXDEV-safe copy+delete fallback).
 * Shared by the `fs:move` IPC and the MCP tools.
 */
export async function moveEntry(oldPath: string, newPath: string): Promise<void> {
  assertWithinAllowedRoot(oldPath); // destination may be any folder the user picked
  // Check+move is serialized per destination folder — see renameEntry.
  await withLock(path.dirname(newPath), async () => {
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
      // `force: false` + `errorOnExist` keeps the merge-over-wipe guarantee:
      // if a file appears at the destination between the pre-check and now,
      // fail loudly rather than silently overwriting it. (`errorOnExist` is
      // ignored while `force` is true — Node's default — so both are needed.)
      await fsp.cp(oldPath, newPath, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      await fsp.rm(oldPath, { recursive: true, force: false });
    }
  });
  try {
    await Promise.all([
      moveSidecar(oldPath, newPath),
      moveThumbnail(oldPath, newPath),
      invalidateRecursiveScan(oldPath),
      invalidateRecursiveScan(newPath),
    ]);
  } catch {
    // non-critical
  }
}

/**
 * Copy an entry (recursive for directories), carrying sidecar + thumbnail
 * best-effort. Shared by the `fs:copy` IPC and the MCP tools.
 */
export async function copyEntry(sourcePath: string, destPath: string): Promise<void> {
  assertWithinAllowedRoot(sourcePath); // destination may be any folder the user picked
  // Serialized check+copy per destination folder. `force: false` is what makes
  // `errorOnExist` effective (Node defaults `force` to true and would silently
  // replace a file that appeared after the pre-check).
  await withLock(path.dirname(destPath), async () => {
    if (existsSync(destPath)) {
      throw new Error(`A file already exists at: ${destPath}`);
    }
    await fsp.cp(sourcePath, destPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  });
  try {
    await Promise.all([
      copySidecar(sourcePath, destPath),
      copyThumbnail(sourcePath, destPath),
      invalidateRecursiveScan(destPath),
    ]);
  } catch {
    // non-critical
  }
}

export function registerFsWriteHandlers(): void {
  ipcMain.handle(
    'fs:rename',
    (_event, oldPath: string, newPath: string) => renameEntry(oldPath, newPath)
  );

  ipcMain.handle(
    'fs:move',
    (_event, oldPath: string, newPath: string) => moveEntry(oldPath, newPath)
  );

  ipcMain.handle(
    'fs:copy',
    (_event, sourcePath: string, destPath: string) => copyEntry(sourcePath, destPath)
  );

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

  // Read/exec-side confinement (docs/13 §13): extensions' `openLinkExternally`
  // (non-http) and `openNative` messages funnel here; the OS handler must not
  // be launchable on paths outside configured locations.
  ipcMain.handle('fs:openNative', (_event, targetPath: string) => {
    assertWithinAllowedRoot(targetPath);
    return openNative(targetPath);
  });

  ipcMain.handle('fs:zipDirectory', (_event, dirPath: string) =>
    zipDirectory(dirPath)
  );

  ipcMain.handle(
    'fs:zipEntries',
    (_event, paths: string[], zipPath: string) => zipEntries(paths, zipPath)
  );
}
