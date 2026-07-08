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

function requestOfficeConvert(path: string): Promise<Uint8Array> {
  const requestId = `o${(convertReqId += 1)}`;
  return new Promise<Uint8Array>((resolve, reject) => {
    pendingConversions.set(requestId, { resolve, reject });
    window.whaleExt.postMessage({ type: 'requestOfficeConvert', requestId, path });
  });
}

// --- Shared pdfjs session -------------------------------------------------
// Office-viewer's render loop has no per-page rotation / fit-mode, so it
// uses the full `session.renderPdfBytes` flow.
const session: PdfjsSession = createPdfjsSession({
  pagesEl,
  getToken: () => renderToken,
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
}

const I18N: Record<string, Strings> = {
  en: {
    ...PDFJS_I18N.en,
    converting: 'Converting to PDF…',
    failedConvert: 'Office document conversion failed: {msg}',
  },
  zh: {
    ...PDFJS_I18N.zh,
    converting: '正在转换为 PDF…',
    failedConvert: 'Office 文档转换失败:{msg}',
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
    const pages = pagesEl.querySelectorAll('canvas');
    if (pages.length > 0) {
      pageInfoEl.textContent = `${pages.length} / ${pages.length}`;
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
  zoom = 1;
  zoomLevelEl.textContent = '100%';
  statusEl.textContent = T.converting;

  try {
    const pdfBytes = await requestOfficeConvert(path);
    if (token !== renderToken) return;
    await renderPdf(pdfBytes);
  } catch (e) {
    if (token === renderToken) {
      statusEl.textContent = T.failedConvert.replace(
        '{msg}',
        e instanceof Error ? e.message : String(e)
      );
    }
  }
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
        pending.resolve(new Uint8Array(msg.data));
      } else {
        pending.reject(new Error(msg.error || 'conversion failed'));
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