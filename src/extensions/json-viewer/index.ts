import './viewer.css';
import type { HostMessage } from '../../shared/extension-types';
import {
 computeStats,
 formatPath,
 summarize,
 toPretty,
 toMinified,
 type PathSegment,
} from './json-model';

// --- DOM refs -------------------------------------------------------------
const contentEl = document.getElementById('content') as HTMLDivElement;
const toastEl = document.getElementById('toast') as HTMLDivElement;

const expandAllBtn = document.getElementById('expand-all') as HTMLButtonElement;
const collapseAllBtn = document.getElementById('collapse-all') as HTMLButtonElement;
const toggleSearchBtn = document.getElementById('toggle-search') as HTMLButtonElement;
const toggleViewBtn = document.getElementById('toggle-view') as HTMLButtonElement;
const copyPrettyBtn = document.getElementById('copy-pretty') as HTMLButtonElement;
const copyMinBtn = document.getElementById('copy-min') as HTMLButtonElement;

const searchBar = document.getElementById('search-bar') as HTMLDivElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchCount = document.getElementById('search-count') as HTMLSpanElement;
const searchPrevBtn = document.getElementById('search-prev') as HTMLButtonElement;
const searchNextBtn = document.getElementById('search-next') as HTMLButtonElement;
const searchCloseBtn = document.getElementById('search-close') as HTMLButtonElement;

const sizeEl = document.getElementById('status-size') as HTMLSpanElement;
const nodesEl = document.getElementById('status-nodes') as HTMLSpanElement;
const depthEl = document.getElementById('status-depth') as HTMLSpanElement;
const encodingEl = document.getElementById('status-encoding') as HTMLSpanElement;

const sizeLbl = document.getElementById('size-lbl') as HTMLSpanElement;
const nodesLbl = document.getElementById('nodes-lbl') as HTMLSpanElement;
const depthLbl = document.getElementById('depth-lbl') as HTMLSpanElement;
const encodingLbl = document.getElementById('encoding-lbl') as HTMLSpanElement;

/**
 * Above this node count we skip the interactive DOM tree (too many elements to
 * render/search fluidly) and fall back to a syntax-highlighted raw block with a
 * warning. Keeps huge JSON from freezing the iframe.
 */
const MAX_TREE_NODES = 50000;
/** When the tree is large but under the hard cap, auto-collapse below this depth. */
const AUTO_COLLAPSE_NODES = 3000;
const AUTO_COLLAPSE_DEPTH = 2;

// --- i18n -----------------------------------------------------------------
// Mirrors the pattern in pdf-viewer: small per-extension catalog
// resolved via `window.whaleExt.t({ en, zh })`, re-applied on `onLocale`.
interface Strings {
 expandAll: string;
 collapseAll: string;
 find: string;
 rawView: string;
 treeView: string;
 copy: string;
 copyMin: string;
 searchPlaceholder: string;
 copiedJson: string;
 copiedMin: string;
 copiedPath: string;
 copyFailed: string;
 parseError: string;
 largeFile: string;
 size: string;
 nodes: string;
 depth: string;
 encoding: string;
 noValue: string;
}

const I18N: Record<string, Strings> = {
 en: {
 expandAll: 'Expand',
 collapseAll: 'Collapse',
 find: 'Find',
 rawView: 'Raw',
 treeView: 'Tree',
 copy: 'Copy',
 copyMin: 'Copy Min',
 searchPlaceholder: 'Search keys & values…',
 copiedJson: 'Formatted JSON copied',
 copiedMin: 'Minified JSON copied',
 copiedPath: 'Path copied: ',
 copyFailed: 'Copy failed',
 parseError: 'Invalid JSON — showing raw text.',
 largeFile: 'Large document: showing raw text for performance.',
 size: 'Size',
 nodes: 'Nodes',
 depth: 'Depth',
 encoding: 'Encoding',
 noValue: '—',
 },
 zh: {
 expandAll: '展开',
 collapseAll: '折叠',
 find: '查找',
 rawView: '源码',
 treeView: '树形',
 copy: '复制',
 copyMin: '复制压缩',
 searchPlaceholder: '搜索键与值…',
 copiedJson: '已复制格式化 JSON',
 copiedMin: '已复制压缩 JSON',
 copiedPath: '已复制路径:',
 copyFailed: '复制失败',
 parseError: 'JSON 无效 —— 显示原始文本。',
 largeFile: '文档过大:为性能显示原始文本。',
 size: '大小',
 nodes: '节点',
 depth: '深度',
 encoding: '编码',
 noValue: '—',
 },
};

let T: Strings = I18N.en;

function applyLocale() {
 T = window.whaleExt.t(I18N);
 document.documentElement.lang = window.whaleExt.locale;
 expandAllBtn.textContent = T.expandAll;
 collapseAllBtn.textContent = T.collapseAll;
 toggleSearchBtn.textContent = T.find;
 toggleViewBtn.textContent = rawMode ? T.treeView : T.rawView;
 copyPrettyBtn.textContent = T.copy;
 copyMinBtn.textContent = T.copyMin;
 searchInput.placeholder = T.searchPlaceholder;
 sizeLbl.textContent = T.size;
 nodesLbl.textContent = T.nodes;
 depthLbl.textContent = T.depth;
 encodingLbl.textContent = T.encoding;
 encodingEl.textContent = 'UTF-8';
 updateStatusBar();
}

// --- Theme ----------------------------------------------------------------
function detectInitialTheme(): 'light' | 'dark' {
 try {
 if (
 typeof window !== 'undefined' &&
 typeof window.matchMedia === 'function' &&
 window.matchMedia('(prefers-color-scheme: dark)').matches
 ) {
 return 'dark';
 }
 } catch {
 // jsdom / older browsers: fall through to light
 }
 return 'light';
}

function applyTheme(theme: 'light' | 'dark') {
 document.body.setAttribute('data-theme', theme);
}

// --- Status bar -----------------------------------------------------------
function formatBytes(bytes: number): string {
 if (bytes < 1024) return `${bytes} B`;
 if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
 if (bytes < 1024 * 1024 * 1024)
 return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
 return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const numberFormatter = new Intl.NumberFormat();

interface DocState {
 raw: string;
 size: number | undefined;
 parsed: boolean;
 nodes: number;
 depth: number;
}

let state: DocState = {
 raw: '',
 size: undefined,
 parsed: false,
 nodes: 0,
 depth: 0,
};
let currentValue: unknown;
let rawMode = false;

function updateStatusBar() {
 try {
 sizeEl.textContent =
 typeof state.size === 'number' && state.size >= 0
 ? formatBytes(state.size)
 : T.noValue;
 nodesEl.textContent = state.parsed
 ? numberFormatter.format(state.nodes)
 : T.noValue;
 depthEl.textContent = state.parsed
 ? numberFormatter.format(state.depth)
 : T.noValue;
 } catch {
 sizeEl.textContent = T.noValue;
 nodesEl.textContent = T.noValue;
 depthEl.textContent = T.noValue;
 }
}

// --- Clipboard ------------------------------------------------------------
// Prefer the async Clipboard API; fall back to a hidden textarea + execCommand
// for sandboxed iframes where navigator.clipboard may be unavailable. No host
// IPC needed for plain text (unlike image-editor's binary clipboard bridge).
async function copyText(text: string): Promise<boolean> {
 try {
 if (navigator.clipboard && navigator.clipboard.writeText) {
 await navigator.clipboard.writeText(text);
 return true;
 }
 } catch {
 // fall through to execCommand
 }
 try {
 const ta = document.createElement('textarea');
 ta.value = text;
 ta.style.position = 'fixed';
 ta.style.left = '-9999px';
 document.body.appendChild(ta);
 ta.select();
 const ok = document.execCommand('copy');
 document.body.removeChild(ta);
 return ok;
 } catch {
 return false;
 }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(msg: string) {
 toastEl.textContent = msg;
 toastEl.hidden = false;
 if (toastTimer) clearTimeout(toastTimer);
 toastTimer = setTimeout(() => {
 toastEl.hidden = true;
 }, 1600);
}

async function copyAndToast(text: string, okMsg: string) {
 const ok = await copyText(text);
 showToast(ok ? okMsg : T.copyFailed);
}

// --- HTML escaping --------------------------------------------------------
function escapeHtml(str: string): string {
 return str
 .replace(/&/g, '&amp;')
 .replace(/</g, '&lt;')
 .replace(/>/g, '&gt;');
}

// --- Tree rendering -------------------------------------------------------
// Builds the interactive DOM. Each container row carries data-path so a click
// (outside the toggle) copies its JSONPath; the toggle arrow expands/collapses.

function primitiveSpan(value: unknown): string {
 if (value === null) return '<span class="json-null">null</span>';
 if (typeof value === 'boolean')
 return `<span class="json-boolean">${String(value)}</span>`;
 if (typeof value === 'number')
 return `<span class="json-number">${escapeHtml(String(value))}</span>`;
 if (typeof value === 'string')
 return `<span class="json-string">"${escapeHtml(value)}"</span>`;
 return `<span>${escapeHtml(String(value))}</span>`;
}

function keyHtml(key: string | number | null): string {
 if (key === null) return '';
 if (typeof key === 'number') return '';
 return `<span class="key">"${escapeHtml(key)}"</span><span class="colon">: </span>`;
}

/** Render one value (with its key) into a `.row` element. */
function renderNode(
 key: string | number | null,
 value: unknown,
 segments: PathSegment[],
 depth: number,
 isLast: boolean
): HTMLElement {
 const row = document.createElement('div');
 row.className = 'row';
 const pad = 14 * depth;
 const comma = isLast ? '' : '<span class="comma">,</span>';

 const isArr = Array.isArray(value);
 const isObj = value !== null && typeof value === 'object' && !isArr;

 if (!isArr && !isObj) {
 // Leaf row.
 const line = document.createElement('div');
 line.className = 'line';
 line.style.paddingLeft = `${pad}px`;
 line.innerHTML = `<span class="toggle-spacer"></span>${keyHtml(
 key
 )}${primitiveSpan(value)}${comma}`;
 row.appendChild(line);
 wirePathCopy(line, segments);
 return row;
 }

 // Container row (object or array).
 row.classList.add('container');
 const entries: Array<[string | number, unknown]> = isArr
 ? (value as unknown[]).map((v, i) => [i, v])
 : Object.entries(value as Record<string, unknown>);

 const open = isArr ? '[' : '{';
 const close = isArr ? ']' : '}';

 const line = document.createElement('div');
 line.className = 'line';
 line.style.paddingLeft = `${pad}px`;

 if (entries.length === 0) {
 // Empty container renders inline; no toggle needed.
 line.innerHTML = `<span class="toggle-spacer"></span>${keyHtml(
 key
 )}<span class="bracket">${open}${close}</span>${comma}`;
 row.classList.remove('container');
 row.appendChild(line);
 wirePathCopy(line, segments);
 return row;
 }

 const summaryText = ` ${summarize(value, entries.length)} ${close}`;
 line.innerHTML =
 `<span class="toggle"></span>${keyHtml(key)}` +
 `<span class="bracket">${open}</span>` +
 `<span class="summary">${escapeHtml(summaryText)}</span>`;
 row.appendChild(line);

 const children = document.createElement('div');
 children.className = 'children';
 entries.forEach(([k, v], i) => {
 const childSeg = segments.concat([k]);
 children.appendChild(
 renderNode(k, v, childSeg, depth + 1, i === entries.length - 1)
 );
 });
 // Closing bracket on its own aligned row.
 const closeRow = document.createElement('div');
 closeRow.className = 'line';
 closeRow.style.paddingLeft = `${pad}px`;
 closeRow.innerHTML = `<span class="toggle-spacer"></span><span class="bracket">${close}</span>${comma}`;
 children.appendChild(closeRow);
 row.appendChild(children);

 // Toggle expand/collapse on the arrow; path copy on the rest of the line.
 const toggle = line.querySelector('.toggle') as HTMLElement;
 toggle.addEventListener('click', (e) => {
 e.stopPropagation();
 row.classList.toggle('collapsed');
 });
 wirePathCopy(line, segments);

 if (state.nodes >= AUTO_COLLAPSE_NODES && depth >= AUTO_COLLAPSE_DEPTH) {
 row.classList.add('collapsed');
 }
 return row;
}

function wirePathCopy(line: HTMLElement, segments: PathSegment[]) {
 line.addEventListener('click', (e) => {
 // Ignore clicks that land on the toggle (handled separately).
 if ((e.target as HTMLElement).classList.contains('toggle')) return;
 const path = formatPath(segments);
 void copyAndToast(path, T.copiedPath + path);
 });
}

// --- Raw view -------------------------------------------------------------
function renderRaw(pretty: boolean, warning: boolean) {
 contentEl.classList.add('raw');
 const text = state.parsed
 ? pretty
 ? toPretty(currentValue)
 : state.raw
 : state.raw;
 const banner = warning
 ? `<div id="warning">${escapeHtml(T.largeFile)}</div>`
 : '';
 contentEl.innerHTML = `${banner}<div>${escapeHtml(text)}</div>`;
}

function renderError() {
 contentEl.classList.add('raw');
 contentEl.innerHTML = `<div id="error">${escapeHtml(
 T.parseError
 )}</div><div>${escapeHtml(state.raw)}</div>`;
}

// --- Top-level render -----------------------------------------------------
function render() {
 clearSearch();
 contentEl.classList.remove('raw');
 contentEl.innerHTML = '';

 if (!state.parsed) {
 renderError();
 setTreeControlsEnabled(false);
 return;
 }

 if (state.nodes > MAX_TREE_NODES) {
 // Hard cap: raw fallback, tree controls disabled.
 rawMode = true;
 toggleViewBtn.textContent = T.treeView;
 renderRaw(true, true);
 setTreeControlsEnabled(false);
 return;
 }

 setTreeControlsEnabled(true);

 if (rawMode) {
 toggleViewBtn.textContent = T.treeView;
 renderRaw(true, false);
 return;
 }

 toggleViewBtn.textContent = T.rawView;
 const rootIsContainer =
 currentValue !== null && typeof currentValue === 'object';
 const rootRow = renderNode(null, currentValue, [], 0, true);
 // Root of a container should never be auto-collapsed.
 if (rootIsContainer) rootRow.classList.remove('collapsed');
 contentEl.appendChild(rootRow);
}

function setTreeControlsEnabled(enabled: boolean) {
 expandAllBtn.disabled = !enabled;
 collapseAllBtn.disabled = !enabled;
 toggleSearchBtn.disabled = !enabled;
}

function setAllCollapsed(collapsed: boolean) {
 const containers = contentEl.querySelectorAll('.row.container');
 containers.forEach((el, idx) => {
 // Keep the very first (root) container expanded when collapsing all.
 if (collapsed && idx === 0) {
 el.classList.remove('collapsed');
 } else {
 el.classList.toggle('collapsed', collapsed);
 }
 });
}

// --- Search ---------------------------------------------------------------
interface Match {
 el: HTMLElement;
 original: string;
}
let matches: Match[] = [];
let matchIndex = -1;

function clearSearch() {
 matches.forEach((m) => {
 m.el.innerHTML = m.original;
 });
 matches = [];
 matchIndex = -1;
 searchCount.textContent = '0/0';
}

function highlightRange(el: HTMLElement, text: string, query: string): boolean {
 const lower = text.toLowerCase();
 const q = query.toLowerCase();
 if (!lower.includes(q)) return false;
 let html = '';
 let i = 0;
 while (i < text.length) {
 const found = lower.indexOf(q, i);
 if (found < 0) {
 html += escapeHtml(text.slice(i));
 break;
 }
 html += escapeHtml(text.slice(i, found));
 html += `<span class="hl">${escapeHtml(
 text.slice(found, found + q.length)
 )}</span>`;
 i = found + q.length;
 }
 el.innerHTML = html;
 return true;
}

function runSearch(query: string) {
 clearSearch();
 if (!query || rawMode || !state.parsed) {
 return;
 }
 // Search key + value spans across the tree.
 const spans = contentEl.querySelectorAll<HTMLElement>(
 '.key, .json-string, .json-number, .json-boolean, .json-null'
 );
 spans.forEach((span) => {
 const text = span.textContent ?? '';
 if (!text.toLowerCase().includes(query.toLowerCase())) return;
 const original = span.innerHTML;
 // One navigable entry per matching span (a span may hold several hl marks).
 if (highlightRange(span, text, query)) {
 matches.push({ el: span, original });
 }
 });

 if (matches.length > 0) {
 matchIndex = 0;
 focusMatch();
 } else {
 searchCount.textContent = '0/0';
 }
}

function expandAncestors(el: HTMLElement) {
 let cur: HTMLElement | null = el;
 while (cur && cur !== contentEl) {
 if (cur.classList.contains('row') && cur.classList.contains('collapsed')) {
 cur.classList.remove('collapsed');
 }
 cur = cur.parentElement;
 }
}

function focusMatch() {
 matches.forEach((m) =>
 m.el.querySelectorAll('.hl').forEach((h) => h.classList.remove('current'))
 );
 if (matchIndex < 0 || matchIndex >= matches.length) return;
 const m = matches[matchIndex];
 expandAncestors(m.el);
 m.el.querySelectorAll('.hl').forEach((h) => h.classList.add('current'));
 m.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
 searchCount.textContent = `${matchIndex + 1}/${matches.length}`;
}

function stepMatch(delta: number) {
 if (matches.length === 0) return;
 matchIndex = (matchIndex + delta + matches.length) % matches.length;
 focusMatch();
}

function openSearch() {
 if (rawMode || !state.parsed) return;
 searchBar.hidden = false;
 toggleSearchBtn.classList.add('active');
 searchInput.focus();
 searchInput.select();
}

function closeSearch() {
 searchBar.hidden = true;
 toggleSearchBtn.classList.remove('active');
 clearSearch();
}

// --- Wire controls --------------------------------------------------------
expandAllBtn.addEventListener('click', () => setAllCollapsed(false));
collapseAllBtn.addEventListener('click', () => setAllCollapsed(true));

toggleSearchBtn.addEventListener('click', () => {
 if (searchBar.hidden) openSearch();
 else closeSearch();
});

toggleViewBtn.addEventListener('click', () => {
 if (state.nodes > MAX_TREE_NODES) return; // locked to raw
 rawMode = !rawMode;
 if (rawMode) closeSearch();
 render();
});

copyPrettyBtn.addEventListener('click', () => {
 const text = state.parsed ? toPretty(currentValue) : state.raw;
 void copyAndToast(text, T.copiedJson);
});
copyMinBtn.addEventListener('click', () => {
 const text = state.parsed ? toMinified(currentValue) : state.raw;
 void copyAndToast(text, T.copiedMin);
});

let searchDebounce: ReturnType<typeof setTimeout> | undefined;
searchInput.addEventListener('input', () => {
 if (searchDebounce) clearTimeout(searchDebounce);
 searchDebounce = setTimeout(() => runSearch(searchInput.value.trim()), 150);
});
searchInput.addEventListener('keydown', (e) => {
 if (e.key === 'Enter') {
 e.preventDefault();
 stepMatch(e.shiftKey ? -1 : 1);
 } else if (e.key === 'Escape') {
 e.preventDefault();
 closeSearch();
 }
});
searchPrevBtn.addEventListener('click', () => stepMatch(-1));
searchNextBtn.addEventListener('click', () => stepMatch(1));
searchCloseBtn.addEventListener('click', () => closeSearch());

window.addEventListener('keydown', (e) => {
 const mod = e.ctrlKey || e.metaKey;
 if (mod && (e.key === 'f' || e.key === 'F')) {
 e.preventDefault();
 openSearch();
 }
});

// --- Load / parse ---------------------------------------------------------
function renderContent(content: string, size: number | undefined) {
 let parsed = true;
 let value: unknown;
 try {
 value = JSON.parse(content);
 } catch {
 parsed = false;
 }

 const stats = parsed ? computeStats(value) : { nodes: 0, depth: 0 };
 currentValue = value;
 state = {
 raw: content,
 size,
 parsed,
 nodes: stats.nodes,
 depth: stats.depth,
 };
 rawMode = false;
 render();
 updateStatusBar();
}

// --- Host message bridge --------------------------------------------------
window.whaleExt.onMessage((msg: HostMessage) => {
 switch (msg.type) {
 case 'fileContent': {
 const m = msg as Extract<HostMessage, { type: 'fileContent' }>;
 renderContent(m.content, m.size);
 break;
 }
 case 'setTheme':
 applyTheme(msg.theme);
 break;
 default:
 break;
 }
});

window.whaleExt.onLocale(() => {
 applyLocale();
});

// Initial paint: OS-guessed theme first (avoids white flash on dark hosts),
// then labels, then announce ready so the host streams fileContent/setTheme.
applyTheme(detectInitialTheme());
applyLocale();
updateStatusBar();
window.whaleExt.postMessage({ type: 'ready' });
