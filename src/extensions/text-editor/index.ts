import './editor.css';
import { EditorState, Extension, Compartment } from '@codemirror/state';
import {
 EditorView,
 keymap,
 lineNumbers,
 highlightActiveLineGutter,
 highlightActiveLine,
 drawSelection,
 ViewUpdate,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { oneDark } from '@codemirror/theme-one-dark';
import { markdown } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import {
 foldGutter,
 foldKeymap,
 foldAll,
 unfoldAll,
 foldState,
} from '@codemirror/language';
import {
 search,
 openSearchPanel,
 searchKeymap,
 highlightSelectionMatches,
 getSearchQuery,
 replaceAll,
 gotoLine,
} from '@codemirror/search';
import type { HostMessage } from '../../shared/extension-types';

import {
 STATUS_NO_VALUE,
 DEFAULT_FONT_SIZE,
 clampFontSize,
 stepFontSize,
 getCursorPosition,
 parseEncoding,
 loadFontSize,
 persistFontSize,
 loadWrapMode,
 persistWrapMode,
 supportsFolding,
 countMatches,
 type WrapMode,
} from './editor-stats';

// --- Module-scope state --------------------------------------------------

let view: EditorView | null = null;
let currentPath: string | null = null;
let currentEncoding: 'utf8' | 'base64' = 'utf8';

const themeCompartment = new Compartment();
const readOnlyCompartment = new Compartment();
const fontSizeCompartment = new Compartment();
const wrapCompartment = new Compartment();
const foldGutterCompartment = new Compartment();
const langCompartment = new Compartment();

// Hydrate persisted UI state. localStorage may throw in privacy mode; the
// helpers themselves wrap in try/catch and fall back to defaults.
const uiState = {
 fontSize: loadFontSize(),
 wrapMode: loadWrapMode(),
 foldingAvailable: false,
};

// --- DOM refs ------------------------------------------------------------

const findBtn = document.getElementById('btn-find') as HTMLButtonElement;
const replaceAllBtn = document.getElementById('btn-replace-all') as HTMLButtonElement;
const gotoLineBtn = document.getElementById('btn-goto-line') as HTMLButtonElement;
const toggleWrapBtn = document.getElementById('btn-toggle-wrap') as HTMLButtonElement;
const foldAllBtn = document.getElementById('btn-fold-all') as HTMLButtonElement;
const unfoldAllBtn = document.getElementById('btn-unfold-all') as HTMLButtonElement;
const zoomOutBtn = document.getElementById('btn-zoom-out') as HTMLButtonElement;
const zoomResetBtn = document.getElementById('btn-zoom-reset') as HTMLButtonElement;
const zoomInBtn = document.getElementById('btn-zoom-in') as HTMLButtonElement;
const wrapStateEl = document.getElementById('wrap-state') as HTMLSpanElement;
const toastEl = document.getElementById('toast') as HTMLDivElement;

const lnEl = document.getElementById('status-ln') as HTMLSpanElement;
const colEl = document.getElementById('status-col') as HTMLSpanElement;
const lenEl = document.getElementById('status-length') as HTMLSpanElement;
const selEl = document.getElementById('status-sel') as HTMLSpanElement;
const matchesEl = document.getElementById('status-matches') as HTMLSpanElement;
const encodingEl = document.getElementById('status-encoding') as HTMLSpanElement;

const lnLbl = document.getElementById('ln-lbl') as HTMLSpanElement;
const colLbl = document.getElementById('col-lbl') as HTMLSpanElement;
const lengthLbl = document.getElementById('length-lbl') as HTMLSpanElement;
const selLbl = document.getElementById('sel-lbl') as HTMLSpanElement;
const matchesLbl = document.getElementById('matches-lbl') as HTMLSpanElement;
const encodingLbl = document.getElementById('encoding-lbl') as HTMLSpanElement;

// --- i18n ----------------------------------------------------------------
// Mirrors pdf-viewer / json-viewer: small catalog
// resolved via `window.whaleExt.t(I18N)`, re-applied on host `setLocale`.

interface Strings {
 // Toolbar buttons
 find: string;
 toggleWrap: string;
 zoomIn: string;
 zoomOut: string;
 zoomReset: string;
 // Wrap state indicator
 wrapOn: string;
 wrapOff: string;
 // Batch 2: new toolbar buttons
 foldAll: string;
 unfoldAll: string;
 replaceAll: string;
 gotoLine: string;
 // Status bar labels
 line: string;
 column: string;
 length: string;
 selection: string;
 matches: string;
 encoding: string;
 // Tooltips / shortcuts
 findShortcut: string;
 replaceShortcut: string;
 nextShortcut: string;
 prevShortcut: string;
 gotoLineShortcut: string;
 wrapShortcut: string;
 zoomInShortcut: string;
 zoomOutShortcut: string;
 zoomResetShortcut: string;
 // Batch 2: extra shortcuts + toast template
 foldAllShortcut: string;
 unfoldAllShortcut: string;
 /** Template with `{count}` placeholder; replaced at runtime. */
 replacedN: string;
}

const I18N: Record<string, Strings> = {
 en: {
 find: '⌕ Find',
 toggleWrap: '↩ Wrap',
 zoomIn: 'A+',
 zoomOut: 'A−',
 zoomReset: 'A',
 wrapOn: 'Wrap: On',
 wrapOff: 'Wrap: No Wrap',
 foldAll: '⊟ Fold All',
 unfoldAll: '⊞ Unfold All',
 replaceAll: 'Replace All',
 gotoLine: '↪ Goto',
 line: 'Ln',
 column: 'Col',
 length: 'Length',
 selection: 'Sel',
 matches: 'Matches',
 encoding: 'Encoding',
 findShortcut: 'Find / Replace (Ctrl+F)',
 replaceShortcut: 'Replace (Ctrl+H)',
 nextShortcut: 'Next (F3)',
 prevShortcut: 'Prev (Shift+F3)',
 gotoLineShortcut: 'Goto Line (Ctrl+Alt+G)',
 wrapShortcut: 'Toggle Word Wrap (Ctrl+Shift+P)',
 zoomInShortcut: 'Zoom In (Ctrl++)',
 zoomOutShortcut: 'Zoom Out (Ctrl+-)',
 zoomResetShortcut: 'Actual Size (Ctrl+0)',
 foldAllShortcut: 'Fold All (Ctrl+Alt+[)',
 unfoldAllShortcut: 'Unfold All (Ctrl+Alt+])',
 replacedN: 'Replaced {count} matches',
 },
 zh: {
 find: '⌕ 查找',
 toggleWrap: '↩ 换行',
 zoomIn: 'A+',
 zoomOut: 'A−',
 zoomReset: 'A',
 wrapOn: '换行: 开',
 wrapOff: '换行: 关',
 foldAll: '⊟ 全部折叠',
 unfoldAll: '⊞ 全部展开',
 replaceAll: '全部替换',
 gotoLine: '↪ 跳转',
 line: '行',
 column: '列',
 length: '长度',
 selection: '已选',
 matches: '匹配',
 encoding: '编码',
 findShortcut: '查找 / 替换 (Ctrl+F)',
 replaceShortcut: '替换 (Ctrl+H)',
 nextShortcut: '下一个 (F3)',
 prevShortcut: '上一个 (Shift+F3)',
 gotoLineShortcut: '跳转行 (Ctrl+Alt+G)',
 wrapShortcut: '切换换行 (Ctrl+Shift+P)',
 zoomInShortcut: '放大 (Ctrl++)',
 zoomOutShortcut: '缩小 (Ctrl+-)',
 zoomResetShortcut: '实际大小 (Ctrl+0)',
 foldAllShortcut: '全部折叠 (Ctrl+Alt+[)',
 unfoldAllShortcut: '全部展开 (Ctrl+Alt+])',
 replacedN: '已替换 {count} 处',
 },
};

let T: Strings = I18N.en;

function applyLocale() {
 T = window.whaleExt.t(I18N);
 document.documentElement.lang = window.whaleExt.locale;

 // Toolbar buttons
 findBtn.textContent = T.find;
 replaceAllBtn.textContent = T.replaceAll;
 gotoLineBtn.textContent = T.gotoLine;
 toggleWrapBtn.textContent = T.toggleWrap;
 foldAllBtn.textContent = T.foldAll;
 unfoldAllBtn.textContent = T.unfoldAll;
 zoomInBtn.textContent = T.zoomIn;
 zoomOutBtn.textContent = T.zoomOut;
 zoomResetBtn.textContent = T.zoomReset;

 // Toolbar button tooltips
 findBtn.title = T.findShortcut;
 replaceAllBtn.title = T.replaceShortcut;
 gotoLineBtn.title = T.gotoLineShortcut;
 toggleWrapBtn.title = T.wrapShortcut;
 foldAllBtn.title = T.foldAllShortcut;
 unfoldAllBtn.title = T.unfoldAllShortcut;
 zoomInBtn.title = T.zoomInShortcut;
 zoomOutBtn.title = T.zoomOutShortcut;
 zoomResetBtn.title = T.zoomResetShortcut;

 // Wrap state indicator
 wrapStateEl.textContent = uiState.wrapMode === 'wrap' ? T.wrapOn : T.wrapOff;

 // Status bar labels
 lnLbl.textContent = T.line;
 colLbl.textContent = T.column;
 lengthLbl.textContent = T.length;
 selLbl.textContent = T.selection;
 matchesLbl.textContent = T.matches;
 encodingLbl.textContent = T.encoding;

 // Encoding value (depends on the file the host sent)
 encodingEl.textContent = parseEncoding(currentEncoding);

 // Matches field: re-compute the count under the new label
 // (label may be empty in some catalogs; matchesEl value already set).
}

// --- Theme ----------------------------------------------------------------
// Initial theme is guessed from the OS so the first frame matches the host
// (avoids the white-flash that plain `applyTheme('light')` shows on dark
// hosts). The host's `setTheme` then overwrites this within milliseconds.

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
 // jsdom / older browsers: fall through to 'light'
 }
 return 'light';
}

function applyTheme(theme: 'light' | 'dark') {
 document.body.setAttribute('data-theme', theme);
 if (!view) return;
 // Reconfigure the editor's syntax-highlighting theme to match. oneDark
 // expects a dark parent; on light we pass an empty array so the CM
 // default light theme shows through.
 view.dispatch({
 effects: themeCompartment.reconfigure(theme === 'dark' ? oneDark : []),
 });
 // Refresh the status bar so encoding / length labels pick up new theme.
 updateStatusBar();
}

// --- Language extensions -------------------------------------------------

function languageExtensionFor(filePath: string): Extension {
 const dot = filePath.lastIndexOf('.');
 if (dot < 0 || dot === filePath.length - 1) return [];
 const ext = filePath.slice(dot + 1).toLowerCase();
 switch (ext) {
 case 'md':
 return markdown();
 case 'json':
 return json();
 case 'js':
 case 'ts':
 case 'mjs':
 case 'cjs':
 return javascript({ typescript: ext === 'ts' });
 case 'css':
 return css();
 case 'html':
 case 'htm':
 return html();
 case 'xml':
 return xml();
 case 'yaml':
 case 'yml':
 return yaml();
 default:
 return [];
 }
}

// --- State mutators ------------------------------------------------------

function applyWrap(mode: WrapMode) {
 uiState.wrapMode = mode;
 persistWrapMode(mode);
 if (!view) return;
 view.dispatch({
 effects: wrapCompartment.reconfigure(
 mode === 'wrap' ? EditorView.lineWrapping : [],
 ),
 });
 wrapStateEl.textContent = mode === 'wrap' ? T.wrapOn : T.wrapOff;
 toggleWrapBtn.classList.toggle('active', mode === 'wrap');
}

function applyFontSize(px: number) {
 const clamped = clampFontSize(px);
 uiState.fontSize = clamped;
 persistFontSize(clamped);
 if (!view) return;
 view.dispatch({
 effects: fontSizeCompartment.reconfigure(
 EditorView.theme({
 '&': { fontSize: `${clamped}px` },
 '.cm-content': { fontSize: `${clamped}px` },
 }),
 ),
 });
 // Disable zoom buttons at the boundaries so the user gets a visual hint
 // that the limit has been hit.
 zoomInBtn.disabled = clamped >= 32; // MAX_FONT_SIZE
 zoomOutBtn.disabled = clamped <= 10; // MIN_FONT_SIZE
}

function zoomIn() {
 applyFontSize(stepFontSize(uiState.fontSize, 1));
 return true;
}

function zoomOut() {
 applyFontSize(stepFontSize(uiState.fontSize, -1));
 return true;
}

function zoomReset() {
 applyFontSize(DEFAULT_FONT_SIZE);
 return true;
}

function toggleWrap() {
 applyWrap(uiState.wrapMode === 'wrap' ? 'nowrap' : 'wrap');
 return true;
}

// --- Toast (replace feedback) ------------------------------------------
// 
// Mirrors the pattern from json-viewer/index.ts:236-244 — a single shared
// timer ensures rapid-fire toasts reset the hide countdown rather than
// stacking or hiding prematurely.

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(msg: string) {
 toastEl.textContent = msg;
 toastEl.hidden = false;
 if (toastTimer) clearTimeout(toastTimer);
 toastTimer = setTimeout(() => {
 toastEl.hidden = true;
 }, 1600);
}

// --- Replace-all + matches counting ------------------------------------
// 
// The replace-all button does its own count-and-replace:
// 1. Read the current SearchQuery from view state
// 2. Count matches in the current doc via editor-stats.countMatches
// 3. Call CM's replaceAll
// 4. Show a toast with the count
// 
// For replace-alls triggered from the search panel itself (the "Replace All"
// button inside the panel's replace row), we listen for transactions with
// userEvent 'input.replace.all' and recompute the count from the doc the
// replace ran on (i.e. update.startState.doc).

function replaceAllAndCount(): boolean {
 if (!view) return false;
 const query = getSearchQuery(view.state);
 if (!query.valid || query.search === '') {
 showToast(T.replacedN.replace('{count}', '0'));
 return false;
 }
 const doc = view.state.doc.toString();
 const count = countMatches(query.search, doc, {
 caseSensitive: query.caseSensitive,
 regex: query.regexp,
 wholeWord: query.wholeWord,
 });
 const ok = replaceAll(view);
 if (ok && count > 0) {
 showToast(T.replacedN.replace('{count}', String(count)));
 } else if (ok) {
 showToast(T.replacedN.replace('{count}', '0'));
 }
 return ok;
}

function updateMatchesField() {
 if (!view) return;
 const query = getSearchQuery(view.state);
 if (!query.valid || query.search === '') {
 matchesEl.textContent = STATUS_NO_VALUE;
 replaceAllBtn.disabled = true;
 return;
 }
 const doc = view.state.doc.toString();
 const count = countMatches(query.search, doc, {
 caseSensitive: query.caseSensitive,
 regex: query.regexp,
 wholeWord: query.wholeWord,
 });
 matchesEl.textContent = numberFormatter.format(count);
 // Enable replace-all only when there's at least one match.
 replaceAllBtn.disabled = count === 0;
}

// --- Fold button state --------------------------------------------------

function updateFoldButtonsState() {
 // Both buttons are disabled when the file has no foldable language.
 // When folding is available, the two are mutually exclusive based on
 // whether anything is currently folded.
 if (!uiState.foldingAvailable) {
 foldAllBtn.disabled = true;
 unfoldAllBtn.disabled = true;
 return;
 }
 if (!view) return;
 const field = view.state.field(foldState, false);
 const hasFolds = !!field && field.size > 0;
 foldAllBtn.disabled = hasFolds;
 unfoldAllBtn.disabled = !hasFolds;
}

// --- Status bar ----------------------------------------------------------

const numberFormatter = new Intl.NumberFormat();

function updateStatusBar() {
 if (!view) return;
 try {
 const stats = getCursorPosition(view.state);
 lnEl.textContent = numberFormatter.format(stats.line);
 colEl.textContent = numberFormatter.format(stats.col);
 lenEl.textContent = numberFormatter.format(stats.docLength);
 selEl.textContent = numberFormatter.format(stats.selectionLength);
 } catch (err) {
 // Never let a status-bar failure block content rendering.
 // eslint-disable-next-line no-console
 console.error('[text-editor] updateStatusBar failed', err);
 lnEl.textContent = STATUS_NO_VALUE;
 colEl.textContent = STATUS_NO_VALUE;
 lenEl.textContent = STATUS_NO_VALUE;
 selEl.textContent = STATUS_NO_VALUE;
 }
 encodingEl.textContent = parseEncoding(currentEncoding);
 // Matches + fold buttons are also "status" in a broad sense — refresh
 // them here so any state change (doc edit, query change) keeps them in
 // sync without the listener having to track multiple update shapes.
 updateMatchesField();
 updateFoldButtonsState();
}

// --- EditorView setup ---------------------------------------------------

function makeUpdateListener() {
 return EditorView.updateListener.of((update: ViewUpdate) => {
 // Dirty marker: only fire on real doc changes. Compartment reconfigures
 // (font-size, wrap, theme, lang switch) produce transactions with
 // docChanged === false, so they don't trigger spurious dirty bits.
 if (update.docChanged && currentPath) {
 window.whaleExt.postMessage({
 type: 'contentChangedInEditor',
 path: currentPath,
 dirty: true,
 });
 }
 // Replace-all toast (catches replace-alls triggered from the search
 // panel itself, not just the toolbar button). CM's replaceAll uses
 // userEvent: 'input.replace.all' (see @codemirror/search/dist/index.js:967).
 if (
 update.transactions.some((t) => t.isUserEvent('input.replace.all')) &&
 update.docChanged
 ) {
 const query = getSearchQuery(update.startState);
 if (query.valid && query.search !== '') {
 const doc = update.startState.doc.toString();
 const count = countMatches(query.search, doc, {
 caseSensitive: query.caseSensitive,
 regex: query.regexp,
 wholeWord: query.wholeWord,
 });
 showToast(T.replacedN.replace('{count}', String(count)));
 }
 }
 // Status bar refresh on doc/selection/viewport changes.
 if (update.docChanged || update.selectionSet || update.viewportChanged) {
 updateStatusBar();
 }
 });
}

const saveKeymap = keymap.of([
 {
 key: 'Mod-s',
 run: () => {
 if (!currentPath || !view) return false;
 if (view.state.readOnly) return false;
 window.whaleExt.postMessage({
 type: 'parentSaveDocument',
 path: currentPath,
 content: view.state.doc.toString(),
 });
 return true;
 },
 },
]);

const zoomKeymap = keymap.of([
 // Ctrl+= is the canonical "zoom in" on US keyboards. Ctrl++ is the
 // shifted form (Ctrl+Shift+=). Both should map to zoomIn.
 { key: 'Mod-=', run: zoomIn, preventDefault: true },
 { key: 'Mod-Shift-=', run: zoomIn, preventDefault: true },
 { key: 'Mod--', run: zoomOut, preventDefault: true },
 { key: 'Mod-0', run: zoomReset, preventDefault: true },
 { key: 'Mod-Shift-p', run: toggleWrap, preventDefault: true },
]);

// Replace-all keyboard shortcut. The search panel's "Replace All" button
// has no keybind by default; we add Ctrl-Shift-Enter as a parallel entry
// that shows the same replace-count toast.
const replaceKeymap = keymap.of([
 { key: 'Mod-Shift-Enter', run: () => replaceAllAndCount(), preventDefault: true },
]);

function createEditor(container: HTMLElement, filePath: string) {
 uiState.foldingAvailable = supportsFolding(filePath);
 const initialTheme = detectInitialTheme();

 const state = EditorState.create({
 doc: '',
 extensions: [
 // --- core editing ---
 lineNumbers(),
 highlightActiveLineGutter(),
 highlightActiveLine(),
 drawSelection(),
 history(),

 // --- search ---
 search({ top: true }),
 highlightSelectionMatches(),

 // --- keymaps (order matters: more specific first) ---
 // searchKeymap must come before defaultKeymap to override Cmd-F.
 // foldKeymap adds Ctrl-Shift-[ / ] to fold/unfold.
 keymap.of([
 ...searchKeymap,
 ...foldKeymap,
 ...historyKeymap,
 ...defaultKeymap,
 ]),
 saveKeymap,
 zoomKeymap,
 replaceKeymap,

 // --- language (re-configurable when file changes) ---
 langCompartment.of(languageExtensionFor(filePath)),

 // --- fold gutter (only when the language has fold nodes) ---
 foldGutterCompartment.of(
 uiState.foldingAvailable ? foldGutter() : [],
 ),

 // --- font size (re-configurable from zoom buttons) ---
 fontSizeCompartment.of(
 EditorView.theme({
 '&': { fontSize: `${uiState.fontSize}px` },
 '.cm-content': { fontSize: `${uiState.fontSize}px` },
 }),
 ),

 // --- soft wrap (re-configurable from toggle button) ---
 wrapCompartment.of(
 uiState.wrapMode === 'wrap' ? EditorView.lineWrapping : [],
 ),

 // --- theme (oneDark on dark hosts, default light on light hosts) ---
 themeCompartment.of(initialTheme === 'dark' ? oneDark : []),

 // --- read-only toggle ---
 readOnlyCompartment.of(EditorView.editable.of(true)),

 // --- dirty tracking + status bar ---
 makeUpdateListener(),
 ],
 });

 view = new EditorView({
 state,
 parent: container,
 });

 // Apply persisted wrap state to the toolbar toggle.
 toggleWrapBtn.classList.toggle('active', uiState.wrapMode === 'wrap');
 wrapStateEl.textContent =
 uiState.wrapMode === 'wrap' ? T.wrapOn : T.wrapOff;

 // Apply persisted font size to the zoom button disabled states.
 applyFontSize(uiState.fontSize);

 // Initial state for the new Batch 2 fields.
 updateFoldButtonsState();
 updateMatchesField();
}

function setReadOnly(readOnly: boolean) {
 if (!view) return;
 view.dispatch({
 effects: readOnlyCompartment.reconfigure(EditorView.editable.of(!readOnly)),
 });
}

function setContent(content: string) {
 if (!view) return;
 view.dispatch({
 changes: { from: 0, to: view.state.doc.length, insert: content },
 });
}

function setLanguageFor(filePath: string) {
 if (!view) return;
 uiState.foldingAvailable = supportsFolding(filePath);
 view.dispatch({
 effects: [
 langCompartment.reconfigure(languageExtensionFor(filePath)),
 foldGutterCompartment.reconfigure(
 uiState.foldingAvailable ? foldGutter() : [],
 ),
 ],
 });
 // Sync the Fold All / Unfold All button states with the new language
 // (they're disabled when the language has no foldable nodes).
 updateFoldButtonsState();
 // Reset the matches field too — a new file means the previous search
 // query is no longer relevant. The user can re-open the search panel.
 matchesEl.textContent = STATUS_NO_VALUE;
 replaceAllBtn.disabled = true;
}

// --- Toolbar wiring ------------------------------------------------------
// CSP forbids inline `onclick` handlers; use addEventListener everywhere.

findBtn.addEventListener('click', () => {
 if (!view) return;
 openSearchPanel(view);
});

replaceAllBtn.addEventListener('click', () => {
 replaceAllAndCount();
});

gotoLineBtn.addEventListener('click', () => {
 if (!view) return;
 gotoLine(view);
});

toggleWrapBtn.addEventListener('click', () => {
 toggleWrap();
});

foldAllBtn.addEventListener('click', () => {
 if (!view) return;
 if (foldAll(view)) updateFoldButtonsState();
});

unfoldAllBtn.addEventListener('click', () => {
 if (!view) return;
 if (unfoldAll(view)) updateFoldButtonsState();
});

zoomInBtn.addEventListener('click', () => zoomIn());
zoomOutBtn.addEventListener('click', () => zoomOut());
zoomResetBtn.addEventListener('click', () => zoomReset());

// --- Host message bridge ------------------------------------------------

function handleMessage(msg: HostMessage) {
 switch (msg.type) {
 case 'fileContent': {
 currentPath = msg.path;
 currentEncoding = msg.encoding;
 if (!view) {
 const container = document.getElementById('editor') as HTMLDivElement;
 createEditor(container, msg.path);
 } else if (msg.path !== currentPath) {
 // A different file is being opened — swap language + folding.
 setLanguageFor(msg.path);
 }
 setContent(msg.content);
 setReadOnly(msg.readOnly);
 // Apply the host's current theme (in case it switched between file
 // opens). On first file open this is a no-op (applyTheme already
 // ran with the OS-guessed theme at startup).
 const currentBodyTheme = document.body.getAttribute('data-theme');
 applyTheme(currentBodyTheme === 'dark' ? 'dark' : 'light');
 updateStatusBar();
 // Scroll to top on new file so the user lands at the start.
 view?.scrollDOM.scrollTo({ top: 0 });
 break;
 }
 case 'setTheme':
 applyTheme(msg.theme);
 break;
 case 'setReadOnly':
 setReadOnly(msg.readOnly);
 break;
 case 'savingFile':
 if (currentPath) {
 window.whaleExt.postMessage({
 type: 'contentChangedInEditor',
 path: currentPath,
 dirty: false,
 });
 }
 break;
 case 'requestSave':
 if (currentPath && view && !view.state.readOnly) {
 window.whaleExt.postMessage({
 type: 'parentSaveDocument',
 path: currentPath,
 content: view.state.doc.toString(),
 });
 }
 break;
 case 'requestSelection':
 if (currentPath && view) {
 const { from, to } = view.state.selection.main;
 window.whaleExt.postMessage({
 type: 'editorSelection',
 requestId: msg.requestId,
 path: currentPath,
 selectedText: view.state.sliceDoc(from, to),
 from,
 to,
 });
 }
 break;
 case 'applyReplacement':
 if (view && !view.state.readOnly) {
 view.dispatch({
 changes: { from: msg.from, to: msg.to, insert: msg.text },
 selection: { anchor: msg.from + msg.text.length },
 });
 }
 break;
 default:
 break;
 }
}

window.whaleExt.onMessage(handleMessage);
window.whaleExt.onLocale(() => {
 applyLocale();
 updateStatusBar();
});

// --- Initial paint -------------------------------------------------------
// Order matters:
// 1. applyTheme(detectInitialTheme) — first paint is already correct
// 2. applyLocale() — seed labels via T
// 3. postMessage('ready') — host now streams fileContent + setTheme
applyTheme(detectInitialTheme());
applyLocale();
window.whaleExt.postMessage({ type: 'ready' });
