import './editor.css';
import { EditorState, EditorSelection, Extension, Compartment, Transaction } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
} from '@codemirror/view';
import { defaultKeymap, history, historyField, historyKeymap, redo, undo } from '@codemirror/commands';
import { oneDarkTheme } from '@codemirror/theme-one-dark';
import { markdown } from '@codemirror/lang-markdown';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { foldGutter, foldKeymap, HighlightStyle, syntaxHighlighting, foldState, foldEffect, unfoldEffect, codeFolding } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { HostMessage } from '../../shared/extension-types';
import {
  parseMarkdown,
  sanitizeMarkdownHtml,
  setupLinkDelegation,
  createPreviewScheduler,
  highlightCodeBlocks,
  getStatusInfo,
  resolveLocalImages,
  detectInitialTheme,
  shouldSkipRender,
  createRafScheduler,
  extractToc,
  renderToc,
  wrapHtmlDocument,
  triggerDownload,
  renderMermaid,
  renderKatex,
  parseLineInput,
  addCodeCopyButtons,
  attachImageLightbox,
  addLanguageLabels,
  addCodeLineNumbers,
  addTaskInteractivity,
  setCustomCallouts,
} from './md-render';
import { setupSplitter } from './md-splitter';

let view: EditorView | null = null;
let currentPath: string | null = null;
// §18.2.3 — host supplies the file's directory on every `fileContent`
// message (optional, backward-compatible). We cache it here so
// `resolveLocalImages` can rewrite relative `<img src>` paths into
// `whale-file://<encoded>` URLs that the host's Range handler serves.
let currentDir: string | null = null;
// §18.3.5 — dirty flag for the status bar "● Modified" indicator.
// Toggled by the updateListener on every doc change; reset to false
// when the host sends `savingFile` (it has the file on disk and is
// about to write our latest content). The host also sends a follow-up
// `contentChangedInEditor { dirty: false }` in some flows, but
// `savingFile` is the canonical "we own the latest content" signal.
let isDirty = false;

// Race-free preview scheduler (see md-render.ts §18.1.2). One instance for
// the lifetime of the editor; each schedule() mints a new token + clears
// the prior timer. setContent / fileContent paths call cancel() before
// swapping the view, so no stale render can fire against a replaced doc.
const scheduler = createPreviewScheduler(300);

// §18.2.4 — inner-rAF scheduler that aligns the actual `innerHTML = clean`
// mutation with the next browser repaint. Without this, the 300ms debounce
// can fire mid-paint and cause flicker on large documents. rAF also lets
// us collapse multiple back-to-back timer fires (e.g. setContent +
// a stray updateListener) into a single repaint.
const rafScheduler = createRafScheduler();

// §18.2.4 — cache of the last source markdown we rendered, used to
// short-circuit identical re-renders. The scheduler + rAF collapse
// frequency; the cache collapses equality. Without it, a paste that
// produces the same final text as the previous render still triggers
// a full parse + sanitize + DOM swap.
let lastRenderedContent: string | null = null;

const themeCompartment = new Compartment();
const readOnlyCompartment = new Compartment();
const fontSizeCompartment = new Compartment();
const wrapCompartment = new Compartment();

const editorPane = document.getElementById('editor-pane') as HTMLDivElement;
const previewPane = document.getElementById('preview-pane') as HTMLDivElement;
const splitterEl = document.getElementById('splitter') as HTMLDivElement;
const mainRowEl = document.getElementById('main-row') as HTMLDivElement;

// Status bar (see §18.2.2). Patched on every editor update via
// `updateStatus(view)`. Cached element references — getElementById on
// every keystroke would be wasteful.
const statusLnEl = document.getElementById('status-ln') as HTMLSpanElement;
const statusColEl = document.getElementById('status-col') as HTMLSpanElement;
const statusLengthEl = document.getElementById('status-length') as HTMLSpanElement;
const statusSelEl = document.getElementById('status-sel') as HTMLSpanElement;
const statusWordsEl = document.getElementById('status-words') as HTMLSpanElement;
const statusReadonlyEl = document.getElementById('status-readonly') as HTMLSpanElement;
const statusDirtyEl = document.getElementById('status-dirty') as HTMLSpanElement;
// §18.3.5 — undo/redo availability dots. Reflects the `history()`
// extension's stack state — visible when the user can actually undo
// or redo (stack is non-empty). Hidden otherwise.
const statusUndoEl = document.getElementById('status-undo') as HTMLSpanElement;
const statusRedoEl = document.getElementById('status-redo') as HTMLSpanElement;

// Toolbar (see §18.2.1). Element refs are cached for the same reason as
// the status bar — clicked buttons read/write these on every interaction.
const findBtn = document.getElementById('btn-find') as HTMLButtonElement;
const toggleWrapBtn = document.getElementById('btn-toggle-wrap') as HTMLButtonElement;
const zoomOutBtn = document.getElementById('btn-zoom-out') as HTMLButtonElement;
const zoomResetBtn = document.getElementById('btn-zoom-reset') as HTMLButtonElement;
const zoomInBtn = document.getElementById('btn-zoom-in') as HTMLButtonElement;
const wrapStateEl = document.getElementById('wrap-state') as HTMLSpanElement;
const toggleTocBtn = document.getElementById('btn-toggle-toc') as HTMLButtonElement;
const gotoLineBtn = document.getElementById('btn-goto-line') as HTMLButtonElement;
const exportHtmlBtn = document.getElementById('btn-export-html') as HTMLButtonElement;

// §18.3.1 — TOC sidebar elements. The sidebar is a 4th flex child in
// `#main-row`, hidden by default via the `hidden` attribute; the toolbar
// button toggles it. The list container is replaced (innerHTML) on every
// render, so its identity is stable across re-extractions.
const tocSidebarEl = document.getElementById('toc-sidebar') as HTMLElement;
const tocListEl = document.getElementById('toc-list') as HTMLElement;

// §18.3.1 — active TOC entry highlighting.
//
// The doc previously planned IntersectionObserver for this, but the
// architecture here is simpler: `syncPreviewScroll` already computes
// `lineNo` (the source line at the top of the editor viewport) on
// every editor scroll, and `syncPreviewScroll` is also the place
// that drives the preview scroll. So the active heading is known
// synchronously from the editor scroll position — no separate
// observer needed, no async/observers-to-manage, and no risk of
// `overflow: hidden` clipping breaking the observer's viewport math.
//
// Strategy:
//   - `activeTocLine` holds the currently highlighted line number
//     (or null if no heading is in view, e.g. document has no
//     headings or all headings are above the editor top).
//   - `setActiveTocLine(line)` updates the active entry's `.toc-active`
//     class — a cheap DOM walk (N entries, all in one container).
//     Called from `syncPreviewScroll` (editor scroll) and from the
//     TOC click handler (programmatic jump).
//   - When the TOC is re-rendered (e.g. after an edit changes the
//     heading list), the new entries get the class via the preserved
//     `activeTocLine` value.
let activeTocLine: number | null = null;
function setActiveTocLine(line: number | null): void {
  if (activeTocLine === line) return;
  activeTocLine = line;
  // Cheap full-walk: the TOC has at most a few dozen entries, and
  // we're toggling at most one on + one off per call.
  const links = tocListEl.querySelectorAll('a.toc-entry');
  links.forEach((link) => {
    const lineAttr = link.getAttribute('data-toc-line');
    if (lineAttr !== null && Number(lineAttr) === line) {
      link.classList.add('toc-active');
    } else {
      link.classList.remove('toc-active');
    }
  });
}

// --- Toolbar prefs (§18.2.1) --------------------------------------------
//
// localStorage keys are prefixed with `md-editor-` to keep them distinct
// from text-editor's `text-editor-font-size` / `text-editor-wrap-mode`.
// Each helper is defensive (try/catch) so privacy-mode or quota-exceeded
// failures fall back to defaults without throwing.

const MD_FONT_SIZE_KEY = 'md-editor-font-size';
const MD_WRAP_KEY = 'md-editor-wrap-mode';
const MD_DEFAULT_FONT_SIZE = 14;
const MD_MIN_FONT_SIZE = 10;
const MD_MAX_FONT_SIZE = 32;
const MD_FONT_SIZE_STEP = 1;

function clampFontSize(px: number): number {
  if (!Number.isFinite(px)) return MD_DEFAULT_FONT_SIZE;
  return Math.max(MD_MIN_FONT_SIZE, Math.min(MD_MAX_FONT_SIZE, Math.round(px)));
}

function loadMdFontSize(): number {
  try {
    const raw = window.localStorage.getItem(MD_FONT_SIZE_KEY);
    if (!raw) return MD_DEFAULT_FONT_SIZE;
    return clampFontSize(Number(raw));
  } catch {
    return MD_DEFAULT_FONT_SIZE;
  }
}

function persistMdFontSize(px: number): void {
  try {
    window.localStorage.setItem(MD_FONT_SIZE_KEY, String(clampFontSize(px)));
  } catch {
    /* privacy mode — ignore */
  }
}

function loadMdWrapMode(): 'wrap' | 'nowrap' {
  try {
    return window.localStorage.getItem(MD_WRAP_KEY) === 'wrap' ? 'wrap' : 'nowrap';
  } catch {
    return 'nowrap';
  }
}

function persistMdWrapMode(mode: 'wrap' | 'nowrap'): void {
  try {
    window.localStorage.setItem(MD_WRAP_KEY, mode);
  } catch {
    /* privacy mode — ignore */
  }
}

// --- Render-theme presets (md-editor multi-preset themes) ----------------
//
// md-editor ships several render-theme presets (GitHub Light / GitHub Dark
// today; Solarized Light/Dark + Dracula in Phase 2), INDEPENDENT of
// WhaleTag's global MUI theme. The host still sends `setTheme('light'|
// 'dark')`; we map that to github-light / github-dark unless the user pinned
// a preset from the toolbar <select>, persisted as `md-editor-theme` in
// localStorage (same key/prefix convention as font-size / wrap-mode above).
//
// `data-theme` on <body> carries the preset name; the CSS variable blocks
// in editor.css key off it. CodeMirror's own theme only distinguishes light
// vs dark, so we collapse the preset to that via presetMode().

const MD_THEME_KEY = 'md-editor-theme';
const MD_PRESETS = [
  'github-light',
  'github-dark',
  'solarized-light',
  'solarized-dark',
  'dracula',
  'nord',
  'gruvbox',
  'one-dark',
] as const;
type MdRenderPreset = (typeof MD_PRESETS)[number];
type MdThemePref = 'auto' | MdRenderPreset;

function isRenderPreset(v: string | null): v is MdRenderPreset {
  return v !== null && (MD_PRESETS as readonly string[]).includes(v);
}

function loadMdThemePref(): MdThemePref {
  try {
    const raw = window.localStorage.getItem(MD_THEME_KEY);
    if (raw === 'auto') return 'auto';
    if (isRenderPreset(raw)) return raw;
    return 'auto';
  } catch {
    return 'auto';
  }
}

function persistMdThemePref(pref: MdThemePref): void {
  try {
    // 'auto' = follow the host → drop the override key entirely (rather than
    // store 'auto') so a stale pinned value can't survive a future preset
    // list change. Matches the "absent = default" reading in loadMdThemePref.
    if (pref === 'auto') window.localStorage.removeItem(MD_THEME_KEY);
    else window.localStorage.setItem(MD_THEME_KEY, pref);
  } catch {
    /* privacy mode — ignore */
  }
}

/** Map a host light/dark mode to the default preset for that mode. */
function presetForMode(mode: 'light' | 'dark'): MdRenderPreset {
  return mode === 'dark' ? 'github-dark' : 'github-light';
}

/**
 * CodeMirror only distinguishes light vs dark; collapse a preset to that.
 * Light presets are the explicit minority (github-light / solarized-light);
 * default to dark so a newly-added preset isn't accidentally rendered with
 * the light CodeMirror theme.
 */
function presetMode(preset: MdRenderPreset): 'light' | 'dark' {
  return preset === 'github-light' || preset === 'solarized-light'
    ? 'light'
    : 'dark';
}

let mdFontSize = loadMdFontSize();
let mdWrapMode: 'wrap' | 'nowrap' = loadMdWrapMode();
let mdThemePref: MdThemePref = loadMdThemePref();
// The host's last announced light/dark mode. Used to resolve the preset when
// the user hasn't pinned one (`mdThemePref === 'auto'`). Seeded from the OS
// preference so the very first paint (before the host's setTheme lands)
// matches the user's system; applyTheme() overwrites it on every setTheme.
let hostMode: 'light' | 'dark' = detectInitialTheme();

function applyFontSize(px: number, view: EditorView): void {
  const clamped = clampFontSize(px);
  mdFontSize = clamped;
  persistMdFontSize(clamped);
  view.dispatch({
    effects: fontSizeCompartment.reconfigure(
      EditorView.theme({
        '&': { fontSize: `${clamped}px` },
        '.cm-content': { fontSize: `${clamped}px` },
      })
    ),
  });
}

function applyWrap(mode: 'wrap' | 'nowrap', view: EditorView): void {
  mdWrapMode = mode;
  persistMdWrapMode(mode);
  view.dispatch({
    effects: wrapCompartment.reconfigure(
      mode === 'wrap' ? [EditorView.lineWrapping] : []
    ),
  });
  wrapStateEl.textContent = mode === 'wrap' ? 'Wrap' : 'No Wrap';
  toggleWrapBtn.classList.toggle('active', mode === 'wrap');
}

/**
 * §18.2.1 — prompt for a line number and jump the editor cursor there.
 * Uses `window.prompt()` for the input — synchronous, no modal CSS to
 * design, matches the convention text-editor established (and avoids
 * pulling in a custom overlay layer for a feature users invoke rarely).
 *
 * Side effects: dispatches a transaction that places the cursor at
 * the start of the target line + scrolls it into view at the top of
 * the viewport (`y: 'start'`). The dispatch's `selection` effect also
 * picks up the cursor; `scrollIntoView` is the explicit effect for
 * moving `.cm-scroller` (the `scrollIntoView: true` shortcut on the
 * transaction spec is unreliable per the same lesson as the TOC click
 * handler — see `setActiveTocLine` / `renderToc` callback).
 *
 * Empty input / invalid input → no-op (we don't throw or toast — the
 * prompt()'s own OK button click just cancels).
 */
/**
 * §task — toggle the `[ ]`/`[x]` of the Nth task-list line in the editor doc.
 * Dispatches a doc change → the updateListener fires schedulePreview (so the
 * preview checkbox re-renders in the new state) + marks dirty; the user
 * saves (Ctrl+S) to persist. `index` matches the preview checkbox order.
 */
function toggleTaskInEditor(target: EditorView, index: number): void {
  const doc = target.state.doc;
  const taskRe = /^(\s*[-*+] \[)([ x])(\])/i;
  let count = 0;
  for (let lineNo = 1; lineNo <= doc.lines; lineNo += 1) {
    const line = doc.line(lineNo);
    const m = taskRe.exec(line.text);
    if (!m) continue;
    if (count === index) {
      const isChecked = m[2].toLowerCase() === 'x';
      const from = line.from + m[1].length;
      target.dispatch({
        changes: { from, to: from + 1, insert: isChecked ? ' ' : 'x' },
      });
      return;
    }
    count += 1;
  }
}

function promptForLine(view: EditorView): void {
  const total = view.state.doc.lines;
  const raw = window.prompt(`Go to line (1–${total}):`, String(getStatusInfo(view.state).line));
  if (raw === null) return; // user hit Cancel
  const parsed = parseLineInput(raw, total);
  if (!parsed) {
    // Bad input — re-prompt with the hint. Three strikes is the usual
    // UX pattern but we keep it simple: one re-prompt, then bail.
    const retry = window.prompt(
      `"${raw}" is not a valid line number.\nEnter a number between 1 and ${total}:`,
      '1'
    );
    if (retry === null) return;
    const reparsed = parseLineInput(retry, total);
    if (!reparsed) return;
    gotoLine(view, reparsed.line);
    return;
  }
  gotoLine(view, parsed.line);
}

function gotoLine(view: EditorView, line: number): void {
  const doc = view.state.doc;
  const lineNo = Math.min(Math.max(line, 1), doc.lines);
  const lineInfo = doc.line(lineNo);
  view.dispatch({
    selection: { anchor: lineInfo.from },
    effects: EditorView.scrollIntoView(lineInfo.from, { y: 'start' }),
  });
  view.focus();
}

/**
 * Wrap the current selection with `before`/`after` markdown markers (e.g.
 * `**`/`**` for bold, `*`/`*` for italic). With no selection the markers are
 * inserted side by side and the cursor lands between them. §fmt — used by
 * the Mod-B / Mod-I keymap. Returns true (CodeMirror command handled).
 */
function wrapSelection(v: EditorView, before: string, after: string): boolean {
  if (v.state.readOnly) return false;
  const sel = v.state.selection.main;
  if (sel.to <= sel.from) {
    // No selection: insert empty markers + place cursor between.
    v.dispatch({
      changes: { from: sel.from, insert: before + after },
      selection: EditorSelection.cursor(sel.from + before.length),
    });
  } else {
    const selected = v.state.sliceDoc(sel.from, sel.to);
    v.dispatch({
      changes: { from: sel.from, to: sel.to, insert: before + selected + after },
      selection: EditorSelection.range(sel.from + before.length, sel.to + before.length),
    });
  }
  v.focus();
  return true;
}

/**
 * Insert a `[text](url)` link template. The selected text becomes the link
 * text; with no selection `text` is the placeholder. The cursor then selects
 * `url` so the user can type the URL right away. §fmt — used by Mod-K.
 */
function insertLink(v: EditorView): boolean {
  if (v.state.readOnly) return false;
  const sel = v.state.selection.main;
  const selected = sel.to > sel.from ? v.state.sliceDoc(sel.from, sel.to) : 'text';
  const insert = `[${selected}](url)`;
  // `url` starts after `[${selected}](` = selected.length + 3 chars.
  const urlStart = sel.from + selected.length + 3;
  v.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: EditorSelection.range(urlStart, urlStart + 3),
  });
  v.focus();
  return true;
}

/**
 * Recompute status bar from the current `EditorView.state` and patch the
 * DOM. Called from the `EditorView.updateListener` on every doc or
 * selection change. Also called once after `createEditor` to seed the bar
 * with the initial state (the listener doesn't fire on view creation).
 */
// §status-split — the status bar updates in two paths:
//  - `updateCursorStatus` (O(1)): line/col/length/selection + read-only +
//    dirty + undo/redo availability. Runs on every cursor move and edit.
//  - `updateWordCount` (O(n)): words + reading time. Runs debounced
//    (`scheduleWordCount`) only on edits — never on a bare cursor move.
//    Previously a single `updateStatus` ran the full `getStatusInfo`
//    (incl. `doc.toString()` + word count) on every selectionSet, which
//    made large docs jank on arrow keys.
function updateCursorStatus(view: EditorView): void {
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  const lineObj = doc.lineAt(sel.from);
  statusLnEl.textContent = String(lineObj.number);
  statusColEl.textContent = String(sel.from - lineObj.from + 1);
  statusLengthEl.textContent = String(doc.length);
  statusSelEl.textContent = String(sel.to - sel.from);
  statusReadonlyEl.hidden = !view.state.readOnly;
  statusDirtyEl.hidden = !isDirty;
  // §18.3.5 — undo/redo availability from the `history()` field.
  // CodeMirror 6's HistoryState exposes `done` / `undone` arrays (NOT
  // v5's `undoStack` / `redoStack`). `field(name, false)` returns
  // undefined if the extension isn't loaded (it is).
  const hist = view.state.field(historyField, false);
  const canUndo = !!hist && (hist as { done: unknown[] }).done.length > 0;
  const canRedo = !!hist && (hist as { undone: unknown[] }).undone.length > 0;
  statusUndoEl.hidden = !canUndo;
  statusRedoEl.hidden = !canRedo;
}

function updateWordCount(view: EditorView): void {
  const info = getStatusInfo(view.state);
  statusWordsEl.textContent = String(info.words);
  // §18.3.6 — reading time, only shown when meaningful (≥ 1 min).
  if (info.readingMinutes > 0) {
    statusWordsEl.title = `${info.readingMinutes} min read`;
  }
}

/** Full status refresh (cursor + word count). Used for the initial seed
 *  after `createEditor` / `setContent`, where we want everything painted
 *  at once. The per-keystroke path uses the split functions directly. */
function updateStatus(view: EditorView): void {
  updateCursorStatus(view);
  updateWordCount(view);
}

let wordCountTimer: ReturnType<typeof setTimeout> | null = null;
/** Debounced word-count refresh — only edits change it, so a bare cursor
 *  move never pays the O(n) `getStatusInfo` cost. 300ms matches the preview
 *  scheduler. Cancelled on file switch (`setContent`). */
function scheduleWordCount(view: EditorView): void {
  if (wordCountTimer !== null) clearTimeout(wordCountTimer);
  wordCountTimer = setTimeout(() => {
    wordCountTimer = null;
    if (view) updateWordCount(view);
  }, 300);
}

// §18.3.5 — brief flash of the undo/redo indicator on the matching
// keypress. Cmd+Z / Ctrl+Z pops the undo stack → we already updated
// the indicator via the updateListener; the flash adds visual
// confirmation that the keypress did something. We avoid touching
// the indicator classes from `updateStatus` — it just sets `hidden`,
// the flash adds a separate `.flash` class for ~250ms.
//
// Why a flash and not a permanent style change: the indicator's
// visible state already encodes "can undo / can redo" via `hidden`;
// a permanent "just-used" highlight would be redundant. The flash
// is purely feedback for the keystroke event itself.
let undoFlashTimer: ReturnType<typeof setTimeout> | null = null;
let redoFlashTimer: ReturnType<typeof setTimeout> | null = null;
function flashUndoIndicator(): void {
  statusUndoEl.classList.add('status-flash');
  if (undoFlashTimer !== null) clearTimeout(undoFlashTimer);
  undoFlashTimer = setTimeout(() => {
    statusUndoEl.classList.remove('status-flash');
    undoFlashTimer = null;
  }, 250);
}
function flashRedoIndicator(): void {
  statusRedoEl.classList.add('status-flash');
  if (redoFlashTimer !== null) clearTimeout(redoFlashTimer);
  redoFlashTimer = setTimeout(() => {
    statusRedoEl.classList.remove('status-flash');
    redoFlashTimer = null;
  }, 250);
}

// Resizable splitter between the editor and preview panes (see §18.1.1).
// Persists the ratio to localStorage as `md-editor-split-ratio` and
// supports double-click to reset to 50:50. Container is the row that
// wraps the editor/splitter/preview trio (NOT #app, which now also
// contains the status bar below).
setupSplitter({
  editorPane,
  previewPane,
  splitter: splitterEl,
  container: mainRowEl,
});

// One-time link click delegation (see md-render.ts §18.4.2). Replaces the
// per-render `querySelectorAll('a') + addEventListener` pattern that
// rebound a listener on every preview update.
setupLinkDelegation(previewPane, (href) => {
  window.whaleExt.postMessage({ type: 'openLinkExternally', url: href });
});

// §paste-image — paste a clipboard image: encode → ask host to save it into
// the .md's directory → host replies `imageSaved` (handled in handleMessage)
// where we insert ![](./filename) at the cursor. Text paste is left alone.
let imageRequestId = 0;
editorPane.addEventListener('paste', (e: ClipboardEvent) => {
  if (!currentDir || !view) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of Array.from(items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      const ext = (item.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const reader = new FileReader();
      reader.onload = () => {
        const dataURL = reader.result as string;
        window.whaleExt.postMessage({
          type: 'requestSaveImage',
          requestId: `img-${++imageRequestId}`,
          dataURL,
          ext,
          dirPath: currentDir,
        });
      };
      reader.readAsDataURL(file);
      return;
    }
  }
});

/**
 * Mirror the editor's scroll position onto the preview pane using
 * `data-source-line` markers (see §18.1.3). The preview is `overflow: hidden`
 * (no scrollbar, no wheel scroll), so this is the only path that moves the
 * rendered preview. No guard against feedback loops: only `.cm-scroller`
 * fires scroll events; the preview has no scroll source so setting its
 * `scrollTop` can't echo back.
 *
 * Strategy:
 *   1. Find the document line at the editor's current scroll position
 *      using `view.lineBlockAtHeight` + `state.doc.lineAt`.
 *   2. Locate the corresponding top-level preview block by its
 *      `data-source-line` attribute (set by `parseMarkdown`).
 *   3. Scroll the preview so the matched block sits at the same relative
 *      position as the editor's scroll.
 *
 * If the line is mid-code-block (no exact block match) or the preview is
 * shorter than the editor, fall back to the legacy ratio mapping so the
 * user still gets smooth follow-along scroll.
 */
// §scroll-perf — cache of source-line → preview block element, rebuilt at
// the end of each renderPreview so syncPreviewScroll can O(1) lookup
// instead of querySelector on every scroll frame.
let previewLineMap = new Map<number, HTMLElement>();

// §scroll-perf — coalesce scroll-driven syncPreviewScroll calls to one per
// animation frame. Scroll (and the preview-wheel forwarder) fire at high
// frequency; syncPreviewScroll does lineBlockAtHeight + layout reads, so
// batching per rAF keeps scrolling smooth.
let scrollSyncRaf = 0;
function scheduleSyncPreviewScroll(): void {
  if (scrollSyncRaf) return;
  scrollSyncRaf = requestAnimationFrame(() => {
    scrollSyncRaf = 0;
    syncPreviewScroll();
  });
}

function syncPreviewScroll(): void {
  const scroller = view?.scrollDOM;
  if (!scroller || !view) return;

  const scrollTop = scroller.scrollTop;
  const editorMax = scroller.scrollHeight - scroller.clientHeight;
  if (editorMax <= 0) {
    previewPane.scrollTop = 0;
    return;
  }

  // §scroll-bottom — when the editor is near its bottom, pin the preview to
  // its bottom too. Without this, the source-line alignment below puts the
  // last block's TOP at the viewport top, leaving its body (footnotes, etc.)
  // cut off below the viewport — so you couldn't wheel to the preview's end.
  const previewMaxBottom = previewPane.scrollHeight - previewPane.clientHeight;
  if (previewMaxBottom > 0 && scrollTop >= editorMax - 60) {
    previewPane.scrollTop = previewMaxBottom;
    return;
  }
  // §scroll-top — symmetric: editor near its top → preview pinned to top.
  // Without this the first block's padding offset can leave the preview
  // scrolled a touch down when the editor is already at the very top.
  if (scrollTop <= 60) {
    previewPane.scrollTop = 0;
    return;
  }

  // Find the document line under the editor's current top.
  let lineNo: number | null = null;
  const block = view.lineBlockAtHeight(scrollTop);
  if (block) {
    try {
      lineNo = view.state.doc.lineAt(block.from).number;
    } catch {
      lineNo = null;
    }
  }

  if (lineNo !== null) {
    // §scroll-perf — O(1) map lookup (rebuilt in renderPreview) with a
    // querySelector fallback for the brief window before the first render
    // finishes building it.
    const target =
      previewLineMap.get(lineNo) ??
      (previewPane.querySelector(
        `[data-source-line="${lineNo}"]`
      ) as HTMLElement | null);
    if (target) {
      const previewRect = previewPane.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      // Position the target at the top of the preview viewport. If the
      // preview is shorter than its content (no overflow), this is a
      // no-op. If the preview is taller, scroll to put the target at top.
      const previewMax = previewPane.scrollHeight - previewPane.clientHeight;
      if (previewMax > 0) {
        // Compute the target's offset within the preview's scrollable
        // content, then center it (or put it at the top — top-aligned
        // matches the editor's "what's at the top of my view" mental model).
        const targetTop = targetRect.top - previewRect.top + previewPane.scrollTop;
        previewPane.scrollTop = Math.max(0, Math.min(previewMax, targetTop));
      }
      // §18.3.1 — highlight the corresponding TOC entry. Only fire
      // when the matched block IS a heading (`target.tagName` is
      // H1..H6); otherwise leave the previous active state (a
      // paragraph at the top means "no new heading to highlight").
      const tag = target.tagName;
      if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6') {
        setActiveTocLine(lineNo);
      }
      return;
    }
  }

  // Fallback: ratio-based mapping for cases without an exact line match
  // (e.g. cursor is in a long code block and the line number has no
  // corresponding top-level block in the preview).
  const ratio = Math.max(0, Math.min(1, scrollTop / editorMax));
  const previewMax = previewPane.scrollHeight - previewPane.clientHeight;
  previewPane.scrollTop = Math.round(ratio * Math.max(0, previewMax));
  // Ratio fallback can't pinpoint a heading, so leave the existing
  // activeTocLine alone (don't reset to null — that would flicker
  // the highlight as the user scrolls through a long code block).
}

/**
 * §fold-sync — mirror the editor's folded sections onto the preview pane. Each
 * folded range in the CodeMirror `foldState` spans a heading section; the
 * preview's top-level blocks carry `data-source-line` (set by parseMarkdown),
 * so we hide any block whose source line falls strictly INSIDE a folded range.
 * The heading block itself (at the range's first line) stays visible so the
 * user sees the folded section's title.
 *
 * Called from the updateListener on foldState change, and from renderPreview
 * so freshly-rendered content picks up the current fold state.
 */
function applyFoldToPreview(): void {
  if (!view) return;
  const folds = view.state.field(foldState, false);
  const ranges: Array<{ fromLine: number; toLine: number }> = [];
  if (folds) {
    folds.between(0, view.state.doc.length, (from, to) => {
      ranges.push({
        fromLine: view!.state.doc.lineAt(from).number,
        toLine: view!.state.doc.lineAt(to).number,
      });
    });
  }
  const blocks = previewPane.querySelectorAll('[data-source-line]');
  blocks.forEach((el) => {
    const lineAttr = el.getAttribute('data-source-line');
    if (lineAttr === null) return;
    const line = Number(lineAttr);
    // Distinguish the two fold kinds:
    //  - code-block fold (opening ``` fence at fromLine): COLLAPSE the <pre>
    //    into a one-line placeholder (fold-collapsed) — the block stays
    //    visible, just its body hidden. This is "fold", not "vanish".
    //  - heading fold: hide the section's content blocks entirely
    //    (fold-hidden); the heading block at fromLine stays.
    let collapsed = false;
    let hidden = false;
    for (const r of ranges) {
      const fromLineText = view!.state.doc.line(r.fromLine).text;
      const isCodeFence = /^\s*(`{3,}|~{3,})/.test(fromLineText);
      if (isCodeFence) {
        if (line >= r.fromLine && line <= r.toLine) {
          collapsed = true;
          break;
        }
      } else if (line > r.fromLine && line <= r.toLine) {
        hidden = true;
        break;
      }
    }
    el.classList.toggle('fold-collapsed', collapsed);
    el.classList.toggle('fold-hidden', hidden);
  });
}

/**
 * Exhaustiveness guard. Used at the end of `applyTheme` to give a
 * runtime error if a future code path passes a value outside the
 * expected `'light' | 'dark' | 'system'` union. With strict TS
 * + a `switch`, this is a compile-time check; the runtime
 * `throw` is a defense-in-depth measure for code paths that
 * bypass the type system (e.g. `any` casts, JSON deserialization).
 */
/**
 * §fold — fold a markdown ATX heading (`#`…`######`) up to the next heading of
 * the same or higher level (or end of document). Registered as a language-data
 * `foldService` so `foldGutter` shows a marker on every heading line and
 * Ctrl-Shift-[ folds the whole section. lang-markdown doesn't ship a heading
 * fold, so we provide one based on the doc text (cheap line scan; a heading's
 * span is bounded by the next `#` of equal/lesser depth).
 */
const foldMarkdownHeading = (
  state: EditorState,
  lineStart: number,
  lineEnd: number
): { from: number; to: number } | null => {
  if (lineStart !== lineEnd) return null;
  const line = state.doc.line(lineStart);
  const m = /^(#{1,6})\s+\S/.exec(line.text);
  if (!m) return null;
  const level = m[1].length;
  let endLine = state.doc.lines;
  for (let i = lineStart + 1; i <= state.doc.lines; i += 1) {
    const mm = /^(#{1,6})\s+\S/.exec(state.doc.line(i).text);
    if (mm && mm[1].length <= level) {
      endLine = i - 1;
      break;
    }
  }
  if (endLine <= lineStart) return null;
  return { from: line.to, to: state.doc.line(endLine).to };
};

/**
 * §fold — fold a fenced code block (``` or ~~~) from its opening fence to the
 * matching closing fence. lang-markdown doesn't ship a code-block fold, so we
 * detect the fence pair by text. Unterminated fences (no closer) are left
 * unfoldable. Registers alongside foldMarkdownHeading so BOTH headings and
 * code blocks get gutter markers.
 */
const foldCodeBlock = (
  state: EditorState,
  lineStart: number,
  lineEnd: number
): { from: number; to: number } | null => {
  if (lineStart !== lineEnd) return null;
  const line = state.doc.line(lineStart);
  const m = /^(\s*)(`{3,}|~{3,})/.exec(line.text);
  if (!m) return null;
  const fenceChar = m[2][0];
  const closeRe = new RegExp(`^\\s*\\${fenceChar}{3,}`);
  let endLine = -1;
  for (let i = lineStart + 1; i <= state.doc.lines; i += 1) {
    if (closeRe.test(state.doc.line(i).text)) {
      endLine = i;
      break;
    }
  }
  if (endLine === -1) return null; // unterminated fence — not foldable
  return { from: line.to, to: state.doc.line(endLine).to };
};

/** The foldService is published via the `languageData` facet so the fold
 *  gutter / foldKeymap pick it up. Markdown is always foldable, so this needs
 *  no per-file gating (unlike text-editor's supportsFolding). */
const markdownFoldExtension: Extension = EditorState.languageData.of(() => [
  { foldService: foldMarkdownHeading },
  { foldService: foldCodeBlock },
]);

function themeExtension(theme: 'light' | 'dark'): Extension {
  // Structure only. Token colors come from the dynamic HighlightStyle built by
  // `buildMdHighlightFromCss` (below), not from oneDark's bundled highlight —
  // that way editor tokens follow the render theme. Structure colors (bg /
  // gutters / selection / ...) are further overridden by editor.css
  // `body[data-theme] .cm-*` rules, so oneDarkTheme here just supplies
  // CM-internal defaults (cursor shape, panel layout) we don't otherwise set.
  return theme === 'dark' ? oneDarkTheme : [];
}

const highlightCompartment = new Compartment();

/**
 * §editor-theme — build a markdown + code HighlightStyle by reading the ACTIVE
 * render preset's `--md-*` variables off the live DOM via getComputedStyle.
 * Because it reads computed values at call time, the same function serves every
 * preset: call it AFTER `setAttribute('data-theme', …)` so the CSS variables
 * already reflect the new preset, then apply via `highlightCompartment`.
 *
 * Token mapping reuses the hljs palette where semantics line up (code
 * keyword/string/number/comment) and the base vars for prose: link→accent,
 * quote/url→muted, heading→hljs-title (each preset's "type/function" hue),
 * emphasis/strong→text (they carry styling via italic/bold, not color).
 */
function buildMdHighlightFromCss(): HighlightStyle {
  const cs = getComputedStyle(document.body);
  const v = (name: string): string => cs.getPropertyValue(name).trim();
  return HighlightStyle.define([
    { tag: tags.heading, color: v('--md-hljs-title') },
    { tag: tags.link, color: v('--md-accent') },
    { tag: tags.url, color: v('--md-muted') },
    { tag: tags.emphasis, color: v('--md-text') },
    { tag: tags.strong, color: v('--md-text') },
    { tag: tags.quote, color: v('--md-muted') },
    { tag: tags.monospace, color: v('--md-hljs-string') },
    { tag: tags.keyword, color: v('--md-hljs-keyword') },
    { tag: tags.atom, color: v('--md-hljs-keyword') },
    { tag: tags.string, color: v('--md-hljs-string') },
    { tag: tags.number, color: v('--md-hljs-number') },
    { tag: tags.comment, color: v('--md-hljs-comment') },
    { tag: tags.meta, color: v('--md-faint') },
  ]);
}

/**
 * Resolve the preset that should be active right now: the user's pinned
 * preset if they chose one from the toolbar, otherwise the github-light/
 * github-dark preset matching the host's current light/dark mode.
 */
function resolvePreset(): MdRenderPreset {
  return mdThemePref === 'auto' ? presetForMode(hostMode) : mdThemePref;
}

/**
 * Apply a render-theme preset: set `body[data-theme]` (which swaps the CSS
 * variable block in editor.css) and reconfigure CodeMirror's light/dark
 * theme to match. Also mirrors the current preference into the toolbar
 * <select> so it stays in sync after host-driven changes (the user's own
 * <select> change has already set it before calling here).
 */
function applyPreset(preset: MdRenderPreset): void {
  document.body.setAttribute('data-theme', preset);
  if (view) {
    view.dispatch({
      effects: [
        // data-theme was just set, so buildMdHighlightFromCss reads the new
        // preset's --md-* values — editor tokens follow the render theme.
        themeCompartment.reconfigure(themeExtension(presetMode(preset))),
        highlightCompartment.reconfigure(syntaxHighlighting(buildMdHighlightFromCss())),
      ],
    });
  }
  // §settings-sync — theme preset is owned by Settings ▸ General now (the
  // toolbar <select> was removed). The host pushes it via setMdRenderTheme.
}

/**
 * §18.4.4 — apply the host's theme. Accepts `'light' | 'dark' | 'system'`
 * (the host only ever sends light/dark; `'system'` is retained as a
 * defensive fallback and resolves via `detectInitialTheme()`). Records the
 * host mode, then activates the resolved preset — the user's pinned preset
 * if they set one, or the github-light/github-dark preset for the host mode
 * otherwise. Any unexpected value is rejected by `assertNever` (defense
 * against a code path that bypasses the type system).
 */
function applyTheme(theme: 'light' | 'dark' | 'system') {
  let mode: 'light' | 'dark';
  switch (theme) {
    case 'light':
    case 'dark':
      mode = theme;
      break;
    case 'system':
      mode = detectInitialTheme();
      break;
    default:
      // §robust — never throw on an unexpected theme value (a host bug or
      // a future theme shouldn't make the editor unopenable). Fall back to
      // the OS preference and warn. This drops the compile-time
      // exhaustiveness check `assertNever` gave, deliberately — runtime
      // resilience matters more than catching a new union member here.
      // eslint-disable-next-line no-console
      console.warn('[md-editor] unexpected theme, falling back to OS:', theme);
      mode = detectInitialTheme();
  }
  hostMode = mode;
  applyPreset(resolvePreset());
}

function setReadOnly(readOnly: boolean) {
  if (!view) return;
  view.dispatch({
    effects: readOnlyCompartment.reconfigure(EditorView.editable.of(!readOnly)),
  });
  // §18.2.2 — the read-only badge in the status bar must reflect the
  // new state immediately (the dispatch doesn't trigger our status
  // listener because doc/selection didn't change).
  updateStatus(view);
}

/**
 * Re-extract the TOC from the current editor state and re-render the
 * sidebar. Called after every successful preview render. The TOC is a
 * thin projection of the markdown source; rebuilding it on every
 * keystroke (debounced via the outer scheduler) is cheap (< 1ms for
 * 200 headings).
 */
function refreshToc(content: string): void {
  const entries = extractToc(content);
  renderToc(tocListEl, entries, (entry) => {
    // §18.3.1 — clicking a TOC entry scrolls BOTH the editor and
    // the preview to the matching block. The preview-pane has
    // `overflow: hidden` (per editor.css) — only the editor's
    // `.cm-scroller` is the real scroll source. `syncPreviewScroll`
    // listens to the editor's `scroll` event and mirrors its
    // `scrollTop` onto the preview, so scrolling the editor drags
    // the preview along. The TOC handler therefore has to drive
    // BOTH: dispatch to the editor with `EditorView.scrollIntoView`
    // (the only effect that actually moves `.cm-scroller`), then
    // let `syncPreviewScroll` follow — OR if the editor was already
    // on the target line, fall through to the preview's manual
    // `scrollTop` lookup for sub-line precision.
    //
    // Why both: doing only the preview would leave the editor
    // untouched; the next keystroke fires `updateListener` →
    // `syncPreviewScroll` follows the editor's CURRENT scroll, not
    // the preview's, so the next user edit yanks the preview back
    // to the cursor. Without the editor scroll, TOC clicks are
    // unstable.
    //
    // Also immediately mark the clicked entry as active so the
    // highlight snaps to it (the editor-scroll → syncPreviewScroll
    // → setActiveTocLine chain would also get there, but with a
    // measurable delay; setting it here makes the click feel instant).
    if (view) {
      const doc = view.state.doc;
      const lineNo = Math.min(Math.max(entry.line, 1), doc.lines);
      const lineInfo = doc.line(lineNo);
      view.dispatch({
        selection: { anchor: lineInfo.from },
        effects: EditorView.scrollIntoView(lineInfo.from, { y: 'start' }),
      });
      view.focus();
    }
    setActiveTocLine(entry.line);
    const target = previewPane.querySelector(
      `[data-source-line="${entry.line}"]`
    ) as HTMLElement | null;
    if (target) {
      const previewRect = previewPane.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const previewMax = previewPane.scrollHeight - previewPane.clientHeight;
      if (previewMax > 0) {
        const targetTop = targetRect.top - previewRect.top + previewPane.scrollTop;
        previewPane.scrollTop = Math.max(0, Math.min(previewMax, targetTop));
      }
    }
  });
  // §18.3.1 — re-apply the active highlight to the freshly-rendered
  // DOM. `renderToc` just replaced `tocListEl.innerHTML`, so the
  // previously-set `.toc-active` class is gone. Re-add it to the
  // entry matching `activeTocLine` (preserved across the re-render).
  if (activeTocLine !== null) {
    const links = tocListEl.querySelectorAll('a.toc-entry');
    links.forEach((link) => {
      const lineAttr = link.getAttribute('data-toc-line');
      if (lineAttr !== null && Number(lineAttr) === activeTocLine) {
        link.classList.add('toc-active');
      }
    });
  }
}

/**
 * §18.3.2 — export the current preview as a self-contained HTML file.
 * Wraps `previewPane.innerHTML` in a full document with inline CSS
 * (subset of editor.css that renders the document, not the chrome) and
 * triggers a browser download. Filename is the basename of the current
 * path (sans extension) + `.html`. If no path is open, falls back to
 * `untitled.html`.
 */
/**
 * §export-theme — read the active render preset's `--md-*` variable values
 * off the live DOM so the exported HTML document carries the same theme.
 * `getComputedStyle(document.body)` resolves each variable to its currently
 * effective value (the :root default OR the body[data-theme='<preset>']
 * override), so this works for every preset without knowing which is active.
 *
 * The list mirrors the 35 names defined in editor.css — keep them in sync if
 * a variable is added/removed.
 */
const MD_VAR_NAMES = [
  '--md-bg', '--md-text', '--md-muted', '--md-faint', '--md-border',
  '--md-accent', '--md-surface', '--md-warn', '--md-hover-bg', '--md-active-bg',
  '--md-splitter-hover', '--md-inline-code-bg', '--md-mark-bg',
  '--md-callout-blue-border', '--md-callout-blue-bg',
  '--md-callout-green-border', '--md-callout-green-bg',
  '--md-callout-orange-border', '--md-callout-orange-bg',
  '--md-callout-red-border', '--md-callout-red-bg',
  '--md-callout-purple-border', '--md-callout-purple-bg',
  '--md-callout-gray-border', '--md-callout-gray-bg',
  '--md-hljs-base', '--md-hljs-comment', '--md-hljs-keyword', '--md-hljs-string',
  '--md-hljs-title', '--md-hljs-number', '--md-hljs-deletion-fg',
  '--md-hljs-deletion-bg', '--md-hljs-addition-fg', '--md-hljs-addition-bg',
] as const;

function readMdThemeVars(): string {
  const cs = getComputedStyle(document.body);
  return MD_VAR_NAMES.map((n) => `${n}:${cs.getPropertyValue(n).trim()}`).join(';');
}

function exportPreviewAsHtml(): void {
  const themeVars = readMdThemeVars();
  if (!currentPath) {
    triggerDownload(
      'untitled.html',
      wrapHtmlDocument('Untitled', previewPane.innerHTML, themeVars),
      'text/html'
    );
    return;
  }
  // Strip the .md / .markdown extension from the basename.
  const sep = Math.max(currentPath.lastIndexOf('/'), currentPath.lastIndexOf('\\'));
  const fileName = sep >= 0 ? currentPath.slice(sep + 1) : currentPath;
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const outName = `${stem}.html`;
  const title = stem || 'Untitled';
  triggerDownload(
    outName,
    wrapHtmlDocument(title, previewPane.innerHTML, themeVars),
    'text/html'
  );
}

function renderPreview(content: string) {
  // §18.2.4 — content-equality short-circuit. The expensive pipeline
  // (parseMarkdown + DOMPurify + innerHTML + hljs + image resolve) is
  // skipped entirely if the source markdown is byte-identical to the
  // last render. The `setContent` synchronous path bypasses this guard
  // (a file load must always re-render) — see `setContent` below.
  if (shouldSkipRender(lastRenderedContent, content)) return;
  const raw = parseMarkdown(content);
  const clean = sanitizeMarkdownHtml(raw);
  previewPane.innerHTML = clean;

  // §18.1.4 — apply syntax highlighting to <pre><code> blocks after the
  // sanitized HTML is in the DOM. highlight.js mutates the elements in
  // place (adds span wrappers + hljs-* classes); the CSS theme in
  // editor.css provides the colors.
  highlightCodeBlocks(previewPane);

  // §18.2.3 — rewrite `<img src="./relative.png">` into streamable
  // `whale-file://` URLs. No-op if the host didn't supply `dirPath` or
  // the document has no images. Runs after `highlightCodeBlocks` so
  // neither step's DOM mutation interferes with the other.
  resolveLocalImages(previewPane, currentDir);

  // §copy — hover "Copy" button on each code block (after hljs so the button
  // sits over the highlighted <pre>). §lightbox — click <img> to zoom.
  addLanguageLabels(previewPane);
  addCodeLineNumbers(previewPane);
  addCodeCopyButtons(previewPane);
  attachImageLightbox(previewPane);
  // §task — clickable checkboxes toggle the editor's matching task line.
  addTaskInteractivity(previewPane, (idx) => {
    if (view) toggleTaskInEditor(view, idx);
  });

  // §18.3.3 — render Mermaid diagrams. Lazy-imports mermaid on first
  // call (~200KB gzipped); async, so we don't await it — the SVG
  // appears ~100-500ms after the preview paints. Errors fall back to
  // raw source + console.warn (handled inside `renderMermaid`).
  // Fire-and-forget; the placeholder is visible immediately.
  void renderMermaid(previewPane);

  // §18.3.3 — render KaTeX math. Same fire-and-forget shape as
  // mermaid: the placeholder (`<span class="katex">…</span>`) shows
  // the raw LaTeX immediately; the sandbox replaces it with the
  // rendered HTML ~50-200ms later. KaTeX has its own sandbox iframe
  // (no `unsafe-eval` needed — KaTeX is pure JS), so the main CSP
  // stays strict.
  void renderKatex(previewPane);

  // §scroll-perf — rebuild the source-line → block map so syncPreviewScroll
  // can O(1) lookup on each scroll frame. Done after all DOM mutations
  // above so the map reflects the final structure.
  previewLineMap = new Map();
  previewPane.querySelectorAll('[data-source-line]').forEach((el) => {
    const ln = Number((el as HTMLElement).dataset.sourceLine);
    if (Number.isFinite(ln)) previewLineMap.set(ln, el as HTMLElement);
  });

  // Preview DOM just changed — keep the preview scrollTop in sync with
  // the editor's current line so the user's reading position doesn't
  // jump when the rendered content reflows.
  syncPreviewScroll();

  // §18.3.1 — rebuild the TOC outline. Cheap (one lexer pass) and
  // only runs after a real render (shouldSkipRender has already
  // short-circuited identical re-renders above).
  refreshToc(content);

  // §fold-sync — apply current editor folds to the freshly-rendered preview.
  applyFoldToPreview();

  lastRenderedContent = content;
}

function schedulePreview() {
  // view may be null during the brief window between setContent's
  // cancel() and the next createEditor; guard with the optional chain.
  if (!view) return;
  scheduler.schedule(
    () => view!.state.doc.toString(),
    // §18.2.4 — wrap the actual render in rAF so the innerHTML swap
    // happens aligned with the next browser repaint, not mid-frame.
    // `renderPreview` itself is still the source of truth (and contains
    // the shouldSkipRender guard); the rAF just times WHEN it runs.
    (doc) => rafScheduler.schedule(() => renderPreview(doc))
  );
}

function createEditor(container: HTMLElement) {
  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged && currentPath) {
      schedulePreview();
      isDirty = true;
      window.whaleExt.postMessage({
        type: 'contentChangedInEditor',
        path: currentPath,
        dirty: true,
      });
    }
    // §18.2.2 — patch status bar on every doc/selection/viewport change.
    // `view.state` is always current inside the listener. The bar reflects
    // the *primary* selection (matches text-editor's convention; multi-
    // selection via `state.selection.ranges` is ignored by the status).
    // §status-split — cursor moves only update the cheap line/col/sel/
    // undo-redo indicators; the O(n) word count runs debounced on edits.
    if (update.selectionSet) updateCursorStatus(view!);
    if (update.docChanged) {
      updateCursorStatus(view!);
      scheduleWordCount(view!);
    }
    // §fold-sync — fold/unfold effects (gutter click or foldKeymap) re-mirror
    // the editor's folds onto the preview pane. Listening on the effect (not a
    // foldState field reference compare) is the reliable signal — foldGutter
    // and foldCode both dispatch foldEffect / unfoldEffect.
    for (const tr of update.transactions) {
      for (const eff of tr.effects) {
        if (eff.is(foldEffect) || eff.is(unfoldEffect)) {
          applyFoldToPreview();
          return;
        }
      }
    }
  });

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

  // §18.2.1 — Ctrl+F shortcut for the search panel (also bound to the
  // toolbar's Find button via `openSearchPanel(view)`).
  const findKeymap: import('@codemirror/view').KeyBinding[] = [
    {
      key: 'Mod-f',
      run: () => {
        if (!view) return false;
        openSearchPanel(view);
        return true;
      },
    },
    {
      // §18.2.1 — Ctrl+G / Cmd+G: jump to line. Uses `window.prompt`
      // for the line input — ugly but synchronous, no modal CSS to
      // design, and matches text-editor's existing pattern. The
      // parsing/validation logic lives in `parseLineInput` (md-render.ts)
      // so it can be unit-tested.
      key: 'Mod-g',
      run: () => {
        if (!view) return false;
        promptForLine(view);
        return true;
      },
    },
  ];

  // Ctrl +/- / Ctrl+0 zoom shortcuts — also wired to the toolbar buttons.
  const zoomKeymap: import('@codemirror/view').KeyBinding[] = [
    {
      key: 'Mod-=',
      run: () => {
        if (!view) return false;
        applyFontSize(mdFontSize + MD_FONT_SIZE_STEP, view);
        return true;
      },
    },
    {
      key: 'Mod--',
      run: () => {
        if (!view) return false;
        applyFontSize(mdFontSize - MD_FONT_SIZE_STEP, view);
        return true;
      },
    },
    {
      key: 'Mod-0',
      run: () => {
        if (!view) return false;
        applyFontSize(MD_DEFAULT_FONT_SIZE, view);
        return true;
      },
    },
  ];

  // §fmt — Markdown formatting shortcuts (VSCode / Typora / Obsidian parity).
  // Mod-B → **bold**, Mod-I → *italic*, Mod-K → [text](url). `preventDefault`
  // stops the browser's native Mod-B (bookmarks in some setups) / Mod-I.
  const markdownFormattingKeymap: import('@codemirror/view').KeyBinding[] = [
    { key: 'Mod-b', preventDefault: true, run: (v) => wrapSelection(v, '**', '**') },
    { key: 'Mod-i', preventDefault: true, run: (v) => wrapSelection(v, '*', '*') },
    { key: 'Mod-k', preventDefault: true, run: insertLink },
  ];

  const state = EditorState.create({
    doc: '',
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      // §18.3.5 — Mod-z / Mod-Shift-z. We register these BEFORE the
      // defaultKeymap so they fire first (CodeMirror keymaps are
      // tried in order, first match wins). The flash on the undo/redo
      // status indicator gives visual confirmation that the keypress
      // actually fired. Without these explicit bindings, the flash
      // never fires (defaultKeymap's `undo` / `redo` would silently
      // run without our wrapper having a hook).
      keymap.of([
        {
          key: 'Mod-z',
          run: () => {
            if (undo(view!)) {
              flashUndoIndicator();
              return true;
            }
            return false;
          },
        },
        {
          key: 'Mod-Shift-z',
          run: () => {
            if (redo(view!)) {
              flashRedoIndicator();
              return true;
            }
            return false;
          },
        },
        {
          key: 'Mod-y', // Windows-style redo
          run: () => {
            if (redo(view!)) {
              flashRedoIndicator();
              return true;
            }
            return false;
          },
        },
      ]),
      // §18.2.1 — `search()` enables Ctrl+F / Ctrl+H with the built-in
      // search panel; `searchKeymap` adds the panel's own key bindings.
      // Both must come AFTER `defaultKeymap` (above) so the user's Mod-f
      // is captured here, not by the default keymap.
      search(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap]),
      keymap.of(findKeymap),
      keymap.of(zoomKeymap),
      keymap.of(markdownFormattingKeymap),
      markdown(),
      // §fold — heading fold (custom foldService above) + gutter markers +
      // Ctrl-Shift-[ / ] keymap. Markdown is always foldable.
      markdownFoldExtension,
      // §fold — codeFolding() provides the foldState field that foldGutter,
      // foldKeymap, and applyFoldToPreview all read. Without it the field may
      // be absent and fold-sync silently no-ops.
      codeFolding(),
      foldGutter(),
      // §editor-theme — markdown/code token colors, rebuilt per preset.
      highlightCompartment.of(syntaxHighlighting(buildMdHighlightFromCss())),
      themeCompartment.of(themeExtension('light')),
      readOnlyCompartment.of(EditorView.editable.of(true)),
      fontSizeCompartment.of(
        EditorView.theme({
          '&': { fontSize: `${mdFontSize}px` },
          '.cm-content': { fontSize: `${mdFontSize}px` },
        })
      ),
      wrapCompartment.of(
        mdWrapMode === 'wrap' ? [EditorView.lineWrapping] : []
      ),
      updateListener,
      saveKeymap,
    ],
  });

  view = new EditorView({
    state,
    parent: container,
  });

  // §18.2.1 — wire toolbar buttons. Each click goes through `apply*()`
  // so the persisted value, the compartment reconfiguration, and the
  // toolbar state indicator stay in sync.
  gotoLineBtn.addEventListener('click', () => {
    if (view) promptForLine(view);
  });
  findBtn.addEventListener('click', () => {
    if (view) openSearchPanel(view);
  });
  toggleWrapBtn.addEventListener('click', () => {
    if (!view) return;
    applyWrap(mdWrapMode === 'wrap' ? 'nowrap' : 'wrap', view);
  });
  zoomInBtn.addEventListener('click', () => {
    if (view) applyFontSize(mdFontSize + MD_FONT_SIZE_STEP, view);
  });
  zoomOutBtn.addEventListener('click', () => {
    if (view) applyFontSize(mdFontSize - MD_FONT_SIZE_STEP, view);
  });
  zoomResetBtn.addEventListener('click', () => {
    if (view) applyFontSize(MD_DEFAULT_FONT_SIZE, view);
  });

  // §18.3.1 — TOC toggle. Re-extracts from the current doc on open
  // (so the sidebar is populated immediately, not only on next edit).
  toggleTocBtn.addEventListener('click', () => {
    if (!view) return;
    const willShow = tocSidebarEl.hasAttribute('hidden');
    if (willShow) {
      tocSidebarEl.removeAttribute('hidden');
      toggleTocBtn.classList.add('active');
      refreshToc(view.state.doc.toString());
    } else {
      tocSidebarEl.setAttribute('hidden', '');
      toggleTocBtn.classList.remove('active');
    }
  });

  // §18.3.2 — Export Preview as HTML. Uses the current `previewPane`
  // innerHTML (which has been sanitized + highlighted + image-resolved).
  exportHtmlBtn.addEventListener('click', () => {
    exportPreviewAsHtml();
  });

  // Initial toolbar state indicator.
  wrapStateEl.textContent = mdWrapMode === 'wrap' ? 'Wrap' : 'No Wrap';
  toggleWrapBtn.classList.toggle('active', mdWrapMode === 'wrap');

  // Sync preview scroll on every editor scroll event. `view.scrollDOM` is the
  // `.cm-scroller` element. Using a `scroll` listener (rather than polling
  // `requestAnimationFrame`) keeps the work proportional to user input.
  view.scrollDOM.addEventListener('scroll', scheduleSyncPreviewScroll, { passive: true });

  // §preview-wheel — forward wheel events over the preview pane to the
  // editor's scroller. The preview is `overflow: hidden` (single-view
  // design: the editor is the sole scroll source, `syncPreviewScroll`
  // mirrors its scrollTop onto the preview), so without this a wheel over
  // the preview does nothing. Forwarding to the editor's scroller scrolls
  // the editor, which fires its `scroll` event → syncPreviewScroll mirrors
  // it back to the preview, keeping the two panes in lock-step.
  previewPane.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      const scroller = view?.scrollDOM;
      if (!scroller) return;
      // Normalize deltaMode: 0 = px (Chrome/Windows/Mac default), 1 = lines,
      // 2 = pages. Most mice/touchpads fire mode 0; the 1/2 branches cover
      // the rare browsers/devices reporting in lines or pages.
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 24;
      else if (e.deltaMode === 2) dy *= scroller.clientHeight;
      scroller.scrollTop += dy;
    },
    { passive: true }
  );
  // First paint after the editor mounts: prime the sync so the preview's
  // initial scrollTop matches the editor's (defaults to 0).
  syncPreviewScroll();
  // §18.2.2 — the updateListener doesn't fire on view creation, so seed
  // the status bar here (otherwise it shows the initial 0/0/0/0/0
  // values from the static HTML until the first user input).
  updateStatus(view);
}

function setContent(content: string) {
  // §18.1.2 — cancel any pending debounced render before swapping the
  // document. Without this, an in-flight timer from the previous file
  // would fire after the dispatch and re-render the preview redundantly
  // (or, in the worst case, against a still-loading view).
  scheduler.cancel();
  // §18.2.4 — also cancel the inner rAF scheduler; a stale rAF callback
  // must not render against the just-swapped document.
  rafScheduler.cancel();
  // §status-split — cancel any pending debounced word-count from the
  // previous file; updateStatus below paints fresh values immediately.
  if (wordCountTimer !== null) {
    clearTimeout(wordCountTimer);
    wordCountTimer = null;
  }
  // §18.3.5 — a fresh file load is by definition clean (whatever is on
  // disk matches what we're showing). Clear the dirty flag.
  isDirty = false;
  if (!view) return;
  view.dispatch({
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: content,
    },
    // §undo-leak — a file load must NOT enter the undo history. Without
    // this, switching A→B then pressing Ctrl+Z in B would rewind through
    // the setContent replace back into file A's text (with currentPath
    // still pointing at B). Marking the transaction out-of-history keeps
    // each file's undo stack scoped to that file's own edits.
    annotations: Transaction.addToHistory.of(false),
  });
  // setContent is the only synchronous render path. Bypass
  // `shouldSkipRender` and the rAF scheduler: a file load must always
  // paint immediately, even if `content` happens to equal the previous
  // file (cleared via the `lastRenderedContent = null` reset below).
  lastRenderedContent = null;
  renderPreview(content);
}

function handleMessage(msg: HostMessage) {
  switch (msg.type) {
    case 'fileContent':
      // §18.1.2 — cancel the previous file's pending preview render
      // before we recreate the editor / replace the doc.
      scheduler.cancel();
      currentPath = msg.path;
      // §18.2.3 — host-supplied dir path used by `resolveLocalImages`
      // to rewrite relative `<img src>` into `whale-file://` URLs.
      // Optional in the message; older hosts (or tests) can omit it.
      currentDir = msg.dirPath ?? null;
      if (!view) createEditor(editorPane);
      setContent(msg.content);
      setReadOnly(msg.readOnly);
      // §18.2.5 — no theme override here. The host's `setTheme` (sent
      // before or shortly after `fileContent`) is the source of truth;
      // our boot-time `detectInitialTheme()` covers the gap.
      break;
    case 'setTheme':
      applyTheme(msg.theme);
      break;
    case 'setMdRenderTheme': {
      // §settings-sync — host (Settings ▸ General) pushed the preset. Apply
      // it like the toolbar <select> would, but DON'T postMessage back (the
      // host already knows — it just told us). applyPreset sets select.value
      // programmatically, which doesn't fire 'change', so no loop.
      mdThemePref = msg.theme;
      persistMdThemePref(mdThemePref);
      applyPreset(resolvePreset());
      break;
    }
    case 'setCustomCallouts': {
      // §settings-sync — host pushed the custom callout list. Update
      // md-render's index + re-render so visible `[!custom]` blocks pick up
      // new icons/colors immediately.
      setCustomCallouts(msg.callouts);
      if (currentPath !== null) schedulePreview();
      break;
    }
    case 'setReadOnly':
      setReadOnly(msg.readOnly);
      break;
    case 'savingFile':
      // §18.3.5 — host signals it's about to write our latest content
      // to disk (or has just done so). Clear the dirty flag.
      isDirty = false;
      if (currentPath && view) updateStatus(view);
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
    case 'imageSaved': {
      // §paste-image — host saved the pasted image; insert ![](./filename)
      // at the cursor. savedPath is inside currentDir so the relative link is
      // just the basename (resolveLocalImages rewrites it to whale-file://).
      if (view && msg.path) {
        const filename = msg.path.split(/[\\/]/).pop() || msg.path;
        view.dispatch(view.state.replaceSelection(`![](./${filename})`));
      } else if (msg.error) {
        // eslint-disable-next-line no-console
        console.warn('[md-editor] paste-image failed:', msg.error);
      }
      break;
    }
    default:
      break;
  }
}

window.whaleExt.onMessage(handleMessage);
window.whaleExt.postMessage({ type: 'ready' });

// §18.2.5 — guess the initial theme from the OS / browser preference so
// the iframe doesn't flash light before the host's first `setTheme`
// message arrives. Host's `setTheme` (when it lands) still wins via
// `applyTheme()`; this is just the boot-time seed.
applyTheme(detectInitialTheme());
