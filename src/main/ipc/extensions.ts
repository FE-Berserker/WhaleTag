import path from 'path';
import { existsSync, promises as fsp } from 'fs';
import { ipcMain } from 'electron';
import {
  backupRevision,
  listRevisions,
  restoreRevision,
  cleanupRevisionsForLocation,
  deleteRevision,
} from '../revisions';
import { atomicWriteText } from '../atomic-write';
import {
  assertWritable,
  assertWithinAllowedRoot,
  getAllowedRoots,
  isReadOnlyPath,
} from '../allowed-roots';
import type { ExtensionRegistry } from '../../shared/extension-types';

/**
 * Extension-system handlers (`ext:*`): registry, revisions, bundled-asset
 * readers. Split out of the old god-registrar `ipc.ts`
 * (docs/01 §12) — behavior is verbatim.
 */

export function registerExtensionHandlers(): void {
  // ---- Phase 4: Extension system (viewers / editors / revisions) ----
  ipcMain.handle('ext:loadRegistry', () => loadExtensionRegistry());

  ipcMain.handle(
    'ext:deleteRevision',
    (_event, filePath: string, revisionPath: string) => {
      assertWithinAllowedRoot(filePath);
      assertWritable(filePath); // the revision list lives in the location
      return deleteRevision(filePath, revisionPath);
    }
  );

  ipcMain.handle(
    'ext:writeFile',
    (_event, filePath: string, content: string) => {
      // Editor saves are the most common write; confine them like every other
      // fs mutation (writeFileWithRevision does its own root check).
      assertWithinAllowedRoot(filePath);
      assertWritable(filePath);
      return writeFileWithRevision(filePath, content);
    }
  );

  ipcMain.handle('ext:listRevisions', (_event, filePath: string) => {
    assertWithinAllowedRoot(filePath);
    return listRevisions(filePath);
  });

  ipcMain.handle(
    'ext:restoreRevision',
    (_event, filePath: string, revisionPath: string) => {
      assertWithinAllowedRoot(filePath); // rewrites the file itself
      assertWritable(filePath);
      return restoreRevision(filePath, revisionPath);
    }
  );

  ipcMain.handle('ext:cleanupRevisions', (_event, maxAgeDays: number) => {
    if (
      typeof maxAgeDays !== 'number' ||
      !Number.isFinite(maxAgeDays) ||
      maxAgeDays < 0
    ) {
      throw new Error('Invalid maxAgeDays: expected a finite non-negative number');
    }
    // The renderer passes the configured location roots; clean each one.
    // Read-only locations are skipped: pruning their `.whale/revisions/` is
    // still a write inside a location the user protected.
    const roots = getAllowedRoots().filter((root) => !isReadOnlyPath(root));
    return Promise.all(
      roots.map((root) => cleanupRevisionsForLocation(root, maxAgeDays))
    );
  });

  ipcMain.handle('ext:getHeicWasm', () => readHeicWasm());
}

// ---------------------------------------------------------------------------
// Bundled-asset readers (HEIC wasm) + registry.
// ---------------------------------------------------------------------------

/**
 * Reads the libheif-js wasm bundled into the heic-viewer extension's dist
 * folder, returning it as an ArrayBuffer. heic-viewer passes these bytes to
 * emscripten as `wasmBinary`, sidestepping the unreliable
 * `fetch('whale-extension://…')` path. Same root as the registry: the main
 * bundle lives in `dist/main/`, extensions in `dist/extensions/` (this file
 * is one level deeper — `ipc/` — hence the double `..`).
 */
// P3-5 (perf audit): the bundled wasm is immutable — cache the source bytes so
// reopening a HEIC file doesn't re-read from disk. Still returns a fresh copy.
let _heicWasmBuf: Buffer | undefined;
async function readHeicWasm(): Promise<ArrayBuffer> {
  const fullPath = path.join(
    __dirname,
    '..',
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

/** Reads the built-in extension registry from the packaged dist folder.
 *
 *  A missing file is legitimate (a build without bundled extensions): the
 *  renderer then shows "no extensions". A file that exists but cannot be read
 *  or parsed is NOT "no extensions" — throwing lets the renderer surface the
 *  failure (notice + error state) instead of silently pretending the user has
 *  none installed.
 *
 *  @param registryPath overridable for tests. */
export async function loadExtensionRegistry(
  registryPath: string = path.join(__dirname, '..', 'extensions', 'registry.json')
): Promise<ExtensionRegistry | null> {
  if (!existsSync(registryPath)) return null;
  let raw: string;
  try {
    raw = await fsp.readFile(registryPath, 'utf8');
  } catch (e) {
    throw new Error(
      `Failed to read extension registry at ${registryPath}: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }
  try {
    return JSON.parse(raw) as ExtensionRegistry;
  } catch (e) {
    throw new Error(
      `Malformed extension registry at ${registryPath}: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }
}

/** Error carrying Node's `ENOENT` code so IPC callers/tests can discriminate a
 *  stale save from a permission/IO failure (the message is user-visible). */
function fileGoneError(message: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = 'ENOENT';
  return error;
}

/**
 * Writes an editor save under the allowed roots, taking a revision snapshot
 * first.
 *
 * The parent directory AND the target file must still exist: an editor tab can
 * outlive the file on disk (the user renames/moves/deletes it in the file area
 * while the tab stays open). Renaming keeps the old-path tab open in some
 * flows, and blindly writing would RESURRECT the file the user just renamed
 * away — a silent duplicate is worse than a failed save. The thrown ENOENT
 * message is surfaced verbatim by the renderer's save handler
 * (`ExtensionHost.handleSave` → `notifyApp(t('extensionSaveError', …))`).
 *
 * Exported for tests; the `ext:writeFile` IPC handler is the only production
 * caller.
 */
export async function writeFileWithRevision(
  filePath: string,
  content: string
): Promise<void> {
  assertWithinAllowedRoot(filePath);
  const parentDir = path.dirname(filePath);
  if (!existsSync(parentDir)) {
    throw fileGoneError(
      `Cannot save ${filePath}: its directory no longer exists (ENOENT)`
    );
  }
  if (!existsSync(filePath)) {
    throw fileGoneError(
      `Cannot save ${filePath}: the file no longer exists — it may have been renamed or deleted (ENOENT)`
    );
  }
  await backupRevision(filePath);
  await atomicWriteText(filePath, content);
}
