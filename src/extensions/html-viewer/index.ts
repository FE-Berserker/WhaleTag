/**
 * html-viewer — main entry
 *
 * Built-in viewer for `.html` / `.htm` files. Renders sanitized HTML
 * (DOMPurify + manual <style> extraction) in the host document, with a
 * Batch 1 toolbar + status bar + i18n + theme-flash fix on top.
 *
 * Toolbar features (Batch 1, 2026-07-02):
 * - Zoom out / 100%·Fit / Zoom in (CSS `zoom` property)
 * - View toggle (Preview ↔ Source) — source uses textContent escape
 * - Print (window.print())
 * - Images toggle — re-sanitizes with `img` removed from allowlist
 *
 * State persisted to localStorage:
 * - html-viewer.manualZoom number [ZOOM_MIN, ZOOM_MAX]
 * - html-viewer.zoomMode 'manual' | 'fit-width'
 * - html-viewer.imagesEnabled 'true' | 'false'
 *
 * State NOT persisted:
 * - viewMode (always reset to 'preview' on fileContent)
 * - tagCount / lineCount / size (regenerated from each file)
 */

import './viewer.css';
import DOMPurify from 'dompurify';
import type { HostMessage } from '../../shared/extension-types';
import { createViewerPrefs } from '../shared/viewer-prefs';
import {
  onLocaleChange,
  pickStrings,
  syncDocumentLocale,
} from '../shared/i18n';
import { applyThemeToDocument, detectInitialTheme } from '../shared/theme';


import {
 formatBytes,
 countTags,
 extractLines,
 clampZoom,
 computeFitWidthZoom,
 ZOOM_STEP,
 ZOOM_MIN,
 ZOOM_MAX,
} from './html-stats';
import { resolveRelativeHref, resolveRelativeImageSrc } from './resolve-image-src';

// --- DOM refs -------------------------------------------------------------
const contentEl = document.getElementById('content') as HTMLDivElement;
const toolbarEl = document.getElementById('toolbar') as HTMLDivElement;
const zoomOutBtn = document.getElementById('zoom-out') as HTMLButtonElement;
const zoomLevelBtn = document.getElementById('zoom-level') as HTMLButtonElement;
const zoomInBtn = document.getElementById('zoom-in') as HTMLButtonElement;
const viewToggleBtn = document.getElementById('view-toggle') as HTMLButtonElement;
const printBtn = document.getElementById('print') as HTMLButtonElement;
const imagesToggleBtn = document.getElementById('images-toggle') as HTMLButtonElement;

const sizeEl = document.getElementById('status-size') as HTMLSpanElement;
const tagsEl = document.getElementById('status-tags') as HTMLSpanElement;
const linesEl = document.getElementById('status-lines') as HTMLSpanElement;
const encodingEl = document.getElementById('status-encoding') as HTMLSpanElement;
const sizeLbl = document.getElementById('size-lbl') as HTMLSpanElement;
const tagsLbl = document.getElementById('tags-lbl') as HTMLSpanElement;
const linesLbl = document.getElementById('lines-lbl') as HTMLSpanElement;
const encodingLbl = document.getElementById('encoding-lbl') as HTMLSpanElement;

const NO_VALUE = '—';

// --- i18n -----------------------------------------------------------------
// Mirrors json-viewer: small catalog
// resolved via `window.whaleExt.t(I18N)`, re-applied on host `setLocale`.
interface Strings {
 // Status bar
 size: string;
 tags: string;
 lines: string;
 encoding: string;
 noValue: string;
 utf8: string;
 // Toolbar
 zoomIn: string;
 zoomOut: string;
 zoomFitWidth: string;
 zoomReset: string;
 sourceView: string;
 previewView: string;
 print: string;
 imagesOn: string;
 imagesOff: string;
 toggleImages: string;
}

const I18N: Record<string, Strings> = {
 en: {
 size: 'Size',
 tags: 'Tags',
 lines: 'Lines',
 encoding: 'Encoding',
 noValue: '—',
 utf8: 'UTF-8',
 zoomIn: 'Zoom in',
 zoomOut: 'Zoom out',
 zoomFitWidth: 'Fit width',
 zoomReset: 'Reset zoom to 100%',
 sourceView: 'Source',
 previewView: 'Preview',
 print: 'Print',
 imagesOn: 'Images: On',
 imagesOff: 'Images: Off',
 toggleImages: 'Toggle images',
 },
 zh: {
 size: '大小',
 tags: '标签',
 lines: '行数',
 encoding: '编码',
 noValue: '—',
 utf8: 'UTF-8',
 zoomIn: '放大',
 zoomOut: '缩小',
 zoomFitWidth: '适应宽度',
 zoomReset: '缩放重置为 100%',
 sourceView: '源码',
 previewView: '预览',
 print: '打印',
 imagesOn: '图片: 开',
 imagesOff: '图片: 关',
 toggleImages: '切换图片',
 },
};

let T: Strings = I18N.en;

function applyLocale() {
 T = pickStrings(I18N);
 syncDocumentLocale();
 // Status bar labels
 sizeLbl.textContent = T.size;
 tagsLbl.textContent = T.tags;
 linesLbl.textContent = T.lines;
 encodingLbl.textContent = T.encoding;
 encodingEl.textContent = T.utf8;
 // Toolbar — state-dependent
 if (state.viewMode === 'preview') {
 viewToggleBtn.textContent = T.sourceView;
 viewToggleBtn.setAttribute('aria-label', T.sourceView);
 viewToggleBtn.setAttribute('title', T.sourceView);
 } else {
 viewToggleBtn.textContent = T.previewView;
 viewToggleBtn.setAttribute('aria-label', T.previewView);
 viewToggleBtn.setAttribute('title', T.previewView);
 }
 zoomOutBtn.setAttribute('aria-label', T.zoomOut);
 zoomOutBtn.setAttribute('title', T.zoomOut);
 zoomInBtn.setAttribute('aria-label', T.zoomIn);
 zoomInBtn.setAttribute('title', T.zoomIn);
 zoomLevelBtn.setAttribute('title', T.zoomReset);
 zoomLevelBtn.setAttribute('aria-label', T.zoomReset);
 printBtn.textContent = T.print;
 printBtn.setAttribute('aria-label', T.print);
 printBtn.setAttribute('title', T.print);
 if (state.imagesEnabled) {
 imagesToggleBtn.textContent = T.imagesOn;
 imagesToggleBtn.classList.remove('active');
 } else {
 imagesToggleBtn.textContent = T.imagesOff;
 imagesToggleBtn.classList.add('active');
 }
 imagesToggleBtn.setAttribute('title', T.toggleImages);
 imagesToggleBtn.setAttribute('aria-label', T.toggleImages);
 // Re-render zoom-level label (depends on locale-agnostic number formatting
 // but the label text itself may need re-application after locale change).
 updateZoomLevelLabel();
}

// --- Theme ---------------------------------------------------------------
// First paint + live theme are shared (src/extensions/shared/theme.ts).
// Initial theme is guessed from the OS so the first frame matches the host
// (avoids the white-flash that plain `applyThemeToDocument('light')` shows on dark
// hosts). The host's `setTheme` then overwrites this within milliseconds.
// --- State ----------------------------------------------------------------
type ViewMode = 'preview' | 'source';
type ZoomMode = 'manual' | 'fit-width';

interface State {
 /** Raw HTML as received from host — kept for re-render on image toggle
 * and source/preview switch. */
 raw: string;
 /** Bytes reported by host via FileContentMessage.size (optional). */
 size: number | undefined;
 /** Directory of the HTML file, supplied by the host via `dirPath`. Used to
  * resolve document-relative `<img src>` into `whale-file://` URLs; absent
  * for older hosts, in which case relative images are left untouched. */
 dirPath: string | undefined;
 viewMode: ViewMode;
 zoomMode: ZoomMode;
 manualZoom: number;
 imagesEnabled: boolean;
 /** Cached counters computed once at fileContent. */
 tagCount: number;
 lineCount: number;
}

const state: State = {
 raw: '',
 size: undefined,
 dirPath: undefined,
 viewMode: 'preview',
 zoomMode: 'manual',
 manualZoom: 1,
 imagesEnabled: true,
 tagCount: 0,
 lineCount: 0,
};

/** Last measured fit-width zoom (computed lazily by ResizeObserver). */
let currentFitZoom = 1;

// --- Persistence ----------------------------------------------------------
const prefs = createViewerPrefs('html-viewer.');

function loadPersistedState() {
 const mz = prefs.getPref('manualZoom');
 if (mz !== null) {
 const parsed = parseFloat(mz);
 if (Number.isFinite(parsed)) {
 state.manualZoom = clampZoom(parsed);
 }
 }
 const zm = prefs.getPref('zoomMode');
 if (zm === 'fit-width' || zm === 'manual') {
 state.zoomMode = zm;
 }
 const ie = prefs.getPref('imagesEnabled');
 if (ie === 'false') {
 state.imagesEnabled = false;
 }
}

function persistZoom() {
 prefs.setPref('manualZoom', String(state.manualZoom));
 prefs.setPref('zoomMode', state.zoomMode);
}

function persistImages() {
 prefs.setPref('imagesEnabled', String(state.imagesEnabled));
}

// --- Style extraction -----------------------------------------------------
// Extracted from the previous version verbatim. User <style> blocks are
// moved into <head> for predictable cascade behavior.
function extractStyles(raw: string): { html: string; css: string } {
 const styles: string[] = [];
 const html = raw.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_m, css) => {
 styles.push(css.trim());
 return '';
 });
 return { html, css: styles.join('\n') };
}

// When remote images are disabled, the user stylesheet must not fetch them
// either: `background:url(https://tracker/…)` pings the network on render and
// `@import` pulls in arbitrary CSS. Strip both; `data:` URLs are self-contained
// and stay.
function stripRemoteCssRefs(css: string): string {
  return css
    .replace(/@import[^;]*(;|$)/gi, '')
    .replace(
      /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi,
      (match, _quote: string, target: string) =>
        /^\s*data:/i.test(target) ? match : 'none'
    );
}

// Confine one selector list to the preview root. `html` / `body` / `:root` do
// not exist under `#content`, so map them onto it — a stylesheet written for a
// whole document (`body { background: #fff }`) still styles the preview.
function scopeSelectorText(selectors: string): string {
 return selectors
  .split(',')
  .map((raw) => {
   const sel = raw.trim();
   if (!sel) return sel;
   // A leading `html` / `body` / `:root` chain (optionally `>`-joined) is the
   // preview root itself, not an element inside it: `html body .a` -> `.a`,
   // which then becomes `#content .a` below.
   const stripped = sel.replace(/^(?:(?:html|body|:root)\s*(?:>\s*)?)+/i, '');
   if (!stripped) return '#content';
   if (!stripped.startsWith('#content')) return `#content ${stripped}`;
   if (stripped === sel) return `#content ${sel}`;
   return stripped;
  })
  .join(', ');
}

// Rewrite `sheet` rule selectors in place, descending into @media / @supports.
function scopeRules(rules: CSSRuleList): void {
 for (const rule of Array.from(rules)) {
  if (rule instanceof CSSStyleRule) {
   rule.selectorText = scopeSelectorText(rule.selectorText);
   continue;
  }
  // @media / @supports carry their own rule list; @keyframes children are not
  // CSSStyleRule and simply fall through unchanged.
  const grouping = rule as CSSGroupingRule;
  if (grouping && 'cssRules' in grouping) {
   try {
    scopeRules(grouping.cssRules);
   } catch {
    // Unreadable sub-sheet (e.g. a cross-origin @import); leave it as-is.
   }
  }
 }
}

function injectUserStyle(css: string) {
 if (!css) {
 // A document without a stylesheet must not keep the previous document's.
 document.getElementById('whale-user-style')?.remove();
 return;
 }
 let el = document.getElementById('whale-user-style') as HTMLStyleElement | null;
 if (!el) {
  el = document.createElement('style');
  el.id = 'whale-user-style';
  document.head.appendChild(el);
 }
 el.textContent = css;
 // A <style> in <head> matches the whole extension page, so a document-level
 // rule (`body { display: none }`, `* { ... }`) used to clobber the toolbar and
 // status bar. Scope the parsed selectors to the preview through CSSOM; the
 // element is attached, so `sheet` is available.
 const sheet = el.sheet;
 if (!sheet) return;
 try {
  scopeRules(sheet.cssRules);
 } catch {
  // Leave the unscoped text rather than dropping the user's whole stylesheet.
 }
}

// --- DOMPurify config -----------------------------------------------------
// Allowlist from the previous version. We rebuild it per-render based on
// state.imagesEnabled — see `renderPreview`.
const ALLOWED_ATTRS: ReadonlyArray<string> = [
 'href',
 'title',
 'alt',
 'src',
 'width',
 'height',
 'class',
 'style',
];

const TAGS_BASE: ReadonlyArray<string> = [
 'p',
 'br',
 'hr',
 'h1',
 'h2',
 'h3',
 'h4',
 'h5',
 'h6',
 'ul',
 'ol',
 'li',
 'strong',
 'b',
 'em',
 'i',
 'u',
 's',
 'span',
 'div',
 'a',
 'table',
 'thead',
 'tbody',
 'tr',
 'th',
 'td',
 'blockquote',
 'pre',
 'code',
 'dl',
 'dt',
 'dd',
];

function renderPreview(raw: string) {
 const { html, css } = extractStyles(raw);
 injectUserStyle(state.imagesEnabled ? css : stripRemoteCssRefs(css));

 const allowedTags = state.imagesEnabled ? [...TAGS_BASE, 'img'] : TAGS_BASE;
 const clean = DOMPurify.sanitize(html, {
 USE_PROFILES: { html: true },
 ALLOWED_TAGS: allowedTags as string[],
 ALLOWED_ATTR: ALLOWED_ATTRS as string[],
 });
 contentEl.innerHTML = clean;

 // A relative <img src="./pic.png"> resolves against the extension origin and
 // 404s. Rewrite document-relative images to `whale-file://` URLs under the
 // HTML file's directory so the host can stream sibling/local images. Absolute
 // paths, URLs and `..` traversal are rejected by the resolver (the preview
 // must not become a way to read arbitrary files). Only when images are on:
 // the sanitizer already dropped every <img> when they are off.
 if (state.imagesEnabled && state.dirPath) {
 contentEl.querySelectorAll('img').forEach((img) => {
 const resolved = resolveRelativeImageSrc(img.getAttribute('src'), state.dirPath);
 if (resolved) img.setAttribute('src', resolved);
 });
 }

 // Inline styles survive sanitization (`style` is allow-listed) and
 // `style="background:url(https://tracker/…)"` still pings the network on
 // render even when remote images are disabled — the <img> tags are gone and
 // the user stylesheet is sanitized, but the attributes were not. Rewrite them
 // through the same remote-reference filter (`data:` URLs stay).
 if (!state.imagesEnabled) {
 contentEl.querySelectorAll('[style]').forEach((el) => {
 const style = el.getAttribute('style');
 if (!style) return;
 const stripped = stripRemoteCssRefs(style);
 if (stripped === style) return;
 if (stripped.trim()) el.setAttribute('style', stripped);
 else el.removeAttribute('style');
 });
 }

 // Intercept link clicks so they open in the system browser (preserved from
 // the previous version).
 contentEl.querySelectorAll('a').forEach((a) => {
 a.addEventListener('click', (e) => {
 const href = a.getAttribute('href');
 // `#section` is an in-page anchor: let the preview scroll instead of
 // handing a bare fragment to the host (which can only refuse it).
 if (!href || href.startsWith('#')) return;
 e.preventDefault();
 // A document-relative link (`./notes.pdf`) becomes a `file://` URL under the
 // document's directory, exactly like relative images. Everything else is
 // forwarded as written: http(s) is opened by the host, and main checks any
 // other path against the configured locations.
 window.whaleExt.postMessage({
 type: 'openLinkExternally',
 url: resolveRelativeHref(href, state.dirPath) ?? href,
 });
 });
 });
}

function renderSource(raw: string) {
 // textContent (NOT innerHTML) — escapes every special char; no need to
 // pipe through DOMPurify because we're not interpreting HTML here.
 contentEl.textContent = '';
 const pre = document.createElement('pre');
 pre.className = 'html-source';
 pre.textContent = raw;
 contentEl.appendChild(pre);
}

// --- Zoom -----------------------------------------------------------------
function effectiveZoom(): number {
 return state.zoomMode === 'fit-width' ? currentFitZoom : state.manualZoom;
}

function applyZoom() {
 // CSS `zoom` is non-standard but stable in Blink (Chromium). Used by VS Code
 // and matches html-viewer's intent perfectly: scale everything proportionally
 // including images and tables, with native scrollbar adjustment.
 const z = effectiveZoom();
 contentEl.style.zoom = String(z);
 updateZoomLevelLabel();
}

function updateZoomLevelLabel() {
 if (state.zoomMode === 'fit-width') {
 zoomLevelBtn.textContent = T.zoomFitWidth;
 zoomLevelBtn.classList.add('active');
 } else {
 zoomLevelBtn.textContent = `${Math.round(state.manualZoom * 100)}%`;
 zoomLevelBtn.classList.remove('active');
 }
}

function zoomIn() {
 state.zoomMode = 'manual';
 state.manualZoom = clampZoom(state.manualZoom + ZOOM_STEP);
 persistZoom();
 applyZoom();
}

function zoomOut() {
 state.zoomMode = 'manual';
 state.manualZoom = clampZoom(state.manualZoom - ZOOM_STEP);
 persistZoom();
 applyZoom();
}

function toggleZoomMode() {
 if (state.zoomMode === 'manual') {
 state.zoomMode = 'fit-width';
 } else {
 state.zoomMode = 'manual';
 state.manualZoom = clampZoom(1);
 }
 persistZoom();
 applyZoom();
 // Force a re-measure so the fit-width value is fresh.
 scheduleFitWidthMeasure();
}

function scheduleFitWidthMeasure() {
 // requestAnimationFrame avoids running measurements during the same paint
 // that triggered the zoom change.
 requestAnimationFrame(() => {
 measureFitWidth();
 if (state.zoomMode === 'fit-width') applyZoom();
 });
}

function measureFitWidth() {
 // Temporarily reset zoom to 1 to measure natural content width.
 // We rely on the fact that `scrollWidth` reports content width even when
 // the element has overflow:auto, as long as the element is laid out.
 const prevZoom = contentEl.style.zoom;
 contentEl.style.zoom = '1';
 // Force layout flush.
 contentEl.offsetHeight;
 const containerWidth = contentEl.clientWidth;
 const contentWidth = contentEl.scrollWidth;
 currentFitZoom = computeFitWidthZoom(containerWidth, contentWidth);
 contentEl.style.zoom = prevZoom;
}

// --- Re-render ------------------------------------------------------------
function rerender() {
 if (state.viewMode === 'preview') {
 renderPreview(state.raw);
 } else {
 renderSource(state.raw);
 }
 // fit-width measurement depends on rendered DOM; do it after render.
 scheduleFitWidthMeasure();
}

// --- Toolbar actions ------------------------------------------------------
function onZoomOutClick() {
 zoomOut();
}
function onZoomInClick() {
 zoomIn();
}
function onZoomLevelClick() {
 toggleZoomMode();
}
function onViewToggleClick() {
 state.viewMode = state.viewMode === 'preview' ? 'source' : 'preview';
 if (state.viewMode === 'preview') {
 viewToggleBtn.textContent = T.sourceView;
 viewToggleBtn.setAttribute('aria-label', T.sourceView);
 viewToggleBtn.setAttribute('title', T.sourceView);
 } else {
 viewToggleBtn.textContent = T.previewView;
 viewToggleBtn.setAttribute('aria-label', T.previewView);
 viewToggleBtn.setAttribute('title', T.previewView);
 }
 rerender();
}
function onPrintClick() {
 // window.print() respects @media print rules — viewer.css hides the
 // toolbar and status bar so they don't appear in the printed output.
 window.print();
}
function onImagesToggleClick() {
 state.imagesEnabled = !state.imagesEnabled;
 persistImages();
 if (state.imagesEnabled) {
 imagesToggleBtn.textContent = T.imagesOn;
 imagesToggleBtn.classList.remove('active');
 } else {
 imagesToggleBtn.textContent = T.imagesOff;
 imagesToggleBtn.classList.add('active');
 }
 // Re-render only matters in preview mode (source is just text).
 if (state.viewMode === 'preview') {
 renderPreview(state.raw);
 scheduleFitWidthMeasure();
 }
}

// --- Status bar -----------------------------------------------------------
const numberFormatter = new Intl.NumberFormat();

function updateStatusBar() {
 try {
 if (typeof state.size === 'number' && state.size >= 0) {
 sizeEl.textContent = formatBytes(state.size);
 } else {
 sizeEl.textContent = T.noValue;
 }
 tagsEl.textContent = numberFormatter.format(state.tagCount);
 linesEl.textContent = numberFormatter.format(state.lineCount);
 } catch (err) {
 // Never let a status-bar failure block content rendering.
 console.error('[html-viewer] updateStatusBar failed', err);
 sizeEl.textContent = NO_VALUE;
 tagsEl.textContent = NO_VALUE;
 linesEl.textContent = NO_VALUE;
 }
}

// --- Host message bridge --------------------------------------------------
window.whaleExt.onMessage((msg: HostMessage) => {
 switch (msg.type) {
 case 'fileContent': {
 const m = msg as Extract<HostMessage, { type: 'fileContent' }>;
 state.raw = m.content;
 state.size = m.size;
 state.dirPath = typeof m.dirPath === 'string' ? m.dirPath : undefined;
 state.viewMode = 'preview';
 state.tagCount = countTags(m.content);
 state.lineCount = extractLines(m.content).length;
 rerender();
 updateStatusBar();
 // After re-render, ensure zoom-level label reflects the mode.
 updateZoomLevelLabel();
 break;
 }
 case 'setTheme':
 applyThemeToDocument(msg.theme);
 break;
 default:
 break;
 }
});

onLocaleChange(() => {
  applyLocale();
  updateStatusBar();
});

// --- Keyboard shortcuts ---------------------------------------------------
// Mirrors the shared per-extension keydown pattern minus
// the input-element guard (html-viewer has no input).
window.addEventListener('keydown', (e) => {
 if (e.altKey) return;
 const mod = e.ctrlKey || e.metaKey;
 if (mod) {
 if (e.key === '=' || e.key === '+') {
 e.preventDefault();
 zoomIn();
 return;
 }
 if (e.key === '-' || e.key === '_') {
 e.preventDefault();
 zoomOut();
 return;
 }
 if (e.key === '0') {
 e.preventDefault();
 toggleZoomMode();
 return;
 }
 if (e.key === 'p' || e.key === 'P') {
 // Ctrl/Cmd+P — preventDefault to avoid Chromium's print dialog being
 // invoked twice (once via our button, once via the browser default).
 e.preventDefault();
 window.print();
 return;
 }
 if (e.shiftKey && (e.key === 'S' || e.key === 's')) {
 e.preventDefault();
 onViewToggleClick();
 return;
 }
 }
});

// --- Resize observer ------------------------------------------------------
// Re-measure fit-width whenever the container resizes so the "Fit" button
// stays accurate (e.g. when the user drags the panel edge).
let resizeObserver: ResizeObserver | null = null;
function setupResizeObserver() {
 if (typeof ResizeObserver === 'undefined') return;
 resizeObserver = new ResizeObserver(() => {
 if (state.zoomMode === 'fit-width') {
 measureFitWidth();
 applyZoom();
 }
 });
 resizeObserver.observe(contentEl);
}

// --- Toolbar wiring -------------------------------------------------------
function setupToolbar() {
 zoomOutBtn.addEventListener('click', onZoomOutClick);
 zoomInBtn.addEventListener('click', onZoomInClick);
 zoomLevelBtn.addEventListener('click', onZoomLevelClick);
 viewToggleBtn.addEventListener('click', onViewToggleClick);
 printBtn.addEventListener('click', onPrintClick);
 imagesToggleBtn.addEventListener('click', onImagesToggleClick);
}

// --- Initial paint --------------------------------------------------------
// Order matters (theme + locale + persisted state + toolbar + resize):
// 1. apply OS-guessed theme so first frame matches the host (no flash)
// 2. applyLocale() seeds labels
// 3. loadPersistedState() restores zoom / images from localStorage
// 4. setupToolbar() binds events (safe before `ready` — listeners fire
// only after user interaction)
// 5. setupResizeObserver() wires the ResizeObserver for fit-width
// 6. updateStatusBar() draws the empty-state status
// 7. post `ready` so host streams fileContent + setTheme
applyThemeToDocument(detectInitialTheme());
loadPersistedState();
applyLocale();
setupToolbar();
setupResizeObserver();
updateStatusBar();
applyZoom();
window.whaleExt.postMessage({ type: 'ready' });

// Silence unused-import warnings for type-only / future-use symbols.
void ZOOM_MIN;
void ZOOM_MAX;
void toolbarEl;
