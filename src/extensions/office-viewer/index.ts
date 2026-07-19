import './viewer.css';
import {
  createPdfjsSession,
  detectInitialTheme,
  applyTheme,
  PDFJS_I18N,
  type PdfjsSession,
} from '../shared/pdfjs-in-iframe';
import {
  clampZoom,
  clampPage,
  computeDisplayScale,
  nextRotation,
  formatBytes,
  ZOOM_STEP,
  type ZoomMode,
} from './view-math';

// --- DOM refs -------------------------------------------------------------
const pagesEl = document.getElementById('pages') as HTMLDivElement;
const loadingBarEl = document.getElementById('loading-bar') as HTMLDivElement;
const statusSizeEl = document.getElementById('status-size') as HTMLSpanElement;
const statusPagesEl = document.getElementById('status-pages') as HTMLSpanElement;
const sizeLblEl = document.getElementById('size-lbl') as HTMLSpanElement;
const pagesLblEl = document.getElementById('pages-lbl') as HTMLSpanElement;
const pageInput = document.getElementById('page-input') as HTMLInputElement;
const pageCountEl = document.getElementById('page-count') as HTMLSpanElement;
const zoomLevelEl = document.getElementById('zoom-level') as HTMLSpanElement;
const prevBtn = document.getElementById('prev-page') as HTMLButtonElement;
const nextBtn = document.getElementById('next-page') as HTMLButtonElement;
const fitWidthBtn = document.getElementById('fit-width') as HTMLButtonElement;
const fitPageBtn = document.getElementById('fit-page') as HTMLButtonElement;
const zoomInEl = document.getElementById('zoom-in') as HTMLButtonElement;
const zoomOutEl = document.getElementById('zoom-out') as HTMLButtonElement;
const rotateLeftBtn = document.getElementById('rotate-left') as HTMLButtonElement;
const rotateRightBtn = document.getElementById('rotate-right') as HTMLButtonElement;

// --- Conversion bridge: still office-specific (soffice → PDF), not shared.
type PendingResolver = {
  resolve: (data: Uint8Array) => void;
  reject: (err: Error) => void;
};
const pendingConversions = new Map<string, PendingResolver>();
let convertReqId = 0;
let renderToken = 0;

// §16.8 view state (mirrors pdf-viewer): manual zoom or a fit mode; per-page
// user rotation; scroll-synced current page; file size for the status bar.
let zoomMode: ZoomMode = 'manual';
let manualZoom = 1;
const pageRotations = new Map<number, number>();
let currentPage = 0;
let pageCount = 0;
let fileSizeBytes: number | null = null;

function requestOfficeConvert(path: string): Promise<Uint8Array> {
  const requestId = `o${(convertReqId += 1)}`;
  return new Promise<Uint8Array>((resolve, reject) => {
    pendingConversions.set(requestId, { resolve, reject });
    window.whaleExt.postMessage({ type: 'requestOfficeConvert', requestId, path });
  });
}

// --- Thumbnail placeholder (P3-1) -----------------------------------------
// The file's cached thumbnail (data URL), shown as an instant first-page
// placeholder while LibreOffice cold-converts the document to PDF (2-5s on a
// cold Windows install). Same JPEG the file browser already generated; null
// when no thumbnail exists yet (the viewer then just keeps "Converting…").
const pendingThumbnails = new Map<string, (dataUrl: string | null) => void>();
let thumbReqId = 0;

function requestThumbnail(path: string): Promise<string | null> {
  const requestId = `t${(thumbReqId += 1)}`;
  return new Promise<string | null>((resolve) => {
    pendingThumbnails.set(requestId, resolve);
    window.whaleExt.postMessage({ type: 'requestThumbnail', requestId, path });
  });
}

// --- LibreOffice availability probe (docs/09 §16.16) ---------------------
// When LibreOffice is missing, the viewer shows install guidance + an "open
// with system default" fallback instead of a bare "soffice not found"
// dead-end. Probed up front so we never attempt the doomed convert.
const pendingSofficeChecks = new Map<string, (available: boolean) => void>();
let sofficeReqId = 0;
const LIBREOFFICE_DOWNLOAD_URL =
  'https://www.libreoffice.org/download/download-libreoffice/';

function requestSofficeCheck(): Promise<boolean> {
  const requestId = `s${(sofficeReqId += 1)}`;
  return new Promise<boolean>((resolve) => {
    pendingSofficeChecks.set(requestId, resolve);
    window.whaleExt.postMessage({ type: 'requestSofficeCheck', requestId });
  });
}

// Shared inline style for the guidance/fallback buttons.
const BTN_STYLE =
  'padding:8px 16px;border:1px solid currentColor;border-radius:4px;' +
  'background:transparent;cursor:pointer;font:inherit;';

// --- Shared pdfjs session -------------------------------------------------
// §16.8: the session now gets the same hooks pdf-viewer has — per-canvas
// data-* stamping + CSS display scale (fit-width / fit-page / manual zoom)
// and a shared display-scale for the TextLayer so text selection aligns at
// any zoom (previously the TextLayer always laid out at scale 1, so selection
// drifted as soon as the user zoomed — a latent bug the fit modes forced us
// to fix properly).
const session: PdfjsSession = createPdfjsSession({
  pagesEl,
  getToken: () => renderToken,
  onAfterPageRender: (pageNum, canvas, baseVp) => {
    canvas.setAttribute('data-page-num', String(pageNum));
    canvas.setAttribute('data-base-w', String(baseVp.width));
    canvas.setAttribute('data-base-h', String(baseVp.height));
    // Apply the CURRENT display scale immediately (same Chromium-canvas-
    // intrinsic-size reason as pdf-viewer: set BOTH width and height —
    // `aspect-ratio` is resolved after the intrinsic bitmap size and is
    // effectively ignored for <canvas>).
    const ds = computeDisplayScale(
      zoomMode,
      manualZoom,
      pagesEl.clientWidth,
      pagesEl.clientHeight,
      baseVp.width,
      baseVp.height
    );
    canvas.style.width = `${baseVp.width * ds}px`;
    canvas.style.height = `${baseVp.height * ds}px`;
  },
  // §16.18: localized per-page aria-label for the shared render loop's
  // role="img" canvas stamping.
  pageAriaLabel: (pageNum, total) =>
    T.pageLabel.replace('{n}', String(pageNum)).replace('{total}', String(total)),
  computeDisplayScale: (baseVp) =>
    computeDisplayScale(
      zoomMode,
      manualZoom,
      pagesEl.clientWidth,
      pagesEl.clientHeight,
      baseVp.width,
      baseVp.height
    ),
  onDocumentLoaded: (count) => {
    pageCount = count;
    updatePageUi();
    updateStatusBar();
  },
  onStatus: ({ kind, text }) => {
    if (kind === 'error') {
      setLoadingBar(T.failedRender.replace('{msg}', text), 'error');
      return;
    }
    // progress: the session drives its own per-page text ('2 / 10'); surface
    // it through the localised "Rendering N / M…" template (mirrors pdf-viewer).
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
  },
});

// --- i18n ----------------------------------------------------------------
// 7 shared keys come from PDFJS_I18N; the rest are office-specific.
interface Strings {
  loading: string;
  failedDecode: string;
  rendering: string;
  failedRender: string;
  zoomIn: string;
  zoomOut: string;
  /** §16.18: per-page canvas aria-label (`{n}` / `{total}` placeholders). */
  pageLabel: string;
  prevPage: string;
  nextPage: string;
  /** page-input title / aria-label. */
  pageNumber: string;
  fitWidth: string;
  fitPage: string;
  rotateLeft: string;
  rotateRight: string;
  /** status-bar labels (§16.8). */
  sizeLabel: string;
  pagesLabel: string;
  converting: string;
  failedConvert: string;
  /** docs/09 §16.16: shown when LibreOffice is not installed. */
  sofficeMissing: string;
  downloadLibreOffice: string;
  /** docs/09 §16.21: open the file with the OS default app (fallback). */
  openWithSystem: string;
}

const I18N: Record<string, Strings> = {
  en: {
    ...PDFJS_I18N.en,
    prevPage: 'Previous page',
    nextPage: 'Next page',
    pageNumber: 'Page number',
    fitWidth: 'Fit width',
    fitPage: 'Fit page',
    rotateLeft: 'Rotate left',
    rotateRight: 'Rotate right',
    sizeLabel: 'Size',
    pagesLabel: 'Pages',
    converting: 'Converting to PDF…',
    failedConvert: 'Office document conversion failed: {msg}',
    sofficeMissing:
      'LibreOffice is not installed. WhaleTag uses it to render Office documents.',
    downloadLibreOffice: 'Download LibreOffice',
    openWithSystem: 'Open with system default',
  },
  zh: {
    ...PDFJS_I18N.zh,
    prevPage: '上一页',
    nextPage: '下一页',
    pageNumber: '页码',
    fitWidth: '适合宽度',
    fitPage: '适合页面',
    rotateLeft: '向左旋转',
    rotateRight: '向右旋转',
    sizeLabel: '大小',
    pagesLabel: '页数',
    converting: '正在转换为 PDF…',
    failedConvert: 'Office 文档转换失败:{msg}',
    sofficeMissing: '未安装 LibreOffice。WhaleTag 需要它来渲染 Office 文档。',
    downloadLibreOffice: '下载 LibreOffice',
    openWithSystem: '用系统默认应用打开',
  },
};

let T: Strings = I18N.en;

function applyLocale() {
  T = window.whaleExt.t(I18N);
  document.documentElement.lang = window.whaleExt.locale;
  const labelled: Array<[HTMLButtonElement, string]> = [
    [prevBtn, T.prevPage],
    [nextBtn, T.nextPage],
    [fitWidthBtn, T.fitWidth],
    [fitPageBtn, T.fitPage],
    [zoomOutEl, T.zoomOut],
    [zoomInEl, T.zoomIn],
    [rotateLeftBtn, T.rotateLeft],
    [rotateRightBtn, T.rotateRight],
  ];
  for (const [btn, label] of labelled) {
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
  pageInput.title = T.pageNumber;
  pageInput.setAttribute('aria-label', T.pageNumber);
  sizeLblEl.textContent = T.sizeLabel;
  pagesLblEl.textContent = T.pagesLabel;
}

// --- Loading bar (§16.8: transient progress / error line) ------------------
function setLoadingBar(text: string, state: 'progress' | 'error') {
  loadingBarEl.textContent = text;
  if (text === '') {
    loadingBarEl.removeAttribute('data-state');
  } else {
    loadingBarEl.setAttribute('data-state', state);
  }
}

// --- Status bar (§16.8: file size + page count) ----------------------------
function updateStatusBar() {
  statusSizeEl.textContent = formatBytes(fileSizeBytes);
  statusPagesEl.textContent = pageCount > 0 ? String(pageCount) : '—';
}

// --- Zoom / fit (§16.8, mirrors pdf-viewer) --------------------------------
/**
 * Re-lay out already-rendered canvases without re-rendering pixels. Used for
 * zoom / fit-mode / rotation changes where the existing bitmap is still good.
 * BOTH width and height are set explicitly — see the session hook comment.
 */
function relayoutPages() {
  const canvases = pagesEl.querySelectorAll<HTMLCanvasElement>(
    'canvas[data-page-num]'
  );
  canvases.forEach((canvas) => {
    const baseW = Number(canvas.getAttribute('data-base-w'));
    const baseH = Number(canvas.getAttribute('data-base-h'));
    if (!Number.isFinite(baseW) || !Number.isFinite(baseH) || baseW <= 0 || baseH <= 0) {
      return;
    }
    const ds = computeDisplayScale(
      zoomMode,
      manualZoom,
      pagesEl.clientWidth,
      pagesEl.clientHeight,
      baseW,
      baseH
    );
    canvas.style.width = `${baseW * ds}px`;
    canvas.style.height = `${baseH * ds}px`;
    canvas.style.maxWidth = '100%';
  });
}

function applyZoom() {
  zoomLevelEl.textContent = `${Math.round(manualZoom * 100)}%`;
  relayoutPages();
}

function setZoomMode(mode: ZoomMode) {
  zoomMode = mode;
  fitWidthBtn.classList.toggle('active', mode === 'fit-width');
  fitPageBtn.classList.toggle('active', mode === 'fit-page');
  applyZoom();
}

function setManualZoom(next: number) {
  zoomMode = 'manual';
  fitWidthBtn.classList.remove('active');
  fitPageBtn.classList.remove('active');
  manualZoom = clampZoom(next);
  applyZoom();
}

function zoomIn() {
  setManualZoom(manualZoom + ZOOM_STEP);
}

function zoomOut() {
  setManualZoom(manualZoom - ZOOM_STEP);
}

// --- Page navigation (§16.8) -----------------------------------------------
function setCurrentPage(pageNum: number) {
  currentPage = clampPage(pageNum, pageCount);
  // Don't clobber the input while the user is typing in it.
  if (document.activeElement !== pageInput) {
    pageInput.value = String(currentPage);
  }
  updatePageUi();
}

function updatePageUi() {
  if (pageCount > 0) {
    pageCountEl.textContent = String(pageCount);
    pageInput.max = String(pageCount);
  } else {
    pageCountEl.textContent = '—';
    pageInput.removeAttribute('max');
  }
  const hasDoc = pageCount > 0;
  prevBtn.disabled = !hasDoc || currentPage <= 1;
  nextBtn.disabled = !hasDoc || currentPage >= pageCount;
}

function gotoPage(pageNum: number) {
  if (!pageCount) return;
  setCurrentPage(pageNum);
  const container = pagesEl.querySelector<HTMLElement>(
    `div[data-page-container="${currentPage}"]`
  );
  if (container) {
    container.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function gotoPrev() {
  if (currentPage > 1) gotoPage(currentPage - 1);
}

function gotoNext() {
  if (currentPage < pageCount) gotoPage(currentPage + 1);
}

function gotoFirst() {
  if (pageCount) gotoPage(1);
}

function gotoLast() {
  if (pageCount) gotoPage(pageCount);
}

// --- Rotation (§16.8: per-page ±90°) ----------------------------------------
async function rerenderPage(pageNum: number): Promise<void> {
  const rotation = pageRotations.get(pageNum) ?? 0;
  await session.rerenderPage(pageNum, rotation);
  relayoutPages();
}

function setPageRotation(pageNum: number, delta: 90 | -90) {
  const next = nextRotation(pageRotations.get(pageNum) ?? 0, delta);
  pageRotations.set(pageNum, next);
  void rerenderPage(pageNum);
}

function rotateCurrentPage(direction: 1 | -1) {
  if (!pageCount) return;
  setPageRotation(currentPage, (direction * 90) as 90 | -90);
}

// --- Render pipeline ---------------------------------------------------------
/** Reset all per-file view state before a new document renders. */
function resetViewState() {
  pageRotations.clear();
  pageCount = 0;
  currentPage = 1;
  manualZoom = 1;
  zoomMode = 'manual';
  pageInput.value = '1';
  zoomLevelEl.textContent = '100%';
  fitWidthBtn.classList.remove('active');
  fitPageBtn.classList.remove('active');
  updatePageUi();
  updateStatusBar();
}

async function renderPdf(bytes: Uint8Array) {
  const token = (renderToken += 1);
  pagesEl.innerHTML = '';
  resetViewState();
  setLoadingBar(T.loading, 'progress');

  try {
    await session.renderPdfBytes(bytes);
    if (token !== renderToken) return;
    setLoadingBar('', 'progress');
    if (pageCount > 0) {
      currentPage = 1;
      updatePageUi();
    }
  } catch (e) {
    if (token === renderToken) {
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

async function openOfficeFile(path: string) {
  const token = (renderToken += 1);
  pagesEl.innerHTML = '';
  resetViewState();
  setLoadingBar(T.converting, 'progress');

  // docs/09 §16.16: probe LibreOffice up front. If it's missing, show install
  // guidance + an "open with system default" fallback instead of attempting a
  // doomed convert that ends on a bare "soffice not found" dead-end.
  const available = await requestSofficeCheck();
  if (token !== renderToken) return;
  if (!available) {
    showOfficeMessage({ title: T.sofficeMissing, download: true, path });
    return;
  }

  // P3-1: fetch the cached thumbnail in parallel with the conversion. The
  // thumbnail (already generated for the file browser) lands almost instantly
  // and shows as a first-page placeholder during the 2-5s LibreOffice cold
  // convert — the viewer is no longer blank during that window. Ignored if a
  // real page has rendered by the time it arrives (cache-hit convert) or if a
  // newer open superseded this one.
  requestThumbnail(path).then((dataUrl) => {
    if (token !== renderToken) return;
    if (dataUrl) showThumbnailPlaceholder(dataUrl);
  });

  try {
    const pdfBytes = await requestOfficeConvert(path);
    if (token !== renderToken) return;
    await renderPdf(pdfBytes);
  } catch (e) {
    if (token === renderToken) {
      // docs/09 §16.21: conversion failed (LibreOffice present) — offer the
      // open-with-system fallback so the user isn't stuck on a dead-end.
      const msg = e instanceof Error ? e.message : String(e);
      showOfficeMessage({
        title: T.failedConvert.replace('{msg}', msg),
        download: false,
        path,
      });
    }
  }
}

/**
 * Show the cached thumbnail JPEG as a transient first-page placeholder while
 * the conversion / pdfjs rasterization is in flight. Cleared by `renderPdf`
 * (which resets `pagesEl`) once the real first canvas is painted.
 */
function showThumbnailPlaceholder(dataUrl: string) {
  if (pagesEl.querySelector('canvas')) return; // a real page already rendered
  pagesEl.innerHTML = '';
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = '';
  img.style.cssText =
    'display:block;max-width:100%;max-height:80vh;object-fit:contain;' +
    'margin:0 auto;opacity:0.85;box-shadow:0 1px 4px rgba(0,0,0,0.2);';
  pagesEl.appendChild(img);
}

/**
 * Render an inline message screen for the LibreOffice-missing case (§16.16,
 * with a download button) or a conversion failure (§16.21, fallback only),
 * plus an "Open with system default" button so the user is never stuck on a
 * dead-end. Replaces the page area.
 */
function showOfficeMessage(opts: {
  title: string;
  download: boolean;
  path: string;
}): void {
  pagesEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'max-width:480px;margin:auto;padding:32px 24px;text-align:center;' +
    'display:flex;flex-direction:column;gap:12px;align-items:center;';
  const title = document.createElement('p');
  title.style.cssText = 'margin:0;line-height:1.5;';
  title.textContent = opts.title;
  wrap.appendChild(title);
  if (opts.download) {
    const dl = document.createElement('button');
    dl.textContent = T.downloadLibreOffice;
    dl.setAttribute('style', BTN_STYLE);
    dl.addEventListener('click', () =>
      window.whaleExt.postMessage({
        type: 'openLinkExternally',
        url: LIBREOFFICE_DOWNLOAD_URL,
      })
    );
    wrap.appendChild(dl);
  }
  const open = document.createElement('button');
  open.textContent = T.openWithSystem;
  open.setAttribute('style', BTN_STYLE);
  open.addEventListener('click', () =>
    window.whaleExt.postMessage({ type: 'openWithSystem', path: opts.path })
  );
  wrap.appendChild(open);
  pagesEl.appendChild(wrap);
  setLoadingBar('', 'progress');
}

// --- Resize → refit (§16.8: CSS-only relayout, never re-rasterizes) ---------
let resizeRaf = 0;
function scheduleRefit() {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    if (zoomMode === 'fit-width' || zoomMode === 'fit-page') {
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

// --- Toolbar / keyboard wiring (§16.8) --------------------------------------
prevBtn.addEventListener('click', gotoPrev);
nextBtn.addEventListener('click', gotoNext);
zoomInEl.addEventListener('click', zoomIn);
zoomOutEl.addEventListener('click', zoomOut);
fitWidthBtn.addEventListener('click', () => setZoomMode('fit-width'));
fitPageBtn.addEventListener('click', () => setZoomMode('fit-page'));
rotateLeftBtn.addEventListener('click', () => rotateCurrentPage(-1));
rotateRightBtn.addEventListener('click', () => rotateCurrentPage(1));

pageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const n = parseInt(pageInput.value, 10);
    if (Number.isFinite(n) && n >= 1 && n <= pageCount) {
      gotoPage(n);
      pageInput.blur();
    } else {
      pageInput.value = String(currentPage);
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    pageInput.value = String(currentPage);
    pageInput.blur();
  }
});
pageInput.addEventListener('focus', () => {
  pageInput.select();
});
pageInput.addEventListener('blur', () => {
  if (parseInt(pageInput.value, 10) !== currentPage && pageCount > 0) {
    pageInput.value = String(currentPage);
  }
});

window.addEventListener('keydown', (e) => {
  // Ignore when the user is typing in the page input.
  if (document.activeElement === pageInput) return;
  // Don't hijack browser/OS shortcuts with extra modifiers.
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

// P3-2: track the current page from scroll position (rAF-throttled), mirroring
// pdf-viewer. Finds the page whose top is closest to (but not past) 25% down
// the viewport.
let scrollRaf = 0;
pagesEl.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    if (pageCount === 0) return;
    const rect = pagesEl.getBoundingClientRect();
    const targetY = rect.top + rect.height * 0.25;
    const canvases = pagesEl.querySelectorAll<HTMLCanvasElement>(
      'canvas[data-page-num]'
    );
    let best: { num: number; top: number } | null = null;
    canvases.forEach((c) => {
      const top = c.getBoundingClientRect().top;
      const num = Number(c.getAttribute('data-page-num'));
      if (top <= targetY && (!best || top > best.top)) best = { num, top };
    });
    if (best && best.num !== currentPage) {
      setCurrentPage(best.num);
    }
  });
});

window.whaleExt.onMessage((msg) => {
  switch (msg.type) {
    case 'fileContent':
      // The Office bytes are sent as base64, but conversion happens in the main
      // process which reads the file directly. We only need the path here (and
      // the size, when the host supplies it, for the status bar — §16.8).
      fileSizeBytes = typeof msg.size === 'number' ? msg.size : null;
      openOfficeFile(msg.path).catch(() => undefined);
      break;
    case 'officePdfContent': {
      const pending = pendingConversions.get(msg.requestId);
      if (!pending) break;
      pendingConversions.delete(msg.requestId);
      if (msg.data) {
        // msg.data arrives as a Uint8Array (the main process returns a Buffer;
        // Electron IPC serializes it). Pass it straight to pdfjs — wrapping with
        // `new Uint8Array(...)` would copy a typed array. See docs/15 P1-4.
        pending.resolve(msg.data);
      } else {
        pending.reject(new Error(msg.error || 'conversion failed'));
      }
      break;
    }
    case 'thumbnailContent': {
      const resolve = pendingThumbnails.get(msg.requestId);
      if (resolve) {
        pendingThumbnails.delete(msg.requestId);
        resolve(msg.dataUrl ?? null);
      }
      break;
    }
    case 'sofficeCheckResult': {
      const resolve = pendingSofficeChecks.get(msg.requestId);
      if (resolve) {
        pendingSofficeChecks.delete(msg.requestId);
        resolve(msg.available);
      }
      break;
    }
    case 'pdfAsset':
      if (session.handleHostMessage(msg)) break;
      break;
    case 'setTheme':
      applyTheme(msg.theme);
      break;
    default:
      break;
  }
});

window.whaleExt.onLocale(() => applyLocale());

// Initial paint: guess OS theme (eliminates white flash on dark hosts — see
// docs/09 §16.9). Host's `setTheme` then overwrites within milliseconds.
applyTheme(detectInitialTheme());
applyLocale();
updatePageUi();
updateStatusBar();
window.whaleExt.postMessage({ type: 'ready' });
