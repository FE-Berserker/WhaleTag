/**
 * Lazy loaders for heavyweight native bindings / large JS deps in the main
 * process, so the main bundle's cold start doesn't pay for imaging, EXIF, or
 * charset-detection code on sessions that never touch them.
 *
 * Each module is externalized in the main webpack config
 * (`.erb/configs/webpack.config.main.*.ts`) and loaded on first use via
 * `createRequire(__filename)` — the same pattern as `getPdfjs()` in
 * `thumbnail.ts` / `fulltext.ts`. `nodeRequire` resolves from the real bundle
 * path at runtime; webpack leaves `createRequire` alone under CommonJS (it
 * stubs it to `undefined` under ESM — see `.erb/configs/webpack.config.base.ts`
 * §esnext / docs/09 §19).
 *
 * `better-sqlite3` is intentionally NOT here — it's used on nearly every index
 * op, so eager-loading it is correct.
 */
import { createRequire } from 'module';

const nodeRequire = createRequire(__filename);

// sharp's callable factory is its default export (esModuleInterop synthesizes
// `.default` from `export = sharp`); the bare `typeof import('sharp')` namespace
// has no call signatures in type position, so extract the default — which IS
// callable, exactly like `import sharp from 'sharp'`.
type SharpFactory = typeof import('sharp')['default'];
let _sharp: SharpFactory | undefined;
/** sharp (libvips N-API). Powers every image/video/pdf/ebook/font thumbnail. */
export function getSharp(): SharpFactory {
  if (_sharp) return _sharp;
  _sharp = nodeRequire('sharp') as SharpFactory;
  return _sharp;
}

type CanvasLib = typeof import('@napi-rs/canvas');
let _canvas: CanvasLib | undefined;
/** @napi-rs/canvas (Cairo N-API). Used by pdf/font/drawio/excalidraw thumbnails
 *  and the one-off drag-fallback icon. */
export function getCanvas(): CanvasLib {
  if (_canvas) return _canvas;
  _canvas = nodeRequire('@napi-rs/canvas') as CanvasLib;
  return _canvas;
}

type ExifrLib = typeof import('exifr');
let _exifr: ExifrLib | undefined;
/** exifr (large multimedia EXIF parser). Only the Mapique GPS path uses it. */
export function getExifr(): ExifrLib {
  if (_exifr) return _exifr;
  _exifr = nodeRequire('exifr') as ExifrLib;
  return _exifr;
}

type ChardetLib = typeof import('jschardet');
let _chardet: ChardetLib | undefined;
/** jschardet (charset detection). Only `readTextFile` uses it. */
export function getChardet(): ChardetLib {
  if (_chardet) return _chardet;
  _chardet = nodeRequire('jschardet') as ChardetLib;
  return _chardet;
}

type IconvLib = typeof import('iconv-lite');
let _iconv: IconvLib | undefined;
/** iconv-lite (legacy charset decoding). Only `readTextFile` uses it. */
export function getIconv(): IconvLib {
  if (_iconv) return _iconv;
  _iconv = nodeRequire('iconv-lite') as IconvLib;
  return _iconv;
}
