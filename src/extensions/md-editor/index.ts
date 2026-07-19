import './editor.css';
import { EditorState, Extension, Transaction } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { search, searchKeymap } from '@codemirror/search';
import { foldGutter, foldKeymap, syntaxHighlighting, foldEffect, unfoldEffect, codeFolding } from '@codemirror/language';
import type { HostMessage } from '../../shared/extension-types';
import {
  parseMarkdown,
  sanitizeMarkdownHtml,
  setupLinkDelegation,
  highlightCodeBlocks,
  resolveLocalImages,
  detectInitialTheme,
  shouldSkipRender,
  renderMermaid,
  renderKatex,
  renderHtmlBlocks,
  addCodeCopyButtons,
  attachImageLightbox,
  addLanguageLabels,
  addCodeLineNumbers,
  addTaskInteractivity,
  addTableInteractivity,
  setCustomCallouts,
} from './md-render';
import { setupSplitter } from './md-splitter';
import { ctx, dom, persistMdThemePref } from './md-context';
import {
  updateCursorStatus,
  updateStatus,
  scheduleWordCount,
} from './md-statusbar';
import {
  themeExtension,
  buildMdHighlightFromCss,
  resolvePreset,
  applyPreset,
  applyTheme,
} from './md-theme';
import { markdownFoldExtension, applyFoldToPreview } from './md-fold';
import { refreshToc } from './md-toc';
import { syncPreviewScroll, setupScroll } from './md-scroll';
import { setupContextMenu, handleClipboardText } from './md-contextmenu';
import {
  toggleTaskInEditor,
  setupToolbar,
  replaceTableCellInEditor,
} from './md-toolbar';
import { buildEditorKeymaps } from './md-keymaps';
import { applyLocale } from './md-i18n';

// Resizable splitter between the editor and preview panes (see §18.1.1).
// Persists the ratio to localStorage as `md-editor-split-ratio` and
// supports double-click to reset to 50:50. Container is the row that
// wraps the editor/splitter/preview trio (NOT #app, which now also
// contains the status bar below).
setupSplitter({
  editorPane: dom.editorPane,
  previewPane: dom.previewPane,
  splitter: dom.splitterEl,
  container: dom.mainRowEl,
});

// One-time link click delegation (see md-render.ts §18.4.2). Replaces the
// per-render `querySelectorAll('a') + addEventListener` pattern that
// rebound a listener on every preview update.
setupLinkDelegation(dom.previewPane, (href) => {
  window.whaleExt.postMessage({ type: 'openLinkExternally', url: href });
});

// §paste-image — paste a clipboard image: encode → ask host to save it into
// the .md's directory → host replies `imageSaved` (handled in handleMessage)
// where we insert ![](./filename) at the cursor. Text paste is left alone.
let imageRequestId = 0;
dom.editorPane.addEventListener('paste', (e: ClipboardEvent) => {
  if (!ctx.currentDir || !ctx.view) return;
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
        // §paste-image — resolve the save dir from the host-pushed config:
        // 'subfolder' nests under a per-md folder (`${filename}` → the .md
        // basename without extension); 'current' keeps it alongside the .md.
        let dirPath = ctx.currentDir;
        if (ctx.mdImageSaveMode === 'subfolder') {
          const mdName = (ctx.currentPath ?? 'untitled')
            .split(/[\\/]/)
            .pop()!
            .replace(/\.[^.]+$/, '');
          const folder = ctx.mdImageSubfolder.replaceAll(
            '${filename}',
            mdName || 'untitled'
          );
          dirPath = `${ctx.currentDir}/${folder}`;
        }
        window.whaleExt.postMessage({
          type: 'requestSaveImage',
          requestId: `img-${++imageRequestId}`,
          dataURL,
          ext,
          dirPath,
        });
      };
      reader.readAsDataURL(file);
      return;
    }
  }
});

function setReadOnly(readOnly: boolean) {
  if (!ctx.view) return;
  ctx.view.dispatch({
    effects: ctx.readOnlyCompartment.reconfigure(EditorView.editable.of(!readOnly)),
  });
  // §18.2.2 — the read-only badge in the status bar must reflect the
  // new state immediately (the dispatch doesn't trigger our status
  // listener because doc/selection didn't change).
  updateStatus(ctx.view);
}

function renderPreview(content: string) {
  // §18.2.4 — content-equality short-circuit. The expensive pipeline
  // (parseMarkdown + DOMPurify + innerHTML + hljs + image resolve) is
  // skipped entirely if the source markdown is byte-identical to the
  // last render. The `setContent` synchronous path bypasses this guard
  // (a file load must always re-render) — see `setContent` below.
  if (shouldSkipRender(ctx.lastRenderedContent, content)) return;
  const raw = parseMarkdown(content);
  const clean = sanitizeMarkdownHtml(raw);
  dom.previewPane.innerHTML = clean;

  // §18.1.4 — apply syntax highlighting to <pre><code> blocks after the
  // sanitized HTML is in the DOM. highlight.js mutates the elements in
  // place (adds span wrappers + hljs-* classes); the CSS theme in
  // editor.css provides the colors.
  highlightCodeBlocks(dom.previewPane);

  // §18.2.3 — rewrite `<img src="./relative.png">` into streamable
  // `whale-file://` URLs. No-op if the host didn't supply `dirPath` or
  // the document has no images. Runs after `highlightCodeBlocks` so
  // neither step's DOM mutation interferes with the other.
  resolveLocalImages(dom.previewPane, ctx.currentDir);

  // §copy — hover "Copy" button on each code block (after hljs so the button
  // sits over the highlighted <pre>). §lightbox — click <img> to zoom.
  addLanguageLabels(dom.previewPane);
  addCodeLineNumbers(dom.previewPane);
  addCodeCopyButtons(dom.previewPane);
  attachImageLightbox(dom.previewPane);
  // §task — clickable checkboxes toggle the editor's matching task line.
  addTaskInteractivity(dom.previewPane, (idx) => {
    if (ctx.view) toggleTaskInEditor(ctx.view, idx);
  });

  // §table-edit — editable preview cells write back into the editor. The
  // editor is still the source of truth: `replaceTableCellInEditor` dispatches
  // a narrow change so the docChanged listener fires and a follow-up preview
  // re-render keeps the table in sync.
  addTableInteractivity(
    dom.previewPane,
    (sourceLine, column, value) => {
      if (!ctx.view) return;
      // Skip when the view is currently read-only — typing into a read-only
      // editor would no-op anyway, and bouncing it through CodeMirror would
      // briefly toggle the dirty flag.
      if (ctx.view.state.readOnly) return;
      replaceTableCellInEditor(ctx.view, sourceLine, column, value);
    },
    () => {
      // §table-edit — the user finished editing a preview cell. Force a
      // preview re-render so the rest of the document catches up (the
      // debounced `schedulePreview` was suppressed while the cell had focus).
      ctx.rafScheduler.cancel();
      if (ctx.view) {
        const doc = ctx.view.state.doc.toString();
        ctx.rafScheduler.schedule(() => renderPreview(doc));
      }
    }
  );

  // §18.3.3 — render Mermaid diagrams. Lazy-imports mermaid on first
  // call (~200KB gzipped); async, so we don't await it — the SVG
  // appears ~100-500ms after the preview paints. Errors fall back to
  // raw source + console.warn (handled inside `renderMermaid`).
  // Fire-and-forget; the placeholder is visible immediately.
  void renderMermaid(dom.previewPane);

  // §18.3.3 — render KaTeX math. Same fire-and-forget shape as
  // mermaid: the placeholder (`<span class="katex">…</span>`) shows
  // the raw LaTeX immediately; the sandbox replaces it with the
  // rendered HTML ~50-200ms later. KaTeX has its own sandbox iframe
  // (no `unsafe-eval` needed — KaTeX is pure JS), so the main CSP
  // stays strict.
  void renderKatex(dom.previewPane);

  // §html-block — ```` ```html ```` blocks render live (sandboxed srcdoc
  // iframe). Sync setup (the iframe loads itself); height arrives later via
  // the injected report script → postMessage (see md-render renderHtmlBlocks).
  renderHtmlBlocks(dom.previewPane);

  // §scroll-perf — rebuild the source-line → block map so syncPreviewScroll
  // can O(1) lookup on each scroll frame. Done after all DOM mutations
  // above so the map reflects the final structure.
  ctx.previewLineMap = new Map();
  dom.previewPane.querySelectorAll('[data-source-line]').forEach((el) => {
    const ln = Number((el as HTMLElement).dataset.sourceLine);
    if (Number.isFinite(ln)) ctx.previewLineMap.set(ln, el as HTMLElement);
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

  ctx.lastRenderedContent = content;
}

function schedulePreview() {
  // §table-edit — the user is typing inside a preview table cell. Skip the
  // preview re-render: the cell already shows the latest text, and rebuilding
  // the preview would drop the user's caret. The cell's blur handler will
  // call this again so the rest of the document stays in sync once focus
  // leaves the cell.
  if (ctx.previewCellEditing) return;
  // view may be null during the brief window between setContent's
  // cancel() and the next createEditor; guard with the optional chain.
  if (!ctx.view) return;
  ctx.scheduler.schedule(
    () => ctx.view!.state.doc.toString(),
    // §18.2.4 — wrap the actual render in rAF so the innerHTML swap
    // happens aligned with the next browser repaint, not mid-frame.
    // `renderPreview` itself is still the source of truth (and contains
    // the shouldSkipRender guard); the rAF just times WHEN it runs.
    (doc) => ctx.rafScheduler.schedule(() => renderPreview(doc))
  );
}

function createEditor(container: HTMLElement) {
  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged && ctx.currentPath) {
      schedulePreview();
      ctx.isDirty = true;
      window.whaleExt.postMessage({
        type: 'contentChangedInEditor',
        path: ctx.currentPath,
        dirty: true,
      });
    }
    // §18.2.2 — patch status bar on every doc/selection/viewport change.
    // `view.state` is always current inside the listener. The bar reflects
    // the *primary* selection (matches text-editor's convention; multi-
    // selection via `state.selection.ranges` is ignored by the status).
    // §status-split — cursor moves only update the cheap line/col/sel/
    // undo-redo indicators; the O(n) word count runs debounced on edits.
    if (update.selectionSet) updateCursorStatus(ctx.view!);
    if (update.docChanged) {
      updateCursorStatus(ctx.view!);
      scheduleWordCount(ctx.view!);
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

  const state = EditorState.create({
    doc: '',
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      // §18.3.5 — undo/redo + save/find/zoom/formatting keymaps, registered
      // BEFORE defaultKeymap (first-match-wins) so the undo/redo flash wrapper
      // fires before defaultKeymap's silent undo/redo. See md-keymaps.ts.
      ctx.keymapCompartment.of(keymap.of(buildEditorKeymaps(ctx.mdKeybindings))),
      // §18.2.1 — search() + searchKeymap (the panel's own bindings).
      search(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap]),
      markdown(),
      // §fold — heading/code foldService + gutter markers + Ctrl-Shift-[ / ].
      markdownFoldExtension,
      // §fold — codeFolding() provides the foldState field that foldGutter,
      // foldKeymap, and applyFoldToPreview all read.
      codeFolding(),
      foldGutter(),
      // §editor-theme — markdown/code token colors, rebuilt per preset.
      ctx.highlightCompartment.of(syntaxHighlighting(buildMdHighlightFromCss())),
      ctx.themeCompartment.of(themeExtension('light')),
      ctx.readOnlyCompartment.of(EditorView.editable.of(true)),
      ctx.fontSizeCompartment.of(
        EditorView.theme({
          '&': { fontSize: `${ctx.mdFontSize}px` },
          '.cm-content': { fontSize: `${ctx.mdFontSize}px` },
        })
      ),
      ctx.wrapCompartment.of(
        ctx.mdWrapMode === 'wrap' ? [EditorView.lineWrapping] : []
      ),
      updateListener,
    ],
  });

  ctx.view = new EditorView({
    state,
    parent: container,
  });

  // §toolbar — wire toolbar buttons (find/wrap/zoom/toc/export/goto-line) +
  // the initial wrap indicator. See md-toolbar.ts.
  setupToolbar();

  // §scroll — wire editor scroll → preview sync + preview wheel → editor
  // scroller forwarder, and prime the initial sync. See md-scroll.ts.
  setupScroll(ctx.view);
  // §context-menu — right-click menus for editorPane (full) and previewPane
  // (copy/export). See md-contextmenu.ts.
  setupContextMenu();
  // §18.2.2 — the updateListener doesn't fire on view creation, so seed
  // the status bar here (otherwise it shows the initial 0/0/0/0/0
  // values from the static HTML until the first user input).
  updateStatus(ctx.view);
}

function setContent(content: string) {
  // §18.1.2 — cancel any pending debounced render before swapping the
  // document. Without this, an in-flight timer from the previous file
  // would fire after the dispatch and re-render the preview redundantly
  // (or, in the worst case, against a still-loading view).
  ctx.scheduler.cancel();
  // §18.2.4 — also cancel the inner rAF scheduler; a stale rAF callback
  // must not render against the just-swapped document.
  ctx.rafScheduler.cancel();
  // §status-split — cancel any pending debounced word-count from the
  // previous file; updateStatus below paints fresh values immediately.
  if (ctx.wordCountTimer !== null) {
    clearTimeout(ctx.wordCountTimer);
    ctx.wordCountTimer = null;
  }
  // §18.3.5 — a fresh file load is by definition clean (whatever is on
  // disk matches what we're showing). Clear the dirty flag.
  ctx.isDirty = false;
  if (!ctx.view) return;
  ctx.view.dispatch({
    changes: {
      from: 0,
      to: ctx.view.state.doc.length,
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
  ctx.lastRenderedContent = null;
  renderPreview(content);
}

function handleMessage(msg: HostMessage) {
  switch (msg.type) {
    case 'fileContent':
      // §18.1.2 — cancel the previous file's pending preview render
      // before we recreate the editor / replace the doc.
      ctx.scheduler.cancel();
      ctx.currentPath = msg.path;
      // §18.2.3 — host-supplied dir path used by `resolveLocalImages`
      // to rewrite relative `<img src>` into `whale-file://` URLs.
      // Optional in the message; older hosts (or tests) can omit it.
      ctx.currentDir = msg.dirPath ?? null;
      if (!ctx.view) createEditor(dom.editorPane);
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
      ctx.mdThemePref = msg.theme;
      persistMdThemePref(ctx.mdThemePref);
      applyPreset(resolvePreset());
      break;
    }
    case 'setCustomCallouts': {
      // §settings-sync — host pushed the custom callout list. Update
      // md-render's index + re-render so visible `[!custom]` blocks pick up
      // new icons/colors immediately.
      setCustomCallouts(msg.callouts);
      if (ctx.currentPath !== null) schedulePreview();
      break;
    }
    case 'setKeybindings': {
      // §md-keybindings — host pushed action→combo overrides. Reconfigure the
      // keymapCompartment so the change applies to the already-open editor.
      ctx.mdKeybindings = msg.keybindings;
      if (ctx.view) {
        ctx.view.dispatch({
          effects: ctx.keymapCompartment.reconfigure(
            keymap.of(buildEditorKeymaps(ctx.mdKeybindings))
          ),
        });
      }
      break;
    }
    case 'setImageSaveConfig': {
      // §paste-image — host pushed image-save mode + subfolder name. Stored
      //  on ctx; the paste handler reads them on the next image paste.
      ctx.mdImageSaveMode = msg.mode;
      ctx.mdImageSubfolder = msg.subfolder;
      break;
    }
    case 'setReadOnly':
      setReadOnly(msg.readOnly);
      break;
    case 'clipboardText':
      // §context-menu Paste — the host's clipboard reply for the menu's
      // `requestClipboardText` (see md-contextmenu.ts).
      handleClipboardText(msg);
      break;
    case 'savingFile':
      // §18.3.5 — host signals it's about to write our latest content
      // to disk (or has just done so). Clear the dirty flag.
      ctx.isDirty = false;
      if (ctx.currentPath && ctx.view) updateStatus(ctx.view);
      if (ctx.currentPath) {
        window.whaleExt.postMessage({
          type: 'contentChangedInEditor',
          path: ctx.currentPath,
          dirty: false,
        });
      }
      break;
    case 'requestSave':
      if (ctx.currentPath && ctx.view && !ctx.view.state.readOnly) {
        window.whaleExt.postMessage({
          type: 'parentSaveDocument',
          path: ctx.currentPath,
          content: ctx.view.state.doc.toString(),
        });
      }
      break;
    case 'requestSelection':
      if (ctx.currentPath && ctx.view) {
        const { from, to } = ctx.view.state.selection.main;
        window.whaleExt.postMessage({
          type: 'editorSelection',
          requestId: msg.requestId,
          path: ctx.currentPath,
          selectedText: ctx.view.state.sliceDoc(from, to),
          from,
          to,
        });
      }
      break;
    case 'applyReplacement':
      if (ctx.view && !ctx.view.state.readOnly) {
        ctx.view.dispatch({
          changes: { from: msg.from, to: msg.to, insert: msg.text },
          selection: { anchor: msg.from + msg.text.length },
        });
      }
      break;
    case 'imageSaved': {
      // §paste-image — host saved the pasted image; insert ![](./rel) where
      // `rel` is the saved path relative to currentDir. In 'subfolder' mode
      // that's `<folder>/image-<ts>.<ext>`; in 'current' mode just the
      // basename. resolveLocalImages rewrites it to whale-file:// at render.
      if (ctx.view && msg.path && ctx.currentDir) {
        const rel = msg.path
          .slice(ctx.currentDir.length)
          .replace(/^[\\/]+/, '')
          .replace(/\\/g, '/');
        ctx.view.dispatch(ctx.view.state.replaceSelection(`![](./${rel})`));
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

// §i18n — subscribe to host locale; onLocale fires once immediately
// (painting chrome in the current language) + on every switch.
window.whaleExt.onLocale(applyLocale);

// §18.2.5 — guess the initial theme from the OS / browser preference so
// the iframe doesn't flash light before the host's first `setTheme`
// message arrives. Host's `setTheme` (when it lands) still wins via
// `applyTheme()`; this is just the boot-time seed.
applyTheme(detectInitialTheme());
