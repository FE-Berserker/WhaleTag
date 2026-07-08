import './editor.css';
import { EditorState, Extension, Compartment } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
} from '@codemirror/view';
import { defaultKeymap, history, historyField, historyKeymap, redo, undo } from '@codemirror/commands';
import { oneDark } from '@codemirror/theme-one-dark';
import { markdown } from '@codemirror/lang-markdown';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
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
  exportPreviewAsPdf as exportPreviewAsPdfBlob,
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
const exportPdfBtn = document.getElementById('btn-export-pdf') as HTMLButtonElement;

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

let mdFontSize = loadMdFontSize();
let mdWrapMode: 'wrap' | 'nowrap' = loadMdWrapMode();

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
 * Recompute status bar from the current `EditorView.state` and patch the
 * DOM. Called from the `EditorView.updateListener` on every doc or
 * selection change. Also called once after `createEditor` to seed the bar
 * with the initial state (the listener doesn't fire on view creation).
 */
function updateStatus(view: EditorView): void {
  const info = getStatusInfo(view.state);
  statusLnEl.textContent = String(info.line);
  statusColEl.textContent = String(info.col);
  statusLengthEl.textContent = String(info.length);
  statusSelEl.textContent = String(info.selection);
  statusWordsEl.textContent = String(info.words);
  // §18.3.6 — reading time, only shown when meaningful (≥ 1 min).
  if (info.readingMinutes > 0) {
    statusWordsEl.title = `${info.readingMinutes} min read`;
  }
  statusReadonlyEl.hidden = !view.state.readOnly;
  // §18.3.5 — modified indicator is independent of the doc/selection
  // state, so we update it here too (cheap; the listener fires only
  // when state actually changes, not on every paint).
  statusDirtyEl.hidden = !isDirty;
  // §18.3.5 — undo/redo availability. Read the `history()` extension's
  // stack state. The field returns `undefined` if the extension isn't
  // loaded (it IS — it's in our keymap chain via `history()` + the
  // default keymap's Cmd-Z/Cmd-Shift-Z bindings), but the `?.` keeps
  // us safe against any future code path that doesn't include it.
  const hist = view.state.field(historyField, false);
  // canUndo/canRedo are inferred from stack length — `history()`'s
  // default config has `minDepth: 100`, so a real edit pushes one
  // entry. A redo of all changes clears both stacks.
  //
  // CodeMirror 6's `HistoryState` (from `@codemirror/commands`)
  // exposes its branches as `done` and `undone`, NOT `undoStack` /
  // `redoStack` (the latter was the v5 shape). The
  // `field(name, false)` second arg is the `default`-when-missing
  // flag — when false, the return is the field's value OR
  // `undefined`. The `!!hist &&` guard short-circuits when the
  // `history()` extension isn't on the editor (it is, but `?.`
  // would also work and is more permissive).
  const canUndo = !!hist && (hist as { done: unknown[] }).done.length > 0;
  const canRedo = !!hist && (hist as { undone: unknown[] }).undone.length > 0;
  statusUndoEl.hidden = !canUndo;
  statusRedoEl.hidden = !canRedo;
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
function syncPreviewScroll(): void {
  const scroller = view?.scrollDOM;
  if (!scroller || !view) return;

  const scrollTop = scroller.scrollTop;
  const editorMax = scroller.scrollHeight - scroller.clientHeight;
  if (editorMax <= 0) {
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
    const target = previewPane.querySelector(
      `[data-source-line="${lineNo}"]`
    ) as HTMLElement | null;
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
 * Exhaustiveness guard. Used at the end of `applyTheme` to give a
 * runtime error if a future code path passes a value outside the
 * expected `'light' | 'dark' | 'system'` union. With strict TS
 * + a `switch`, this is a compile-time check; the runtime
 * `throw` is a defense-in-depth measure for code paths that
 * bypass the type system (e.g. `any` casts, JSON deserialization).
 */
function assertNever(x: never): never {
  throw new Error(`md-editor: unexpected theme value: ${String(x)}`);
}

function themeExtension(theme: 'light' | 'dark'): Extension {
  return theme === 'dark' ? oneDark : [];
}

/**
 * §18.4.4 — apply the host's theme to the editor + body attribute.
 * Accepts `'light' | 'dark' | 'system'`; `'system'` resolves to the
 * OS-level preference via `detectInitialTheme()`. Any unexpected value
 * is rejected by `assertNever` (defense against a future code path
 * that bypasses the type system).
 */
function applyTheme(theme: 'light' | 'dark' | 'system') {
  const resolved: 'light' | 'dark' =
    theme === 'system' ? detectInitialTheme() : theme;
  switch (resolved) {
    case 'light':
    case 'dark':
      document.body.setAttribute('data-theme', resolved);
      if (view) {
        view.dispatch({
          effects: themeCompartment.reconfigure(themeExtension(resolved)),
        });
      }
      return;
    default:
      assertNever(resolved);
  }
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
function exportPreviewAsHtml(): void {
  if (!currentPath) {
    triggerDownload('untitled.html', wrapHtmlDocument('Untitled', previewPane.innerHTML), 'text/html');
    return;
  }
  // Strip the .md / .markdown extension from the basename.
  const sep = Math.max(currentPath.lastIndexOf('/'), currentPath.lastIndexOf('\\'));
  const fileName = sep >= 0 ? currentPath.slice(sep + 1) : currentPath;
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const outName = `${stem}.html`;
  const title = stem || 'Untitled';
  triggerDownload(outName, wrapHtmlDocument(title, previewPane.innerHTML), 'text/html');
}

/**
 * §18.3.2 — export the current preview as a PDF. Wraps the
 * preview's current `innerHTML` (sanitized + highlighted + image-
 * resolved + mermaid-rendered + katex-rendered) and converts to a
 * PDF via `pdf-lib` (dynamically imported inside the helper). Same
 * filename pattern as the HTML export.
 *
 * Async because pdf-lib awaits font loads internally. The browser
 * download fires as soon as the Blob is ready; if the user clicks
 * the button twice in quick succession, the second invocation
 * races the first — last write wins on the download side, no
 * corruption because each `exportPreviewAsPdf` produces a complete
 * PDF independently.
 *
 * No toast UI yet — the user sees the browser's download
 * notification (chrome download bar / firefox download panel /
 * save dialog). §18.3.2 二期 could add an inline "rendering…"
 * state on the button.
 */
async function exportPreviewAsPdf(): Promise<void> {
  const sep = currentPath
    ? Math.max(currentPath.lastIndexOf('/'), currentPath.lastIndexOf('\\'))
    : -1;
  const baseName =
    currentPath && sep >= 0
      ? currentPath.slice(sep + 1)
      : currentPath ?? 'untitled';
  const dot = baseName.lastIndexOf('.');
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
  const outName = `${stem || 'untitled'}.pdf`;
  const blob = await exportPreviewAsPdfBlob(outName, previewPane.innerHTML);
  if (!blob) return;
  // Re-use `triggerDownload` by writing the Blob to a synthetic
  // string route — it accepts `Blob` directly (md-render.ts:1068).
  triggerDownload(outName, blob, 'application/pdf');
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

  // Preview DOM just changed — keep the preview scrollTop in sync with
  // the editor's current line so the user's reading position doesn't
  // jump when the rendered content reflows.
  syncPreviewScroll();

  // §18.3.1 — rebuild the TOC outline. Cheap (one lexer pass) and
  // only runs after a real render (shouldSkipRender has already
  // short-circuited identical re-renders above).
  refreshToc(content);

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
    if (update.docChanged || update.selectionSet) {
      updateStatus(view!);
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
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      keymap.of(findKeymap),
      keymap.of(zoomKeymap),
      markdown(),
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
  // §18.3.2 — Export Preview as PDF. Same source as the HTML
  // export; converted to PDF via pdf-lib (dynamically imported
  // inside `exportPreviewAsPdf` to keep the bundle small). Shows
  // a confirmation toast via the button's `title` on hover; no
  // inline alert / toast UI to keep this simple (§18.3.2 二期
  // could add a real progress indicator).
  exportPdfBtn.addEventListener('click', () => {
    void exportPreviewAsPdf();
  });

  // Initial toolbar state indicator.
  wrapStateEl.textContent = mdWrapMode === 'wrap' ? 'Wrap' : 'No Wrap';
  toggleWrapBtn.classList.toggle('active', mdWrapMode === 'wrap');

  // Sync preview scroll on every editor scroll event. `view.scrollDOM` is the
  // `.cm-scroller` element. Using a `scroll` listener (rather than polling
  // `requestAnimationFrame`) keeps the work proportional to user input.
  view.scrollDOM.addEventListener('scroll', syncPreviewScroll, { passive: true });
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
