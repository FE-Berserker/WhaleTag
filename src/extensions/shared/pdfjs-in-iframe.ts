/**
 * Shared pdfjs-in-iframe session, consumed by both `pdf-viewer` and
 * `office-viewer`. Deduplicates the asset-fetch bridge, the
 * `HostBinaryDataFactory`, the render loop, theme helpers, and the i18n
 * subset between the two extensions.
 *
 * Build / runtime contract:
 * - This file lives under `src/extensions/shared/` and is webpacked-inlined
 *   into each consumer's `bundle.js` via `import { ... } from
 *   '../shared/pdfjs-in-iframe'` (build-extensions.js excludes `shared/`
 *   from entry discovery but webpack's module resolver still inlines
 *   relative imports). No cross-extension runtime fetching.
 * - The shared module owns its own `pdfjsWorker` side-effect import (see
 *   `globalThis.pdfjsWorker = pdfjsWorker` below) — same fake-worker trick
 *   used in pdf-viewer/index.ts:2-11 to run pdfjs's parser on the iframe's
 *   main thread, avoiding the `worker-src` CSP requirement.
 *
 * API design rationale:
 * - Host message routing goes through `session.handleHostMessage(msg)` rather
 *   than registering its own `window.whaleExt.onMessage` listener, to avoid
 *   multiple-listener ordering surprises. Each consumer's onMessage handler
 *   calls `handleHostMessage` first and breaks on `true`.
 * - Cancellation is token-based: caller passes `getToken: () => number` and
 *   bumps the token on file switch / extension teardown. The session
 *   snapshots the token at `renderPdfBytes` entry and re-checks after each
 *   `await`; mismatch → cleanup + return.
 * - `requestAsset` adds a 30s default timeout (configurable via the test
 *   hook `__setAssetRequestTimeoutForTest`). The previous implementation
 *   leaked forever if the host IPC dropped the response (e.g. crash). 30s
 *   is generous for cmap / font / wasm bytes (typically <100ms) but short
 *   enough to surface real failures quickly.
 * - Per-page lifecycle is wrapped in `try/finally` (Phase 1 §B2): if
 *   `page.render().promise` rejects, the page proxy is still cleaned up via
 *   `PDFPageProxy.cleanup()` (a synchronous boolean return — the older
 *   `.catch()` calls were a copy-paste from `destroy()` paths and were
 *   runtime `TypeError`s).
 * - pdf-viewer and office-viewer used to ship two parallel render loops
 *   (Phase 1 §B1). Now they share `session.renderPdfBytes`; the differences
 *   (per-page rotation map, fit-mode displayScale, data-* stashing) live in
 *   the `onAfterPageRender` hook the consumer passes in.
 */
import * as pdfjsLibDefault from 'pdfjs-dist/legacy/build/pdf.mjs';
import { TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';
// pdfjs worker: this import registers `WorkerMessageHandler` for its side
// effect. Whether pdfjs then runs it as a *fake* worker (on the iframe's
// main thread, by assigning `globalThis.pdfjsWorker`) or as a *real* Worker
// (off the main thread, by setting `GlobalWorkerOptions.workerSrc`) is
// decided per-session in `createPdfjsSession` from the `useWorker` option
// (see the worker-config block there). Real-worker mode moves the document
// parse off the main thread, which is what keeps large-PDF open from
// freezing the iframe.
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import type { HostMessage, PdfAssetMessage } from '../../shared/extension-types';

// ── Types ────────────────────────────────────────────────────────────────

type AssetKind = 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl';

/**
 * Subset of the PDF /Info dictionary + /Lang that pdf-viewer actually
 * uses. Returned by `onDocumentLoaded` so consumers can react to the
 * document's actual language (instead of the host UI locale) — e.g.
 * set `<html lang="zh-CN">` when the PDF declares its content is in
 * Simplified Chinese, which lets the browser pick CJK fonts for the
 * TextLayer, screen-readers pronounce text correctly, and
 * `:lang(zh)` CSS selectors fire.
 *
 * Fields are all nullable: not every PDF has /Info populated, and
 * `/Lang` is optional in the PDF 1.4+ spec.
 */
export interface PdfDocumentInfo {
  /** RFC 1766 language tag from the document catalog `/Lang` entry, e.g.
   *  `'en-US'`, `'zh-CN'`, `'fr-FR'`. Undefined for PDFs without it. */
  lang?: string;
  /** Document title (`/Title`). */
  title?: string;
  /** Document author (`/Author`). */
  author?: string;
}

/**
 * Minimal structural type for the pdfjs module. Lets the test suite inject a
 * stub without depending on the real (pdfjs-dist 6.x) typings. The real
 * module satisfies this type; tests pass a hand-rolled mock.
 *
 * The session only accesses `.promise` off the loading task returned by
 * `getDocument`, so we keep the interface narrow. The real
 * `PDFDocumentLoadingTask` has 10+ internal properties (`_capability`,
 * `_transport`, `_worker`, `onProgress`, etc.) that shouldn't be part of
 * this contract.
 */
export interface PdfjsLike {
  /** TypeScript method syntax → bivariant parameter check, so the real
   *  `pdfjsLibDefault.getDocument(src?: DocumentInitParameters)` is
   *  assignable even though `Record<string, unknown>` is wider than
   *  `DocumentInitParameters`. A property-style `getDocument: (opts:
   *  Record<string, unknown>) => ...` would fail under strict function types. */
  getDocument(opts: Record<string, unknown>): {
    promise: Promise<unknown>;
  };
}

export interface PdfjsSessionOptions {
  /** Container <div> the rendered <canvas>es are appended to. Required. */
  pagesEl: HTMLDivElement;
  /** Cancellation token getter — session aborts in-flight work when the
   *  returned value differs from the snapshot taken at `renderPdfBytes`
   *  entry. Both pdf-viewer (`state.loadToken`) and office-viewer
   *  (`renderToken`) wire their existing counter into this getter. */
  getToken: () => number;
  /** Extra `getDocument()` options merged in after defaults. Caller cannot
   *  override `data` / `BinaryDataFactory` / `isEvalSupported`. */
  getDocumentExtras?: Omit<
    Parameters<typeof pdfjsLibDefault.getDocument>[0],
    'data' | 'BinaryDataFactory' | 'isEvalSupported'
  >;
  /** Optional status callback for caller-driven UI (loading bar / error display). */
  onStatus?: (msg: {
    kind: 'progress' | 'error' | 'idle';
    text: string;
  }) => void;
  /** Optional per-page hook fired once after each canvas has been painted
   *  (Phase 1 §B1). Used by pdf-viewer to stamp `data-page-num / data-base-w
   *  / data-base-h` + apply initial CSS width; office-viewer ignores it. */
  onAfterPageRender?: (
    pageNum: number,
    canvas: HTMLCanvasElement,
    baseVp: { width: number; height: number },
    doc: pdfjsLibDefault.PDFDocumentProxy,
  ) => void;
  /** Optional hook fired once after `getDocument.promise` resolves, with
   *  the total page count and a slim metadata summary. Lets consumers
   *  (pdf-viewer) update their "X of N" / page-input-max UI *before* the
   *  first page has rendered, and apply PDF-level metadata like the
   *  document language (`Lang`) so the iframe's `html[lang]` reflects
   *  the PDF content's language, not the UI locale. Not fired if
   *  `getDocument` fails or is cancelled. */
  onDocumentLoaded?: (
    pageCount: number,
    info: PdfDocumentInfo
  ) => void;
  /** Output pixel scale per page. Default `min(devicePixelRatio, 2) * 1.5`,
   *  matches both callers' previous hard-coded formula. */
  outputScale?: () => number;
  /** Optional callback returning the CSS display scale for a page, given
   *  the unscaled (scale=1) viewport dimensions. The canvas is rendered at
   *  `outputScale * display` pixels and CSS-sized to match `display`.
   *  The TextLayer (added Phase 2) uses `display` directly so its span
   *  coordinates match the visible canvas. pdf-viewer passes its
   *  `computeDisplayScale`; office-viewer returns the current zoom. */
  computeDisplayScale?: (
    baseVp: { width: number; height: number },
    rotation?: number,
  ) => number;
  /** Inject a pdfjs module stub. Default = the real `pdfjs-dist` import.
   *  Tests pass a hand-rolled mock that satisfies `PdfjsLike`. */
  pdfjsLib?: PdfjsLike;
  /** Enable virtualized (lazy) page rendering (Phase 2). When true, only
   *  pages near the viewport (±`virtualizeBuffer`) have canvas + TextLayer;
   *  other pages have placeholder divs with estimated height. Default:
   *  false (full pre-render legacy behavior). pdf-viewer passes `true`;
   *  office-viewer keeps `false` (few pages, simpler without). */
  virtualize?: boolean;
  /** Number of extra pages to render ahead of / behind the current viewport
   *  when `virtualize` is true. Default 5. */
  virtualizeBuffer?: number;
  /** Run pdfjs's document parser on a real Worker instead of the fake-worker
   *  main-thread path, so parsing a large PDF doesn't block the iframe's
   *  main thread. When true, `workerSrc` MUST point at a copy of
   *  `pdfjs-dist/legacy/build/pdf.worker.mjs` the iframe can load
   *  (pdf-viewer ships one at `whale-extension://pdf-viewer/pdf.worker.mjs`,
   *  copied by `scripts/build-extensions.js`) and the iframe's CSP
   *  `worker-src` must allow that origin. Default false keeps the legacy
   *  fake-worker behavior used by office-viewer. */
  useWorker?: boolean;
  /** URL to the pdf.worker module; used only when `useWorker` is true. */
  workerSrc?: string;
}

export interface PdfjsSession {
  /** Decode + render all pages of `bytes` into the `pagesEl` container.
   *  Bumps internal cancellation token; bumps-on-second-call cancel
   *  (because the new snapshot no longer matches the old in-flight work).
   *  Resolves when the entire document has been rendered (or rejects on
   *  decode / render error). */
  renderPdfBytes(bytes: Uint8Array): Promise<void>;
  /** Stream + render a PDF from a URL via pdfjs's Range path (pdfjs pulls
   *  bytes on demand). Currently UNUSED at the call sites: pdf-viewer tried
   *  `getDocument({url: 'whale-file://…'})` but Chromium's CORS policy
   *  blocks cross-origin fetch to custom schemes (only http/https/data/
   *  chrome are allowed), so it failed with `net::ERR_FAILED` from the
   *  `whale-extension://` origin. pdf-viewer instead uses `renderPdfBytes`
   *  with bytes shipped via postMessage (Uint8Array structured clone — see
   *  `requestFileBytes`/`fileBytes`). Kept + unit-tested for the day a
   *  fetch-able scheme exists; lifecycle matches `renderPdfBytes`. */
  renderPdfUrl(url: string): Promise<void>;
  /** Re-render a single page at a new rotation (Phase 1 §B1). The session
   *  tears down the existing canvas and paints a fresh one. */
  rerenderPage(pageNum: number, newRotation: number): Promise<void>;
  /** Cancel any in-flight render. Equivalent to bumping the caller's token. */
  cancel(): void;
  /** Permanently tear down: cancel + reject all pending asset requests +
   *  release the current `PDFDocumentProxy`'s worker references. Async to
   *  give the doc `cleanup()` (a `Promise<any>`) a chance to complete. */
  destroy(): Promise<void>;
  /** Returns `true` when the host message was handled by the session (i.e.
   *  `pdfAsset` reply consumed). Callers should `if (session.handleHostMessage(msg)) break;`
   *  at the top of their `pdfAsset` case in onMessage. */
  handleHostMessage(msg: HostMessage): boolean;
}

type PendingResolver = {
  resolve: (data: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Default asset request timeout (ms). */
const ASSET_REQUEST_TIMEOUT_DEFAULT_MS = 30_000;

// ── Exported helpers ────────────────────────────────────────────────────

/**
 * Theme detection from the OS preference. Used at iframe boot to match the
 * host's theme BEFORE the first `setTheme` arrives (avoids white flash on
 * dark hosts — see docs/09 §16.9).
 */
export function detectInitialTheme(): 'light' | 'dark' {
  try {
    if (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    ) {
      return 'dark';
    }
  } catch {
    // jsdom / older browsers: fall through to 'light'
  }
  return 'light';
}

/** Apply theme by setting `data-theme` on `<body>`. Caller owns CSS rules. */
export function applyTheme(theme: 'light' | 'dark') {
  document.body.setAttribute('data-theme', theme);
}

/**
 * i18n subset shared by both pdf-viewer and office-viewer. Six keys, two
 * locales. EN `failedRender` is the pdf-viewer wording (`PDF render failed: {msg}`)
 * — clearer subject-first phrasing; office-viewer's old `Failed to render PDF: {msg}`
 * is unified to this on refactor.
 */
export interface PdfjsLocaleSubset {
  loading: string;
  failedDecode: string;
  rendering: string; // {cur}/{total}
  failedRender: string; // {msg}
  zoomIn: string;
  zoomOut: string;
}

export const PDFJS_I18N: Record<'en' | 'zh', PdfjsLocaleSubset> = {
  en: {
    loading: 'Loading…',
    failedDecode: 'Failed to decode PDF.',
    rendering: 'Rendering {cur} / {total}…',
    failedRender: 'PDF render failed: {msg}',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
  },
  zh: {
    loading: '加载中…',
    failedDecode: 'PDF 解码失败。',
    rendering: '正在渲染 {cur} / {total}…',
    failedRender: 'PDF 渲染失败:{msg}',
    zoomIn: '放大',
    zoomOut: '缩小',
  },
};

// ── Factory ──────────────────────────────────────────────────────────────

/**
 * Default output scale: min(devicePixelRatio, 2) * 1.5. Matches the previous
 * hard-coded formula in both pdf-viewer and office-viewer.
 *
 * Exported (Phase 1 §A1) so pdf-viewer can `import { defaultOutputScale as outputScale }`
 * instead of declaring its own copy — a previous version did the latter, which
 * (a) duplicated the formula and (b) drifted into a `ReferenceError` when the
 * local copy was deleted and three call sites kept the bare name.
 */
export function defaultOutputScale(): number {
  return Math.min(window.devicePixelRatio || 1, 2) * 1.5;
}

/**
 * pdfjs binary-data factory that pulls cmap / font / wasm bytes from the
 * host instead of fetching them. pdfjs instantiates with
 * `new BinaryDataFactory({cMapUrl, standardFontDataUrl, wasmUrl})` and calls
 * `.fetch({kind, filename})` (pdfjs-dist/legacy/build/pdf.mjs:21847); MUST be
 * a CLASS (not an instance), otherwise pdfjs throws
 * `TypeError: binaryDataFactory is not a constructor` on getDocument.
 *
 * Exported so callers can pass it directly to `pdfjsLib.getDocument({BinaryDataFactory})`
 * — mirroring the previous private class in pdf-viewer/index.ts:58-73 and
 * office-viewer/index.ts:50-63.
 */
export class HostBinaryDataFactory {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(_opts: any) {
    // URLs are placeholders; the real lookup is keyed by kind + filename.
  }

  async fetch({
    kind,
    filename,
  }: {
    kind: AssetKind;
    filename: string;
  }): Promise<Uint8Array> {
    return requestAsset(kind, filename);
  }
}

/**
 * Module-level (per-document, but kept module-level for simplicity — only
 * one pdf-viewer / office-viewer is active at a time per iframe) asset
 * request registry. Keyed by requestId (`a${n}` — pdf-asset namespace).
 * Each entry has a timeout (default 30s, configurable via the test hook
 * `__setAssetRequestTimeoutForTest`) that rejects and removes the entry if
 * the host doesn't reply.
 */
const pendingAssets = new Map<string, PendingResolver>();
let assetReqId = 0;
let assetRequestTimeoutMs = ASSET_REQUEST_TIMEOUT_DEFAULT_MS;

/**
 * Test hook: override the asset request timeout. Returns a restore function.
 * Production code MUST NOT call this. Used by `pdfjs-in-iframe.test.ts` to
 * verify the timeout path without waiting the full 30s.
 */
export function __setAssetRequestTimeoutForTest(
  ms: number,
): () => void {
  const prev = assetRequestTimeoutMs;
  assetRequestTimeoutMs = ms;
  return () => {
    assetRequestTimeoutMs = prev;
  };
}

function requestAsset(kind: AssetKind, filename: string): Promise<Uint8Array> {
  const requestId = `a${(assetReqId += 1)}`;
  return new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(() => {
      const p = pendingAssets.get(requestId);
      if (p) {
        pendingAssets.delete(requestId);
        p.reject(new Error('pdf asset request timeout'));
      }
    }, assetRequestTimeoutMs);
    pendingAssets.set(requestId, { resolve, reject, timer });
    window.whaleExt.postMessage({ type: 'requestPdfAsset', requestId, kind, filename });
  });
}

/**
 * Create a pdfjs session. The returned object is the entire surface — no
 * global state, no event emitter. Caller drives cancellation via the token
 * getter and message handling via `handleHostMessage`.
 */
export function createPdfjsSession(opts: PdfjsSessionOptions): PdfjsSession {
  const {
    pagesEl,
    getToken,
    getDocumentExtras,
    onStatus,
    onAfterPageRender,
    onDocumentLoaded,
    outputScale = defaultOutputScale,
    computeDisplayScale,
    pdfjsLib = pdfjsLibDefault,
    virtualize = false,
    virtualizeBuffer = 5,
    useWorker = false,
    workerSrc,
  } = opts;

  // Worker configuration (once per session). Real-worker mode sets
  // `GlobalWorkerOptions.workerSrc` so pdfjs spawns a dedicated Worker for
  // the document parse, moving the heavy CPU work off the iframe's main
  // thread (the large-PDF freeze). Fake-worker mode (the default, used by
  // office-viewer) instead pins `globalThis.pdfjsWorker` so pdfjs runs the
  // parser inline — no `worker-src` CSP needed. pdf-viewer and office-viewer
  // live in separate iframes with separate bundles, so their
  // `GlobalWorkerOptions` / `globalThis.pdfjsWorker` don't interfere.
  if (useWorker && workerSrc) {
    const lib = pdfjsLib as unknown as {
      GlobalWorkerOptions?: { workerSrc?: string };
    };
    if (lib.GlobalWorkerOptions) {
      lib.GlobalWorkerOptions.workerSrc = workerSrc;
    }
  } else {
    (globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = pdfjsWorker;
  }

  let destroyed = false;
  let currentToken = -1;
  let currentDoc: pdfjsLibDefault.PDFDocumentProxy | null = null;

  // Virtualization state.
  let intersectionObserver: IntersectionObserver | null = null;
  const renderedPages = new Set<number>();

  function isCancelled(): boolean {
    return destroyed || currentToken !== getToken();
  }

  
  /**
   * Render (or re-render) a single page's canvas + TextLayer inside its
   * container (`<div data-page-container>`, which already exists in the
   * DOM from the placeholder step for virtualized mode, or is created on
   * the fly for non-virtualized mode). The container's inner HTML is
   * cleared first so stale canvas / textLayer are removed.
   *
   * Used by the virtualized lazy-render path, `rerenderPage`, and the
   * non-virtualized full pre-render loop. One code path for all three.
   */
  async function renderPageContent(
    pageNum: number,
    newRotation?: number,
  ): Promise<void> {
    const doc = currentDoc;
    if (!doc) return;
    let page: pdfjsLibDefault.PDFPageProxy | null = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      page = await doc.getPage(pageNum);
      if (isCancelled()) return;
      const scale = outputScale();
      const baseVp = page.getViewport({ scale: 1 });
      const rotation = newRotation ?? 0;
      const viewport = page.getViewport({ scale, rotation });

      // Recycle: drop the placeholder (or stale) container entirely and
      // create a brand-new one with the bare-minimum CSS. Trying to
      // `cssText = '...inline-block...'` on the placeholder in-place left
      // the browser caching the old `width: 100%; height: ${estHeight}px`
      // dimensions from `renderVirtualized`, which is what produced both
      // observed symptoms of the Phase 2 §A3 bug (a) the previous fix's
      // "narrow vertical strips" (canvas-`max-width: 100%` circular ref
      // collapsed the inline-block parent to ~0) and (b) my replacement's
      // "full-width but ~22px tall strips" (a re-used inline-block child
      // in a `align-items: center` flex column got stretched to the
      // parent's full width while keeping the placeholder's tiny height).
      // Destroy + recreate sidesteps both: the new container has no
      // inherited inline styles, no caching from the placeholder phase,
      // and shrink-wraps to the canvas immediately.
      const oldContainer = pagesEl.querySelector(
        `div[data-page-container="${pageNum}"]`,
      );
      if (oldContainer) oldContainer.remove();

      const container = document.createElement('div');
      container.setAttribute('data-page-container', String(pageNum));
      // `flex-shrink: 0` is the Phase 2 §A3 keystone. `#pages` is a
      // `flex-direction: column` container that — for a normal Electron
      // window — is only ~one viewport tall (body → flex column →
      // toolbar + pages + status). The default `flex-shrink: 1` on
      // flex items means a 16-page PDF's containers get averaged into
      // 1/16 of `#pages`'s height (e.g. ~52px each), and the canvas
      // inside (which is 841.89px tall) gets clipped by the container's
      // `overflow: hidden` to the top 52px sliver — exactly the
      // "16 pages squished into thin strips" the user reported. With
      // `flex-shrink: 0`, the containers overflow `#pages` naturally
      // and the user scrolls to see them, with every page at its full
      // natural size.
      container.style.cssText =
        'position: relative; display: inline-block; overflow: hidden; flex-shrink: 0;';
      pagesEl.appendChild(container);

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      // Set BOTH CSS `width` AND `height` explicitly to `baseVp` (the
      // page's native dimensions, NOT the `outputScale`-scaled internal
      // bitmap size — the bitmap is the internal resolution set by
      // `canvas.width` / `canvas.height` attributes above). We previously
      // relied on `aspect-ratio` CSS to compute the display height from
      // the width, but Chromium resolves replaced-element intrinsic
      // dimensions (`canvas.width/height` attrs) BEFORE the CSS
      // `aspect-ratio` property, so for `<canvas>` the `aspect-ratio`
      // rule effectively gets ignored — the canvas's CSS height was
      // collapsing to its intrinsic ratio scaled by the (small) CSS
      // width, leaving the rendered canvas at ~22px tall (Phase 2
      // §A3, the "16 pages squished" symptom). Explicit `width` AND
      // `height` cut that intrinsic-ratio fallback out of the loop.
      // `onAfterPageRender` will overwrite `width` with
      // `baseVp.width * displayScale` shortly; height is left at the
      // natural page height so the aspect ratio is preserved through
      // the relayout path.
      canvas.style.display = 'block';
      canvas.style.width = `${baseVp.width}px`;
      canvas.style.height = `${baseVp.height}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      container.appendChild(canvas);

      // eslint-disable-next-line no-await-in-loop
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      onAfterPageRender?.(
        pageNum,
        canvas,
        { width: baseVp.width, height: baseVp.height },
        doc,
      );

      // TextLayer (Phase 2).
      if (!isCancelled()) {
        try {
          const textContent = await page.getTextContent();
          if (isCancelled()) return;
          const display =
            computeDisplayScale?.({ width: baseVp.width, height: baseVp.height }, rotation) ?? 1;
          const textVp = page.getViewport({ scale: display, rotation });
          const textLayerDiv = document.createElement('div');
          textLayerDiv.className = 'textLayer';
          container.appendChild(textLayerDiv);
          const textLayer = new TextLayer({
            textContentSource: textContent,
            container: textLayerDiv,
            viewport: textVp,
          });
          await textLayer.render();
        } catch {
          // Text layer failure non-fatal.
        }
      }
    } finally {
      page?.cleanup();
    }
  }

  /**
   * Build the `getDocument` loading task. Base params (cmap / font / wasm /
   * `BinaryDataFactory`) are constant; `extra` carries the data source:
   * `{data: bytes}` for the in-memory path (office-viewer's LibreOffice
   * conversion) or `{url, rangeChunkSize, disableRange}` for the streaming
   * path (pdf-viewer's `whale-file://` URL).
   */
  function buildLoadingTask(extra: Record<string, unknown>): {
    promise: Promise<unknown>;
  } {
    return pdfjsLib.getDocument({
      cMapPacked: true,
      cMapUrl: 'cmap/',
      standardFontDataUrl: 'font/',
      wasmUrl: 'wasm/',
      isEvalSupported: false,
      BinaryDataFactory: HostBinaryDataFactory,
      ...getDocumentExtras,
      ...extra,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  /**
   * Shared render lifecycle from the resolved `PDFDocumentProxy` onward:
   * cancellation check → metadata (/Info + /Lang) → onDocumentLoaded →
   * virtualized or full pre-render loop → finally `doc.cleanup()`. Used by
   * both `renderPdfBytes` (in-memory bytes) and `renderPdfUrl` (streaming
   * URL). Errors from `loadingTask.promise` are surfaced via `onStatus`
   * (when this call is still current) and re-thrown for the caller.
   */
  async function runRender(
    loadingTask: { promise: Promise<unknown> },
    myToken: number,
  ): Promise<void> {
    let doc: pdfjsLibDefault.PDFDocumentProxy;
    try {
      doc = (await loadingTask.promise) as pdfjsLibDefault.PDFDocumentProxy;
    } catch (e) {
      if (myToken === currentToken) {
        onStatus?.({
          kind: 'error',
          text:
            e instanceof Error
              ? e.message
              : String(e),
        });
      }
      throw e;
    }

    if (isCancelled()) {
      // Phase 1 §A2: `cleanup` is the right method (returns `Promise<any>`).
      // The old `destroy()` was a type error AND a no-op at runtime.
      await doc.cleanup().catch(() => undefined);
      return;
    }
    currentDoc = doc;
    // Pull /Info + /Lang. `getMetadata()` reads the XMP + document
    // catalog; both are optional in the spec, so every field is nullable.
    // Wrapped in a try/catch — if the doc's trailer is malformed the
    // metadata call can throw on pdfjs-dist 6.x, and we don't want to
    // block the whole render. The caller falls back to UI locale when
    // `lang` is undefined.
    let info: PdfDocumentInfo = {};
    try {
      const meta = await doc.getMetadata();
      const infoDict = (meta?.info ?? {}) as {
        Lang?: string;
        Title?: string;
        Author?: string;
      };
      info = {
        lang:
          typeof infoDict.Lang === 'string' && infoDict.Lang.trim()
            ? infoDict.Lang.trim()
            : undefined,
        title:
          typeof infoDict.Title === 'string' ? infoDict.Title : undefined,
        author:
          typeof infoDict.Author === 'string' ? infoDict.Author : undefined,
      };
    } catch {
      // Swallow — leave info empty, consumer falls back.
    }
    onDocumentLoaded?.(doc.numPages, info);
    const scale = outputScale();

    if (virtualize) {
      await renderVirtualized(doc, scale, myToken);
      return;
    }

    try {
      for (let n = 1; n <= doc.numPages; n += 1) {
        if (isCancelled()) return;
        await renderPageContent(n);
        if (isCancelled()) return;
        if (n < doc.numPages) {
          onStatus?.({
            kind: 'progress',
            text: `${n + 1} / ${doc.numPages}`,
          });
        } else {
          onStatus?.({ kind: 'progress', text: '' });
        }
      }
    } finally {
      // Phase 1 §A2 + §B2: release worker references + ensure the doc is
      // cleaned up even if the loop throws. The original error is NOT
      // swallowed here — `runRender` lets it bubble up to the caller
      // (which surfaces it via `onStatus({kind:'error'})`).
      await doc.cleanup().catch(() => undefined);
      if (currentDoc === doc) currentDoc = null;
    }
  }

  async function renderPdfBytes(bytes: Uint8Array): Promise<void> {
    currentToken = getToken();
    const myToken = currentToken;
    pagesEl.innerHTML = '';
    onStatus?.({ kind: 'progress', text: '' });

    let loadingTask: { promise: Promise<unknown> };
    try {
      loadingTask = buildLoadingTask({ data: bytes });
    } catch (e) {
      if (myToken === currentToken) {
        onStatus?.({
          kind: 'error',
          text:
            e instanceof Error
              ? e.message
              : String(e),
        });
      }
      throw e;
    }
    await runRender(loadingTask, myToken);
  }

  /**
   * Stream + render a PDF from a URL via pdfjs's Range path. UNUSED at the
   * call sites — pdf-viewer hit Chromium's CORS block on
   * `fetch(whale-file://)` (custom schemes aren't in the cross-origin
   * fetch allow-list) and fell back to `renderPdfBytes` with postMessage
   * bytes. Kept for a future fetch-able scheme; see `renderPdfUrl` on
   * `PdfjsSession`.
   */
  async function renderPdfUrl(url: string): Promise<void> {
    currentToken = getToken();
    const myToken = currentToken;
    pagesEl.innerHTML = '';
    onStatus?.({ kind: 'progress', text: '' });

    let loadingTask: { promise: Promise<unknown> };
    try {
      loadingTask = buildLoadingTask({
        url,
        rangeChunkSize: 65536,
        disableRange: false,
      });
    } catch (e) {
      if (myToken === currentToken) {
        onStatus?.({
          kind: 'error',
          text:
            e instanceof Error
              ? e.message
              : String(e),
        });
      }
      throw e;
    }
    await runRender(loadingTask, myToken);
  }

  /**
   * Virtualized render: creates placeholder divs for all pages (estimated
   * height based on the first page's baseVp × displayScale), renders the
   * first (buffer + 1) pages immediately, then drives the rest via
   * IntersectionObserver as the user scrolls.
   */
  async function renderVirtualized(
    doc: pdfjsLibDefault.PDFDocumentProxy,
    _scale: number,
    _myToken: number,
  ): Promise<void> {
    // Disconnect any previous observer (stale render).
    intersectionObserver?.disconnect();
    intersectionObserver = null;
    renderedPages.clear();

    // A) Estimate page dimensions from page 1's baseVp.
    const firstPage = await doc.getPage(1);
    if (isCancelled()) {
      firstPage.cleanup();
      return;
    }
    const baseVp1 = firstPage.getViewport({ scale: 1 });
    const dispScale = computeDisplayScale?.({ width: baseVp1.width, height: baseVp1.height }) ?? 1;
    const estWidth = baseVp1.width * dispScale;
    const estHeight = baseVp1.height * dispScale;
    firstPage.cleanup();

    // B) Create placeholder divs for ALL pages at the estimated height.
    // `width: 100%` makes the placeholder fill #pages' width so the
    // scrollbar's horizontal range is correct from the start; the actual
    // rendered container (in `renderPageContent`) is a *different* DOM
    // node — the placeholder is removed and a fresh inline-block
    // container is created when the IntersectionObserver fires. This
    // sidesteps the Phase 2 §A3 bug where reusing the placeholder's
    // styled container left inherited `width: 100%` and stale dimensions
    // in place (see `renderPageContent` for the full write-up).
    const heightPxStr = `${estHeight}px`;
    for (let n = 1; n <= doc.numPages; n += 1) {
      if (isCancelled()) return;
      const container = document.createElement('div');
      container.setAttribute('data-page-container', String(n));
      // `flex-shrink: 0` matches the rendered container's rule — see
      // the long comment in `renderPageContent`. Without it, the
      // placeholders themselves would be averaged into 1/N of
      // `#pages`'s height during the initial virtualized render
      // (before the IntersectionObserver fires), and the scrollbar
      // would be wrong.
      container.style.cssText =
        `position:relative; display:inline-block; overflow:hidden; ` +
        `width:100%; height:${heightPxStr}; flex-shrink:0;`;
      pagesEl.appendChild(container);
    }
    onStatus?.({ kind: 'progress', text: '' }); // loading complete

    // C) Set up intersection observer with rootMargin to pre-render
    // buffer pages before they enter the viewport.
    const marginPx = virtualizeBuffer * estHeight;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const n = Number((entry.target as HTMLElement).getAttribute('data-page-container'));
          if (!n || renderedPages.has(n) || isCancelled()) continue;
          renderedPages.add(n);
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          renderPageContent(n).catch(() => undefined);
        }
      },
      {
        root: pagesEl,
        rootMargin: `${marginPx}px 0px ${marginPx}px 0px`,
        threshold: 0,
      },
    );
    pagesEl.querySelectorAll('div[data-page-container]').forEach((el) => io.observe(el));
    intersectionObserver = io;

    // D) Immediately render the first (buffer + 1) pages.
    for (let n = 1; n <= Math.min(virtualizeBuffer + 1, doc.numPages); n += 1) {
      renderedPages.add(n);
      await renderPageContent(n);
      if (isCancelled()) return;
      if (n < doc.numPages) {
        onStatus?.({
          kind: 'progress',
          text: `${n + 1} / ${doc.numPages}`,
        });
      } else {
        onStatus?.({ kind: 'progress', text: '' });
      }
    }
  }

    /**
   * Re-render a single page with a new rotation. Used by pdf-viewer's rotate
   * buttons (Phase 1 §B1). Delegates to `renderPageContent` (Phase 2) which
   * handles both virtualized and non-virtualized mode identically: it finds
   * the existing container (or creates one), clears it, and builds a fresh
   * canvas + TextLayer with the new rotation.
   *
   * In virtualized mode: if the target page hasn't been rendered yet (the
   * IntersectionObserver hasn't caught up), mark it rendered and render
   * synchronously here so rotation feels immediate.
   */
  async function rerenderPage(
    pageNum: number,
    newRotation: number,
  ): Promise<void> {
    if (!currentDoc) return;
    if (virtualize) {
      renderedPages.add(pageNum);
    }
    await renderPageContent(pageNum, newRotation);
  }

  function cancel(): void {
    // Bumping the token invalidates in-flight work; the render loop will
    // bail on the next `isCancelled()` check.
    intersectionObserver?.disconnect();
    intersectionObserver = null;
    renderedPages.clear();
    currentToken = getToken() + 1;
  }

  async function destroy(): Promise<void> {
    destroyed = true;
    intersectionObserver?.disconnect();
    intersectionObserver = null;
    renderedPages.clear();
    cancel();
    // Reject all pending asset requests so they don't leak forever.
    for (const [id, p] of pendingAssets.entries()) {
      clearTimeout(p.timer);
      pendingAssets.delete(id);
      p.reject(new Error('session destroyed'));
    }
    if (currentDoc) {
      // Phase 1 §A2 + §D2: `cleanup` is async (returns `Promise<any>`) and
      // is the correct PDFDocumentProxy teardown. The old `destroy()` was
      // both a type error and a silent no-op at runtime — pdfjs warned but
      // never released the worker stream / font caches.
      await currentDoc.cleanup().catch(() => undefined);
      currentDoc = null;
    }
  }

  function handleHostMessage(msg: HostMessage): boolean {
    if (msg.type === 'pdfAsset') {
      const m = msg as PdfAssetMessage;
      const pending = pendingAssets.get(m.requestId);
      if (!pending) return true; // not ours / already settled
      clearTimeout(pending.timer);
      pendingAssets.delete(m.requestId);
      if (m.data) {
        pending.resolve(new Uint8Array(m.data));
      } else {
        pending.reject(new Error(m.error || 'asset not found'));
      }
      return true;
    }
    return false;
  }

  return {
    renderPdfBytes,
    renderPdfUrl,
    rerenderPage,
    cancel,
    destroy,
    handleHostMessage,
  };
}
