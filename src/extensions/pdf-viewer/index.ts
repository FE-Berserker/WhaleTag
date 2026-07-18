import './viewer.css';
import {
  createPdfjsSession,
  detectInitialTheme,
  applyTheme as sessionApplyTheme,
  PDFJS_I18N,
  type PdfjsSession,
  type OutlineNode,
} from '../shared/pdfjs-in-iframe';

/**
 * Tier 3 (Phase §B) switch: run pdfjs's document parser on a real Worker so
 * parsing a large PDF doesn't block the iframe's main thread. The worker
 * module is copied next to the bundle by `scripts/build-extensions.js`
 * (`pdf.worker.mjs`, served at `whale-extension://pdf-viewer/pdf.worker.mjs`)
 * and the iframe CSP `worker-src` allows that origin (index.html).
 *
 * Default `false`: Tier 1+2 (whale-file:// streaming + pdfjs Range reads)
 * already eliminate the large-PDF freeze by removing the base64 round-trip
 * and loading bytes on demand. The real Worker is an additional improvement
 * (CPU parse off the main thread) but depends on `new Worker()` accepting
 * the `whale-extension://` privileged scheme — no prior art in this repo
 * (cad/heic fetch wasm, they don't spawn a Worker). Verify by opening a PDF
 * with this set to `true` and checking the browser Workers tab + console for
 * load/CSP errors. If the worker fails to spawn pdfjs rejects the load;
 * flip back to `false` to restore the fake-worker path (Tier 1+2 still apply).
 */
const USE_PDFJS_WORKER = false;
const PDFJS_WORKER_SRC = 'whale-extension://pdf-viewer/pdf.worker.mjs';

// --- DOM refs -------------------------------------------------------------
const pagesEl = document.getElementById('pages') as HTMLDivElement;

const prevBtn = document.getElementById('prev-page') as HTMLButtonElement;
const nextBtn = document.getElementById('next-page') as HTMLButtonElement;
const pageInput = document.getElementById('page-input') as HTMLInputElement;
const pageCountEl = document.getElementById('page-count') as HTMLSpanElement;
const fitWidthBtn = document.getElementById('fit-width') as HTMLButtonElement;
const fitPageBtn = document.getElementById('fit-page') as HTMLButtonElement;
const zoomOutBtn = document.getElementById('zoom-out') as HTMLButtonElement;
const zoomLevelEl = document.getElementById('zoom-level') as HTMLSpanElement;
const zoomInBtn = document.getElementById('zoom-in') as HTMLButtonElement;
const rotateLeftBtn = document.getElementById('rotate-left') as HTMLButtonElement;
const rotateRightBtn = document.getElementById('rotate-right') as HTMLButtonElement;

const sizeEl = document.getElementById('status-size') as HTMLSpanElement;
const statusPagesEl = document.getElementById('status-pages') as HTMLSpanElement;
const sizeLbl = document.getElementById('size-lbl') as HTMLSpanElement;
const pagesLbl = document.getElementById('pages-lbl') as HTMLSpanElement;
const loadingBarEl = document.getElementById('loading-bar') as HTMLDivElement;
const outlineToggleBtn = document.getElementById('outline-toggle') as HTMLButtonElement;
const outlineSidebarEl = document.getElementById('outline-sidebar') as HTMLDivElement;

// --- Shared pdfjs session -------------------------------------------------
// Phase 1 §B1: pdf-viewer no longer runs its own render loop. It delegates
// to `session.renderPdfBytes` and supplies an `onAfterPageRender` hook that
// stamps the per-page `data-page-num / data-base-w / data-base-h` attributes
// + initial CSS width that `relayoutPages()` and the rotation re-render
// path consume. `onDocumentLoaded` fires once after `getDocument.promise`
// resolves — we use it to set `state.pageCount` before the first page is
// rendered, so the "1 of N" toolbar UI is correct from the first paint.
// `beforeunload` calls `session.destroy()` to release the doc's worker
// stream + font caches (Phase 1 §A2 fix for the long-standing leak).
const session: PdfjsSession = createPdfjsSession({
  pagesEl,
  getToken: () => state.loadToken,
  onDocumentLoaded: (pageCount, info) => {
    state.pageCount = pageCount;
    // Apply the PDF's declared language (RFC 1766 tag from the document
    // catalog's `/Lang` entry, e.g. `zh-CN` / `en-US` / `fr-FR`) to the
    // iframe's `<html lang>`. This overrides the host UI locale that
    // `applyLocale()` set earlier — the PDF content's language matters
    // more for browser features than the chrome UI's language:
    //   - Chromium picks the right font-fallback chain (CJK fonts when
    //     `lang=zh*`, Arabic shaping when `lang=ar`, etc.).
    //   - Browser spell-checker uses the lang dictionary for selectable
    //     text in the TextLayer.
    //   - Screen readers pronounce words correctly.
    //   - CSS `:lang(zh)` / `:lang(ja)` selectors fire.
    // Falls back to the host UI locale when the PDF doesn't declare
    // `/Lang` (a common case — most PDFs omit it).
    if (info?.lang) {
      document.documentElement.lang = info.lang;
    }
    updateStatusBar();
    updatePageUi();
    void loadOutline();
  },
  onAfterPageRender: (pageNum, canvas, baseVp) => {
    canvas.setAttribute('data-page-num', String(pageNum));
    canvas.setAttribute('data-base-w', String(baseVp.width));
    canvas.setAttribute('data-base-h', String(baseVp.height));
    // Phase 2 §A3: the canvas lives in a fresh `display: inline-block`
    // container (built by `renderPageContent` after destroying the
    // placeholder — see the long comment there). We set BOTH width and
    // height (not just `width` + `aspect-ratio`) because Chromium
    // resolves the canvas's intrinsic size from the `canvas.width/height`
    // HTML attributes BEFORE the CSS `aspect-ratio` property, so for
    // `<canvas>` the aspect-ratio rule is effectively ignored — the
    // canvas's CSS height was collapsing to its intrinsic ratio scaled
    // by the CSS width. Setting both CSS `width` and `height` explicitly
    // cuts that fallback out.
    const ds = computeDisplayScale(baseVp.width, baseVp.height);
    canvas.style.width = `${baseVp.width * ds}px`;
    canvas.style.height = `${baseVp.height * ds}px`;
  },
  // Phase 2: TextLayer needs the same display scale pdf-viewer uses for
  // CSS layout so the invisible text spans align with the canvas. We
  // must pass rotation here too (renderOnePage is always rotation=0,
  // rerenderPage passes the actual rotation).
  computeDisplayScale: (baseVp) =>
    computeDisplayScale(baseVp.width, baseVp.height),
  virtualize: true,
  useWorker: USE_PDFJS_WORKER,
  workerSrc: PDFJS_WORKER_SRC,
  onStatus: ({ kind, text }) => {
    // The session drives its own per-page progress text (`'2 / 10'`); we
    // surface it through our localised "Rendering N of M…" template.
    if (kind === 'progress') {
      if (!text) {
        setLoadingBar('', 'progress');
        return;
      }
      const m = text.match(/^(\d+) \/ (\d+)$/);
      if (m) {
        setLoadingBar(
          T.rendering.replace('{cur}', m[1]).replace('{total}', m[2]),
          'progress'
        );
      } else {
        setLoadingBar(text, 'progress');
      }
    } else if (kind === 'error') {
      setLoadingBar(T.failedRender.replace('{msg}', text), 'error');
    }
  },
});
window.addEventListener('beforeunload', () => {
  void session.destroy().catch(() => undefined);
});

// --- State ----------------------------------------------------------------
type ZoomMode = 'manual' | 'fit-width' | 'fit-page';
const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;

interface State {
  fileSize: number | undefined;
  pageCount: number;
  currentPage: number;
  zoomMode: ZoomMode;
  manualZoom: number;
  // Per-page rotation in degrees (0/90/180/270).
  pageRotations: Map<number, number>;
  // Incremented on every load; in-flight renders check it before mutating UI.
  loadToken: number;
}

const state: State = {
  fileSize: undefined,
  pageCount: 0,
  currentPage: 1,
  zoomMode: 'manual',
  manualZoom: 1,
  pageRotations: new Map(),
  loadToken: 0,
};

function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

// --- i18n -----------------------------------------------------------------
interface Strings {
  loading: string;
  failedDecode: string;
  rendering: string; // {cur} / {total}
  failedRender: string; // {msg}
  zoomIn: string;
  zoomOut: string;
  prevPage: string;
  nextPage: string;
  pageNumber: string; // input aria-label / title
  fitWidth: string;
  fitPage: string;
  /** Short button label (the tooltip uses the longer `fitWidth`/`fitPage`). */
  fitWidthLabel: string;
  fitPageLabel: string;
  rotateLeft: string;
  rotateRight: string;
  size: string;
  pages: string;
  noValue: string;
  currentPage: string; // status: "Page X of Y"
  outlineToggle: string; // outline button title / aria-label
  outlineEmpty: string; // sidebar empty state
  pageOf: (cur: number, total: number) => string;
}

// 6 shared keys come from PDFJS_I18N (see shared/pdfjs-in-iframe.ts);
// the remaining 11 keys are pdf-viewer-specific.
const I18N: Record<string, Omit<Strings, 'pageOf'>> = {
  en: {
    ...PDFJS_I18N.en,
    prevPage: 'Previous page',
    nextPage: 'Next page',
    pageNumber: 'Page number',
    fitWidth: 'Fit width',
    fitPage: 'Fit page',
    fitWidthLabel: 'Fit W',
    fitPageLabel: 'Fit P',
    rotateLeft: 'Rotate left',
    rotateRight: 'Rotate right',
    size: 'Size',
    pages: 'Pages',
    noValue: '—',
    currentPage: 'Page {cur} of {total}',
    outlineToggle: 'Outline',
    outlineEmpty: 'No outline',
  },
  zh: {
    ...PDFJS_I18N.zh,
    prevPage: '上一页',
    nextPage: '下一页',
    pageNumber: '页码',
    fitWidth: '适应宽度',
    fitPage: '适应页面',
    fitWidthLabel: '适应宽度',
    fitPageLabel: '适应页面',
    rotateLeft: '向左旋转',
    rotateRight: '向右旋转',
    size: '大小',
    pages: '页数',
    noValue: '—',
    currentPage: '第 {cur} 页 / 共 {total} 页',
    outlineToggle: '目录',
    outlineEmpty: '无目录',
  },
};

let T: Omit<Strings, 'pageOf'> = I18N.en;
function tPageOf(cur: number, total: number): string {
  return T.currentPage.replace('{cur}', String(cur)).replace('{total}', String(total));
}

function applyLocale() {
  T = window.whaleExt.t(I18N);
  document.documentElement.lang = window.whaleExt.locale;
  // Toolbar tooltips / aria
  zoomInBtn.title = T.zoomIn;
  zoomInBtn.setAttribute('aria-label', T.zoomIn);
  zoomOutBtn.title = T.zoomOut;
  zoomOutBtn.setAttribute('aria-label', T.zoomOut);
  prevBtn.title = T.prevPage;
  prevBtn.setAttribute('aria-label', T.prevPage);
  nextBtn.title = T.nextPage;
  nextBtn.setAttribute('aria-label', T.nextPage);
  pageInput.title = T.pageNumber;
  pageInput.setAttribute('aria-label', T.pageNumber);
  fitWidthBtn.title = T.fitWidth;
  fitWidthBtn.setAttribute('aria-label', T.fitWidth);
  fitWidthBtn.textContent = T.fitWidthLabel;
  fitPageBtn.title = T.fitPage;
  fitPageBtn.setAttribute('aria-label', T.fitPage);
  fitPageBtn.textContent = T.fitPageLabel;
  rotateLeftBtn.title = T.rotateLeft;
  rotateLeftBtn.setAttribute('aria-label', T.rotateLeft);
  rotateRightBtn.title = T.rotateRight;
  rotateRightBtn.setAttribute('aria-label', T.rotateRight);
  outlineToggleBtn.title = T.outlineToggle;
  outlineToggleBtn.setAttribute('aria-label', T.outlineToggle);
  // If the sidebar is open but empty (no outline / not yet loaded), keep its
  // placeholder text in sync with the current locale.
  if (
    outlineEntries.length === 0 &&
    outlineSidebarEl.getAttribute('data-open') === 'true'
  ) {
    outlineSidebarEl.textContent = T.outlineEmpty;
  }
  // Status labels
  sizeLbl.textContent = T.size;
  pagesLbl.textContent = T.pages;
  // Re-render status values that depend on localized formatters
  updateStatusBar();
  updatePageUi();
}

// --- Theme ----------------------------------------------------------------
// Initial theme is guessed from the OS so the first frame matches the host
// (avoids the white-flash that plain `applyTheme('light')` shows on dark
// hosts). The host's `setTheme` then overwrites this within milliseconds.
// detectInitialTheme / applyTheme now live in shared/pdfjs-in-iframe.ts.

// --- Status bar formatting ------------------------------------------------
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const numberFormatter = new Intl.NumberFormat();

function updateStatusBar() {
  try {
    if (typeof state.fileSize === 'number' && state.fileSize >= 0) {
      sizeEl.textContent = formatBytes(state.fileSize);
    } else {
      sizeEl.textContent = T.noValue;
    }
    statusPagesEl.textContent =
      state.pageCount > 0 ? numberFormatter.format(state.pageCount) : T.noValue;
  } catch (err) {
    // Never let a status-bar failure block content rendering.
    // eslint-disable-next-line no-console
    console.error('[pdf-viewer] updateStatusBar failed', err);
    sizeEl.textContent = T.noValue;
    statusPagesEl.textContent = T.noValue;
  }
}

// --- Zoom / fit math ------------------------------------------------------
/**
 * Returns the CSS scale to apply to a page with the given base viewport, given
 * the current zoom mode. fit-width/fit-page compute against the scroll
 * container's content box.
 */
function computeDisplayScale(
  baseWidth: number,
  baseHeight: number,
): number {
  // `baseWidth`/`baseHeight` are already the page's DISPLAYED dimensions:
  // session.renderPageContent builds baseVp with the full rotation (page
  // /Rotate + user rotation) applied, so no width/height swap is needed
  // here. The old swap was for when baseVp carried the un-rotated size.
  if (state.zoomMode === 'manual') {
    return state.manualZoom;
  }
  // Account for container vertical padding (16px top + 16px bottom on #pages).
  const containerWidth = Math.max(0, pagesEl.clientWidth - 32);
  const containerHeight = Math.max(0, pagesEl.clientHeight - 32);
  if (state.zoomMode === 'fit-width') {
    return containerWidth > 0 ? containerWidth / baseWidth : 1;
  }
  // fit-page
  if (containerWidth <= 0 || containerHeight <= 0) return 1;
  return Math.min(containerWidth / baseWidth, containerHeight / baseHeight);
}

function effectiveZoom(): number {
  return state.manualZoom;
}

function setZoomMode(mode: ZoomMode) {
  state.zoomMode = mode;
  fitWidthBtn.classList.toggle('active', mode === 'fit-width');
  fitPageBtn.classList.toggle('active', mode === 'fit-page');
  applyZoom(); // re-lays-out existing canvases + updates zoom label
}

function applyZoom() {
  zoomLevelEl.textContent = `${Math.round(effectiveZoom() * 100)}%`;
  relayoutPages();
}

/**
 * Update CSS layout of already-rendered canvases without re-rendering them.
 * Used for zoom-level and zoom-mode changes where the existing pixel buffer is
 * still good (within reason — zoom in/out beyond 1x device pixels won't be
 * crisp, but matches the Batch 0 behavior for the +/- buttons).
 *
 * Phase 2 §A3: set BOTH `width` and `height` explicitly. We can't rely
 * on `aspect-ratio` here either — see the long comment in the
 * `onAfterPageRender` hook for the Chromium-canvas-intrinsic-size bug.
 */
function relayoutPages() {
  const canvases = pagesEl.querySelectorAll<HTMLCanvasElement>('canvas[data-page-num]');
  canvases.forEach((canvas) => {
    const pageNum = Number(canvas.getAttribute('data-page-num'));
    const baseVp = canvasToBaseVp(canvas);
    if (!baseVp) return;
    const displayScale = computeDisplayScale(baseVp.width, baseVp.height);
    const targetWidth = baseVp.width * displayScale;
    const targetHeight = baseVp.height * displayScale;
    canvas.style.width = `${targetWidth}px`;
    canvas.style.height = `${targetHeight}px`;
    // Clip overflow to the container width so a manual zoom-in stays
    // horizontally scrollable rather than spilling past the toolbar.
    canvas.style.maxWidth = '100%';
  });
}

interface BaseViewport {
  width: number;
  height: number;
}

/**
 * Read the base-viewport dimensions we stashed on the canvas via
 * data-base-w / data-base-h during the initial render.
 */
function canvasToBaseVp(canvas: HTMLCanvasElement): BaseViewport | null {
  const w = Number(canvas.getAttribute('data-base-w'));
  const h = Number(canvas.getAttribute('data-base-h'));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { width: w, height: h };
}

/**
 * Re-render a single page at a new rotation. Phase 1 §B1 forwarder — the
 * actual work (page allocation, render, cleanup) lives in
 * `session.rerenderPage`. The forwarder just translates pdf-viewer's
 * `setPageRotation` call into the session API and then re-runs the local
 * `relayoutPages` to apply the new rotation to CSS width.
 */
async function rerenderPage(pageNum: number): Promise<void> {
  const rotation = state.pageRotations.get(pageNum) ?? 0;
  await session.rerenderPage(pageNum, rotation);
  relayoutPages();
}

// --- Page navigation ------------------------------------------------------
function setCurrentPage(pageNum: number) {
  const clamped = Math.max(1, Math.min(state.pageCount || 1, pageNum));
  state.currentPage = clamped;
  // Update page input only if it's not currently being edited (avoids
  // clobbering the user's typing).
  if (document.activeElement !== pageInput) {
    pageInput.value = String(clamped);
  }
  updatePageUi();
}

function updatePageUi() {
  // Page input max and current value
  if (state.pageCount > 0) {
    pageCountEl.textContent = String(state.pageCount);
    pageInput.max = String(state.pageCount);
  } else {
    pageCountEl.textContent = T.noValue;
    pageInput.removeAttribute('max');
  }
  // Prev/next enabled state
  const hasDoc = state.pageCount > 0;
  prevBtn.disabled = !hasDoc || state.currentPage <= 1;
  nextBtn.disabled = !hasDoc || state.currentPage >= state.pageCount;
  // Status line "Page X of Y" (lives in the toolbar page-input as a tooltip
  // when there is a doc; no separate visible string needed).
  zoomLevelEl.title = hasDoc
    ? tPageOf(state.currentPage, state.pageCount)
    : '';
}

function gotoPage(pageNum: number) {
  if (!state.pageCount) return;
  setCurrentPage(pageNum);
  // Query the page container (not the canvas) so this also works for pages
  // the virtualizer hasn't rendered yet — the placeholder div carries the
  // same `data-page-container` attribute, and scrolling it into view trips
  // the IntersectionObserver to render that page on demand.
  const container = pagesEl.querySelector<HTMLElement>(
    `div[data-page-container="${state.currentPage}"]`
  );
  if (container) {
    container.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function gotoPrev() {
  if (state.currentPage > 1) gotoPage(state.currentPage - 1);
}

function gotoNext() {
  if (state.currentPage < state.pageCount) gotoPage(state.currentPage + 1);
}

function gotoFirst() {
  if (state.pageCount) gotoPage(1);
}

function gotoLast() {
  if (state.pageCount) gotoPage(state.pageCount);
}

// --- Zoom controls --------------------------------------------------------
function setManualZoom(next: number) {
  state.zoomMode = 'manual';
  fitWidthBtn.classList.remove('active');
  fitPageBtn.classList.remove('active');
  state.manualZoom = clampZoom(next);
  applyZoom();
}

function zoomIn() {
  // Switching away from fit mode preserves the current visual scale.
  if (state.zoomMode !== 'manual') {
    state.manualZoom = clampZoom(effectiveZoom());
    state.zoomMode = 'manual';
    fitWidthBtn.classList.remove('active');
    fitPageBtn.classList.remove('active');
  }
  setManualZoom(state.manualZoom + ZOOM_STEP);
}

function zoomOut() {
  if (state.zoomMode !== 'manual') {
    state.manualZoom = clampZoom(effectiveZoom());
    state.zoomMode = 'manual';
    fitWidthBtn.classList.remove('active');
    fitPageBtn.classList.remove('active');
  }
  setManualZoom(state.manualZoom - ZOOM_STEP);
}

// --- Rotation -------------------------------------------------------------
function setPageRotation(pageNum: number, delta: 90 | -90) {
  const current = state.pageRotations.get(pageNum) ?? 0;
  const next = (((current + delta) % 360) + 360) % 360;
  state.pageRotations.set(pageNum, next);
  void rerenderPage(pageNum);
}

function rotateCurrentPage(direction: 1 | -1) {
  if (!state.pageCount) return;
  setPageRotation(state.currentPage, (direction * 90) as 90 | -90);
}

// --- Wiring ---------------------------------------------------------------
// --- File-bytes bridge ----------------------------------------------------
// The host sends an empty `fileContent` blob + path + size; we ask it to
// read the file and post the raw bytes back (Uint8Array via structured
// clone — one memcpy, no base64, no O(n²) decode). We can't `fetch(whale-
// file://)` here: Chromium's CORS policy blocks cross-origin fetch to
// custom schemes (only http/https/data/chrome are allowed), which rules out
// pdfjs's `getDocument({url})` Range path. Mirrors office-viewer's
// `requestOfficeConvert` → `officePdfContent` byte-bridge pattern.
let fileBytesReqId = 0;
const pendingFileBytes = new Map<
  string,
  (data: Uint8Array | null, error?: string) => void
>();

function requestFileBytes(path: string): Promise<Uint8Array | null> {
  const requestId = `pb${(fileBytesReqId += 1)}`;
  return new Promise<Uint8Array | null>((resolve) => {
    pendingFileBytes.set(requestId, (data, error) => {
      if (error) {
        setLoadingBar(T.failedRender.replace('{msg}', error), 'error');
      }
      resolve(data ?? null);
    });
    window.whaleExt.postMessage({ type: 'requestFileBytes', requestId, path });
  });
}

/**
 * Render a PDF from raw bytes the host ships back in response to our
 * `requestFileBytes`. `fileSize` is set in the `fileContent` handler (the
 * host sends size but an empty content blob).
 */
async function renderPdfBytes(bytes: Uint8Array) {
  const token = (state.loadToken += 1);
  // Reset transient state
  state.pageRotations.clear();
  state.pageCount = 0;
  state.currentPage = 1;
  state.manualZoom = 1;
  state.zoomMode = 'manual';
  pageInput.value = '1';
  zoomLevelEl.textContent = '100%';
  fitWidthBtn.classList.remove('active');
  fitPageBtn.classList.remove('active');
  statusPagesEl.textContent = T.noValue;
  // Clear any outline from the previous document; onDocumentLoaded refills.
  outlineEntries = [];
  outlineSidebarEl.textContent = '';
  outlineSidebarEl.setAttribute('data-open', 'false');
  outlineToggleBtn.disabled = true;
  outlineToggleBtn.classList.remove('active');
  updateStatusBar();
  updatePageUi();
  setLoadingBar(T.loading, 'progress');

  // The session drives the per-page render loop. The hook we registered at
  // session creation handles per-canvas data-* stamping and CSS layout;
  // `onDocumentLoaded` sets `state.pageCount` from `doc.numPages` before the
  // first page renders; `onStatus` surfaces the session's per-page progress
  // text through the localised loading-bar template. We re-check the load
  // token after the await via the session's `getToken` plumbing.
  try {
    await session.renderPdfBytes(bytes);
    if (token !== state.loadToken) return;
    setLoadingBar('', 'progress');
  } catch (e) {
    if (token === state.loadToken) {
      setLoadingBar(
        T.failedRender.replace(
          '{msg}',
          e instanceof Error ? e.message : String(e)
        ),
        'error'
      );
    }
  }
}

/**
 * Set the loading bar text and visual state. Empty text + 'progress' is the
 * cleared state (CSS `:empty` hides the bar).
 */
function setLoadingBar(
  text: string,
  state: 'progress' | 'error'
) {
  loadingBarEl.textContent = text;
  if (text === '') {
    loadingBarEl.removeAttribute('data-state');
  } else {
    loadingBarEl.setAttribute('data-state', state);
  }
}

// --- Outline (bookmark tree) sidebar --------------------------------------
// Flattened list parallel to the rendered <li data-idx> nodes. Each outline
// node gets an index when rendered; click looks the entry up by idx instead
// of serializing dest/url into the DOM.
interface OutlineEntry {
  dest: string | Array<unknown> | null;
  url: string | null;
}
let outlineEntries: OutlineEntry[] = [];

async function loadOutline(): Promise<void> {
  const token = state.loadToken;
  const nodes = await session.getOutline();
  // A newer file load may have bumped the token while we awaited; bail so we
  // don't paint a stale outline over the freshly-reset sidebar.
  if (token !== state.loadToken) return;
  outlineEntries = [];
  outlineToggleBtn.disabled = nodes.length === 0;
  if (nodes.length === 0) {
    outlineSidebarEl.textContent = T.outlineEmpty;
    return;
  }
  outlineSidebarEl.textContent = '';
  outlineSidebarEl.appendChild(buildOutlineList(nodes));
}

function buildOutlineList(nodes: OutlineNode[]): HTMLUListElement {
  const ul = document.createElement('ul');
  for (const node of nodes) {
    const idx = outlineEntries.length;
    outlineEntries.push({ dest: node.dest, url: node.url });
    const li = document.createElement('li');
    li.setAttribute('data-idx', String(idx));
    li.classList.add('outline-item');
    if (node.url) li.classList.add('outline-link');
    li.textContent = node.title; // textContent auto-escapes the title
    li.addEventListener('click', () => void onOutlineClick(idx));
    if (node.items.length > 0) {
      li.appendChild(buildOutlineList(node.items));
    }
    ul.appendChild(li);
  }
  return ul;
}

async function onOutlineClick(idx: number): Promise<void> {
  const entry = outlineEntries[idx];
  if (!entry) return;
  if (entry.url) {
    window.whaleExt.postMessage({ type: 'openLinkExternally', url: entry.url });
    return;
  }
  if (entry.dest) {
    const pageIndex = await session.resolveDest(entry.dest);
    if (pageIndex != null) gotoPage(pageIndex + 1); // pageIndex is 0-based
  }
}

// --- Resize observer for fit modes ----------------------------------------
let resizeRaf = 0;
function scheduleRefit() {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    if (state.zoomMode === 'fit-width' || state.zoomMode === 'fit-page') {
      // Container size changed — re-lay out existing canvases without
      // re-rendering pixels.
      relayoutPages();
    }
  });
}

const resizeObserver =
  typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => scheduleRefit())
    : null;
if (resizeObserver) resizeObserver.observe(pagesEl);
window.addEventListener('resize', scheduleRefit);

// --- Toolbar / keyboard wiring -------------------------------------------
prevBtn.addEventListener('click', gotoPrev);
nextBtn.addEventListener('click', gotoNext);
zoomInBtn.addEventListener('click', zoomIn);
zoomOutBtn.addEventListener('click', zoomOut);
fitWidthBtn.addEventListener('click', () => setZoomMode('fit-width'));
fitPageBtn.addEventListener('click', () => setZoomMode('fit-page'));
rotateLeftBtn.addEventListener('click', () => rotateCurrentPage(-1));
rotateRightBtn.addEventListener('click', () => rotateCurrentPage(1));
outlineToggleBtn.addEventListener('click', () => {
  const open = outlineSidebarEl.getAttribute('data-open') === 'true';
  outlineSidebarEl.setAttribute('data-open', open ? 'false' : 'true');
  outlineToggleBtn.classList.toggle('active', !open);
});

pageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const n = parseInt(pageInput.value, 10);
    if (Number.isFinite(n) && n >= 1 && n <= state.pageCount) {
      gotoPage(n);
      pageInput.blur();
    } else {
      // Restore current value on invalid input
      pageInput.value = String(state.currentPage);
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    pageInput.value = String(state.currentPage);
    pageInput.blur();
  }
});
pageInput.addEventListener('focus', () => {
  pageInput.select();
});
pageInput.addEventListener('blur', () => {
  // Sync to the actual current page if user didn't confirm.
  if (
    parseInt(pageInput.value, 10) !== state.currentPage &&
    state.pageCount > 0
  ) {
    pageInput.value = String(state.currentPage);
  }
});

// Track current page from scroll position (loose, debounced via rAF)
let scrollRaf = 0;
pagesEl.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    if (state.pageCount === 0) return;
    const containerRect = pagesEl.getBoundingClientRect();
    // Find the page whose top is closest to (but not past) the container top
    // + 10% of container height (treat the center of the viewport as "active").
    const targetY = containerRect.top + containerRect.height * 0.25;
    const canvases = pagesEl.querySelectorAll<HTMLCanvasElement>(
      'canvas[data-page-num]'
    );
    let best: { num: number; top: number } | null = null;
    canvases.forEach((c) => {
      const top = c.getBoundingClientRect().top;
      const num = Number(c.getAttribute('data-page-num'));
      if (top <= targetY && (!best || top > best.top)) {
        best = { num, top };
      }
    });
    if (best && best.num !== state.currentPage) {
      setCurrentPage(best.num);
    }
  });
});

window.addEventListener('keydown', (e) => {
  // Ignore when the user is typing in the page input
  if (document.activeElement === pageInput) return;
  // Ignore when modifier keys other than Ctrl are pressed (don't hijack
  // browser shortcuts)
  if (e.altKey || e.metaKey || e.shiftKey) return;

  if (e.ctrlKey || e.metaKey) {
    if (e.key === '0') {
      e.preventDefault();
      setZoomMode('fit-width');
      return;
    }
    if (e.key === '9') {
      e.preventDefault();
      setZoomMode('fit-page');
      return;
    }
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomIn();
      return;
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomOut();
      return;
    }
  }

  switch (e.key) {
    case 'PageDown':
      e.preventDefault();
      gotoNext();
      return;
    case 'PageUp':
      e.preventDefault();
      gotoPrev();
      return;
    case 'Home':
      e.preventDefault();
      gotoFirst();
      return;
    case 'End':
      e.preventDefault();
      gotoLast();
      return;
    case 'ArrowRight':
      e.preventDefault();
      gotoNext();
      return;
    case 'ArrowLeft':
      e.preventDefault();
      gotoPrev();
      return;
    default:
      return;
  }
});

// --- Host message bridge --------------------------------------------------
window.whaleExt.onMessage((msg) => {
  switch (msg.type) {
    case 'fileContent':
      // The host no longer base64-encodes the whole PDF into `content` (that
      // froze the renderer on large files — a 50 MB PDF → O(n²)
      // `binary += String.fromCharCode(...)` on the main thread). It sends an
      // empty content blob + the path + size; we ask it to read the file and
      // ship the raw bytes back via postMessage (Uint8Array structured clone
      // — no base64, no O(n²) decode). We can't fetch(whale-file://) here:
      // Chromium's CORS policy blocks cross-origin fetch to custom schemes,
      // so pdfjs's getDocument({url}) Range path is out. Bytes-in is what
      // works.
      state.fileSize = msg.size;
      updateStatusBar();
      requestFileBytes(msg.path).then((bytes) => {
        if (bytes) {
          renderPdfBytes(bytes).catch(() => undefined);
        } else {
          setLoadingBar(
            T.failedRender.replace('{msg}', 'file read failed'),
            'error',
          );
        }
      });
      break;
    case 'fileBytes': {
      const pending = pendingFileBytes.get(msg.requestId);
      if (pending) {
        pendingFileBytes.delete(msg.requestId);
        pending(msg.data ?? null, msg.error);
      }
      break;
    }
    case 'pdfAsset':
      // Shared session handles the cmap / font / wasm reply (with 30s timeout).
      if (session.handleHostMessage(msg)) break;
      break;
    case 'setTheme':
      sessionApplyTheme(msg.theme);
      break;
    default:
      break;
  }
});

window.whaleExt.onLocale(() => applyLocale());

// --- Initial paint --------------------------------------------------------
// Order matters: guess OS theme first, then seed i18n labels, then post
// `ready` so the host can stream `fileContent` and `setTheme`.
sessionApplyTheme(detectInitialTheme());
applyLocale();
updateStatusBar();
updatePageUi();
window.whaleExt.postMessage({ type: 'ready' });
