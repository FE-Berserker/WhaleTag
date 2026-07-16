import './viewer.css';
import {
  createPdfjsSession,
  detectInitialTheme,
  applyTheme,
  PDFJS_I18N,
  type PdfjsSession,
} from '../shared/pdfjs-in-iframe';

// --- DOM refs -------------------------------------------------------------
const pagesEl = document.getElementById('pages') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const pageInfoEl = document.getElementById('page-info') as HTMLSpanElement;
const zoomLevelEl = document.getElementById('zoom-level') as HTMLSpanElement;
const zoomInEl = document.getElementById('zoom-in') as HTMLButtonElement;
const zoomOutEl = document.getElementById('zoom-out') as HTMLButtonElement;

// --- Conversion bridge: still office-specific (soffice → PDF), not shared.
type PendingResolver = {
  resolve: (data: Uint8Array) => void;
  reject: (err: Error) => void;
};
const pendingConversions = new Map<string, PendingResolver>();
let convertReqId = 0;
let renderToken = 0;
let zoom = 1;
const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.5; // office-viewer's choice — narrower than pdf-viewer's 0.25
const ZOOM_MAX = 4;
// P3-2: scroll-synced current page for the "cur / total" indicator (was a
// static "N / N").
let currentPage = 0;
let totalPages = 0;

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
// Office-viewer's render loop has no per-page rotation / fit-mode, so it
// uses the full `session.renderPdfBytes` flow.
const session: PdfjsSession = createPdfjsSession({
  pagesEl,
  getToken: () => renderToken,
  // P3-2: stamp the page number on each canvas so the rAF scroll handler can
  // resolve the current page (office-viewer otherwise has no per-page marker).
  onAfterPageRender: (pageNum, canvas) => {
    canvas.setAttribute('data-page-num', String(pageNum));
  },
  onStatus: ({ kind, text }) => {
    if (kind === 'error') {
      statusEl.textContent = text;
    } else if (kind === 'progress') {
      // The session's "rendering N/total" status uses a "{n}/{total}"
      // shorthand, but office-viewer's local i18n expects the rendering
      // template with placeholders. Map the bare progress number into the
      // template; clear text = idle (no message).
      if (!text) {
        statusEl.textContent = '';
      } else {
        statusEl.textContent = T.rendering
          .replace('{cur}', text)
          .replace('{total}', String(pageInfoEl.textContent.split('/').pop()?.trim() ?? '?'));
      }
    }
  },
});

// --- i18n ----------------------------------------------------------------
// 6 shared keys come from PDFJS_I18N; 2 are office-specific.
interface Strings {
  loading: string;
  failedDecode: string;
  rendering: string;
  failedRender: string;
  zoomIn: string;
  zoomOut: string;
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
    converting: 'Converting to PDF…',
    failedConvert: 'Office document conversion failed: {msg}',
    sofficeMissing:
      'LibreOffice is not installed. WhaleTag uses it to render Office documents.',
    downloadLibreOffice: 'Download LibreOffice',
    openWithSystem: 'Open with system default',
  },
  zh: {
    ...PDFJS_I18N.zh,
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
  zoomInEl.title = T.zoomIn;
  zoomOutEl.title = T.zoomOut;
}

function applyZoom() {
  zoomLevelEl.textContent = `${Math.round(zoom * 100)}%`;
  pagesEl.querySelectorAll('canvas').forEach((c) => {
    const el = c as HTMLCanvasElement;
    if (zoom === 1) {
      el.style.width = '';
      el.style.maxWidth = '100%';
    } else {
      el.style.maxWidth = 'none';
      el.style.width = `${zoom * 100}%`;
    }
  });
}

function setZoom(next: number) {
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
  applyZoom();
}

zoomInEl.addEventListener('click', () => setZoom(zoom + ZOOM_STEP));
zoomOutEl.addEventListener('click', () => setZoom(zoom - ZOOM_STEP));

// P3-2: track the current page from scroll position (rAF-throttled), mirroring
// pdf-viewer. Finds the page whose top is closest to (but not past) 25% down
// the viewport and updates the "cur / total" indicator. The ResizeObserver +
// relayout half of P3-2 is N/A here: office canvases render at a fixed px width
// (no fit-mode), so a container resize neither re-rasterizes nor needs a
// CSS relayout — there's nothing to throttle.
let scrollRaf = 0;
pagesEl.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    if (totalPages === 0) return;
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
    const next = best?.num ?? 1;
    if (next !== currentPage) {
      currentPage = next;
      pageInfoEl.textContent = `${currentPage} / ${totalPages}`;
    }
  });
});

async function renderPdf(bytes: Uint8Array) {
  const token = (renderToken += 1);
  pagesEl.innerHTML = '';
  pageInfoEl.textContent = '';
  zoom = 1;
  zoomLevelEl.textContent = '100%';
  statusEl.textContent = T.loading;
  pageInfoEl.textContent = '?';

  try {
    await session.renderPdfBytes(bytes);
    if (token !== renderToken) return;
    // session may have been cancelled mid-render — bail without overwriting status.
    const pages = pagesEl.querySelectorAll('canvas[data-page-num]');
    if (pages.length > 0) {
      totalPages = pages.length;
      currentPage = 1;
      pageInfoEl.textContent = `${currentPage} / ${totalPages}`;
      statusEl.textContent = '';
    }
  } catch (e) {
    if (token === renderToken) {
      statusEl.textContent = T.failedRender.replace(
        '{msg}',
        e instanceof Error ? e.message : String(e)
      );
    }
  }
}

async function openOfficeFile(path: string) {
  const token = (renderToken += 1);
  pagesEl.innerHTML = '';
  pageInfoEl.textContent = '';
  totalPages = 0;
  currentPage = 0;
  zoom = 1;
  zoomLevelEl.textContent = '100%';
  statusEl.textContent = T.converting;

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
  statusEl.textContent = '';
}

window.whaleExt.onMessage((msg) => {
  switch (msg.type) {
    case 'fileContent':
      // The Office bytes are sent as base64, but conversion happens in the main
      // process which reads the file directly. We only need the path here.
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
window.whaleExt.postMessage({ type: 'ready' });