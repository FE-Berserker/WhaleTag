import path from 'path';
import { existsSync, promises as fsp } from 'fs';
import { ipcMain, clipboard } from 'electron';
import { createRequire } from 'module';
import {
  backupRevision,
  listRevisions,
  restoreRevision,
  cleanupRevisionsForLocation,
  deleteRevision,
} from '../revisions';
import { atomicWriteText, atomicWriteBytes } from '../atomic-write';
import { loadOfficePdf } from '../office-cache';
import { isSofficeAvailable } from '../office-binary';
import { convertDwgToDxf, dwg2dxfBinary, odaConverterBinary } from '../cad-convert';
import { convertEbookToEpub, ebookConvertBinary } from '../ebook-convert';
import { listArchive, readArchiveEntry, extractArchive } from '../archive';
import { getAllowedRoots, assertWithinAllowedRoot } from '../allowed-roots';
import type { ExtensionRegistry } from '../../shared/extension-types';

/**
 * Extension-system handlers (`ext:*` + `archive:*`): registry, revisions,
 * binary converters (office / dwg / ebook), bundled-asset readers, archive
 * decoder. Split out of the old god-registrar `ipc.ts` (docs/01 §12) —
 * behavior is verbatim.
 */

export function registerExtensionHandlers(): void {
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

  // §paste-image (md-editor): decode the data URL sent from the clipboard,
  // write the raw bytes into the .md's directory as image-<timestamp>.<ext>,
  // return the absolute path so the editor can insert ![](path).
  ipcMain.handle(
    'ext:saveImageToFile',
    async (_event, dataURL: string, dirPath: string, ext: string) => {
      const match = /^data:image\/[\w+.-]+;base64,(.+)$/.exec(dataURL);
      if (!match) throw new Error('saveImageToFile: invalid image data URL');
      const fullPath = path.join(dirPath, `image-${Date.now()}.${ext}`);
      assertWithinAllowedRoot(fullPath);
      // §paste-image — dirPath may be a per-md subfolder that doesn't exist
      // yet (subfolder image-save mode); create it recursively before writing.
      await fsp.mkdir(dirPath, { recursive: true });
      await atomicWriteBytes(fullPath, Buffer.from(match[1], 'base64'));
      return fullPath;
    }
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
      // Return the Buffer directly — Electron IPC serializes it as a Uint8Array
      // on the renderer, so the previous `new ArrayBuffer + .set(buf)` was a
      // redundant memcpy on every DWG open. The cad-viewer passes the DXF
      // bytes to the TextDecoder without re-wrapping. See docs/15 P1-4.
      return convertDwgToDxf(filePath, options);
    }
  );

  ipcMain.handle('ext:detectDwgConverters', async () => ({
    dwg2dxf: await dwg2dxfBinary(),
    oda: odaConverterBinary(),
  }));

  ipcMain.handle(
    'ext:convertEbookToEpub',
    async (_event, filePath: string, options?: { calibrePath?: string | null }) => {
      // Return the Buffer directly — Electron IPC serializes it as a Uint8Array
      // on the renderer, so the previous `new ArrayBuffer + .set(buf)` was a
      // redundant memcpy on every ebook open. The ebook-viewer passes the EPUB
      // bytes to loadEpub without re-wrapping. See docs/15 P1-4.
      return convertEbookToEpub(filePath, options);
    }
  );

  ipcMain.handle('ext:detectEbookConverter', async () => ({
    calibre: await ebookConvertBinary(),
  }));

  // docs/09 §16.16: office-viewer probes LibreOffice availability up front so it
  // can show install guidance (instead of a bare "soffice not found" dead-end)
  // before even attempting the doomed convert.
  ipcMain.handle(
    'ext:isSofficeAvailable',
    (_event, options?: { sofficePath?: string | null }) =>
      isSofficeAvailable(options?.sofficePath ?? null)
  );

  // md-editor context menu Paste: read the clipboard's text in the main
  // process (Electron clipboard is always readable — no Permissions-Policy
  // round trip like the iframe's Clipboard API would need).
  ipcMain.handle('ext:readClipboardText', () => clipboard.readText());

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
}

// ---------------------------------------------------------------------------
// Bundled-asset readers (pdfjs data files, CAD / HEIC wasm) + registry.
// ---------------------------------------------------------------------------

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
 * bundle lives in `dist/main/`, extensions in `dist/extensions/` (this file
 * is one level deeper — `ipc/` — hence the double `..`).
 */
// P3-5 (perf audit): the bundled wasm is immutable — cache the source bytes so
// reopening a CAD file doesn't re-read from disk. Still returns a fresh copy.
let _cadWasmBuf: Buffer | undefined;
async function readCadWasm(): Promise<ArrayBuffer> {
  const fullPath = path.join(
    __dirname,
    '..',
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
