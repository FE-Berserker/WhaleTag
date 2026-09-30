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
  assertWithinAllowedRoot,
  getAllowedRoots,
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

  ipcMain.handle('ext:backupRevision', (_event, filePath: string) => {
    assertWithinAllowedRoot(filePath); // writes <dir>/.whale/revisions/
    return backupRevision(filePath);
  });

  ipcMain.handle(
    'ext:deleteRevision',
    (_event, filePath: string, revisionPath: string) => {
      assertWithinAllowedRoot(filePath);
      return deleteRevision(filePath, revisionPath);
    }
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
    (_event, filePath: string, revisionPath: string) => {
      assertWithinAllowedRoot(filePath); // rewrites the file itself
      return restoreRevision(filePath, revisionPath);
    }
  );

  ipcMain.handle('ext:cleanupRevisions', (_event, maxAgeDays: number) => {
    // The renderer passes the configured location roots; clean each one.
    const roots = getAllowedRoots();
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

/** Reads the built-in extension registry from the packaged dist folder. */
async function loadExtensionRegistry(): Promise<ExtensionRegistry | null> {
  const registryPath = path.join(
    __dirname,
    '..',
    'extensions',
    'registry.json'
  );
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
