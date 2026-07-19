/**
 * md-editor TOC (outline) sidebar — extraction + active-entry highlighting.
 * Extracted from index.ts (Phase 3 of the architecture split).
 *
 * Reads the shared `ctx` (activeTocLine, view) + `dom` (tocListEl,
 * previewPane) from md-context. `setActiveTocLine` is also called by
 * md-scroll's syncPreviewScroll (the editor scroll position pinpoints the
 * active heading synchronously — no IntersectionObserver needed).
 */
import { EditorView } from '@codemirror/view';
import { ctx, dom } from './md-context';
import { extractToc, renderToc } from './md-render';

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
//   - `ctx.activeTocLine` holds the currently highlighted line number
//     (or null if no heading is in view, e.g. document has no
//     headings or all headings are above the editor top).
//   - `setActiveTocLine(line)` updates the active entry's `.toc-active`
//     class — a cheap DOM walk (N entries, all in one container).
//     Called from `syncPreviewScroll` (editor scroll) and from the
//     TOC click handler (programmatic jump).
//   - When the TOC is re-rendered (e.g. after an edit changes the
//     heading list), the new entries get the class via the preserved
//     `ctx.activeTocLine` value.
export function setActiveTocLine(line: number | null): void {
  if (ctx.activeTocLine === line) return;
  ctx.activeTocLine = line;
  // Cheap full-walk: the TOC has at most a few dozen entries, and
  // we're toggling at most one on + one off per call.
  const links = dom.tocListEl.querySelectorAll('a.toc-entry');
  links.forEach((link) => {
    const lineAttr = link.getAttribute('data-toc-line');
    if (lineAttr !== null && Number(lineAttr) === line) {
      link.classList.add('toc-active');
    } else {
      link.classList.remove('toc-active');
    }
  });
}

/**
 * Re-extract the TOC from the current editor state and re-render the
 * sidebar. Called after every successful preview render. The TOC is a
 * thin projection of the markdown source; rebuilding it on every
 * keystroke (debounced via the outer scheduler) is cheap (< 1ms for
 * 200 headings).
 */
export function refreshToc(content: string): void {
  const entries = extractToc(content);
  renderToc(dom.tocListEl, entries, (entry) => {
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
    if (ctx.view) {
      const doc = ctx.view.state.doc;
      const lineNo = Math.min(Math.max(entry.line, 1), doc.lines);
      const lineInfo = doc.line(lineNo);
      ctx.view.dispatch({
        selection: { anchor: lineInfo.from },
        effects: EditorView.scrollIntoView(lineInfo.from, { y: 'start' }),
      });
      ctx.view.focus();
    }
    setActiveTocLine(entry.line);
    const target = dom.previewPane.querySelector(
      `[data-source-line="${entry.line}"]`
    ) as HTMLElement | null;
    if (target) {
      const previewRect = dom.previewPane.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const previewMax = dom.previewPane.scrollHeight - dom.previewPane.clientHeight;
      if (previewMax > 0) {
        const targetTop = targetRect.top - previewRect.top + dom.previewPane.scrollTop;
        dom.previewPane.scrollTop = Math.max(0, Math.min(previewMax, targetTop));
      }
    }
  });
  // §18.3.1 — re-apply the active highlight to the freshly-rendered
  // DOM. `renderToc` just replaced `tocListEl.innerHTML`, so the
  // previously-set `.toc-active` class is gone. Re-add it to the
  // entry matching `ctx.activeTocLine` (preserved across the re-render).
  if (ctx.activeTocLine !== null) {
    const links = dom.tocListEl.querySelectorAll('a.toc-entry');
    links.forEach((link) => {
      const lineAttr = link.getAttribute('data-toc-line');
      if (lineAttr !== null && Number(lineAttr) === ctx.activeTocLine) {
        link.classList.add('toc-active');
      }
    });
  }
}
