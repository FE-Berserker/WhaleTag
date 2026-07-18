import path from 'path';
import { promises as fsp } from 'fs';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';
import { extractEbookCover } from './ebook-cover';
import { renderFontToPng } from './font-thumb';
import { getCanvas } from './lazy-native';
import { encodeImageThumb, THUMB_SIZE } from './thumb-encode';

/**
 * The three pure-JS CPU-heavy thumbnail renders (pdf / ebook / font),
 * moved out of `thumbnail.ts` so they can run inside the `whale-thumb`
 * utilityProcess (`thumb-worker.ts`) instead of on the main event loop.
 * Each returns the final JPEG thumbnail buffer; sizing/quality policy lives
 * in `thumb-encode.ts`.
 *
 * This module must stay free of `process.parentPort` / electron imports so
 * it can be loaded directly by tests and by the host's in-process fallback
 * (`thumb-worker-host.ts`, ELECTRON_RUN_AS_NODE) as well as by the worker.
 */

const nodeRequire = createRequire(__filename);
const pdfWorkerPath = nodeRequire.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
// pdfjs loads cmap / font data via fs.readFile, so these must be plain
// filesystem paths with a trailing "/" (forward slash; pdfjs validates it and
// Windows fs accepts forward separators), NOT file:// URLs — a file:// URL
// would ENOENT and silently blank standard fonts / CJK glyphs.
const pdfRootDir = path.join(path.dirname(pdfWorkerPath), '..', '..');
const pdfStandardFontDataUrl = path.join(pdfRootDir, 'standard_fonts') + '/';
// Predefined CMaps for decoding non-embedded CID-keyed CJK fonts.
const pdfCMapUrl = path.join(pdfRootDir, 'cmaps') + '/';

type PdfjsLib = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let _pdfjs: PdfjsLib | undefined;
/** Lazy-load pdfjs on first PDF thumbnail (not at process startup). The pdfjs
 *  module (~1MB+) and worker setup are deferred via nodeRequire (createRequire),
 *  which webpack leaves as a runtime require — bundling the .mjs would
 *  hard-code its import.meta.url and crash the process at load. */
function getPdfjs(): PdfjsLib {
  if (_pdfjs) return _pdfjs;
  const lib = nodeRequire('pdfjs-dist/legacy/build/pdf.mjs') as PdfjsLib;
  lib.GlobalWorkerOptions.workerSrc = pathToFileURL(pdfWorkerPath).href;
  _pdfjs = lib;
  return lib;
}

/**
 * Renders page 1 of `srcPath` via pdfjs-dist into a `@napi-rs/canvas`, then
 * encodes it as a JPEG thumbnail. Throws when the PDF is missing, encrypted,
 * or cannot render page 1 within the timeout.
 */
export async function renderPdfThumb(srcPath: string): Promise<Buffer> {
  const data = new Uint8Array(await fsp.readFile(srcPath));

  const loadingTask = getPdfjs().getDocument({
    data,
    useSystemFonts: true,
    cMapUrl: pdfCMapUrl,
    cMapPacked: true,
    standardFontDataUrl: pdfStandardFontDataUrl,
  });

  let doc: Awaited<typeof loadingTask.promise> | null = null;
  try {
    doc = await loadingTask.promise;
    const page = await doc.getPage(1);
    try {
      // Choose a viewport scale so the larger edge becomes a high-res source
      // for downscaling (quality is better than rendering at thumb size).
      const viewport = page.getViewport({ scale: 1 });
      const scale = THUMB_SIZE / Math.max(viewport.width, viewport.height);
      const scaled = page.getViewport({ scale: Math.max(scale, 1) });
      const canvas = getCanvas().createCanvas(scaled.width, scaled.height);
      const ctx = canvas.getContext('2d');
      await page.render({
        canvas: null,
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport: scaled,
      }).promise;
      const pngBuf = await canvas.encode('png');
      return encodeImageThumb(pngBuf);
    } finally {
      page.cleanup?.();
    }
  } finally {
    loadingTask.destroy?.().catch(() => undefined);
  }
}

/**
 * Extracts an ebook's embedded cover (see `ebook-cover.ts`) and hands the raw
 * image bytes to `encodeImageThumb` for uniform sizing/quality. Throws when the
 * book has no embedded cover or it can't be decoded.
 */
export async function renderEbookThumb(srcPath: string): Promise<Buffer> {
  return encodeImageThumb(await extractEbookCover(srcPath));
}

/**
 * Renders a font preview via `font-thumb.ts` to a PNG buffer, then resizes/
 * encodes it as a JPEG thumbnail. Throws when the font file cannot be
 * registered or rendered (corrupt/unsupported format).
 */
export async function renderFontThumb(srcPath: string): Promise<Buffer> {
  return encodeImageThumb(await renderFontToPng(srcPath));
}
