/**
 * md-editor preview scroll sync — mirror the editor's scroll position onto
 * the overflow:hidden preview pane using `data-source-line` markers.
 * Extracted from index.ts (Phase 4 of the architecture split).
 *
 * The preview is `overflow: hidden` (no scrollbar, no wheel scroll), so this
 * is the only path that moves the rendered preview. Reads the shared `ctx`
 * (view, scrollSyncRaf, previewLineMap) + `dom` (previewPane); calls
 * `setActiveTocLine` from md-toc when the matched block is a heading.
 */
import type { EditorView } from '@codemirror/view';
import { ctx, dom } from './md-context';
import { setActiveTocLine } from './md-toc';

/** Coalesce scroll-driven syncs to one per animation frame (scroll + the
 *  preview-wheel forwarder fire at high frequency; syncPreviewScroll does
 *  lineBlockAtHeight + layout reads, so batching per rAF keeps scrolling
 *  smooth). */
export function scheduleSyncPreviewScroll(): void {
  if (ctx.scrollSyncRaf) return;
  ctx.scrollSyncRaf = requestAnimationFrame(() => {
    ctx.scrollSyncRaf = 0;
    syncPreviewScroll();
  });
}

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
export function syncPreviewScroll(): void {
  const scroller = ctx.view?.scrollDOM;
  if (!scroller || !ctx.view) return;

  const scrollTop = scroller.scrollTop;
  const editorMax = scroller.scrollHeight - scroller.clientHeight;
  if (editorMax <= 0) {
    // 编辑器内容短(无滚动空间),但预览可能仍比编辑器高(大图片 / 表格
    // 撑高)。这时预览靠 setupScroll 的 wheel-forwarder 独立滚动 —— 不要
    // 钉回顶部,否则短文档 + 图片撑高的预览永远看不到下半部分。只有预览
    // 也没滚动空间(纯短文档)时才归零。
    const previewMaxBottom =
      dom.previewPane.scrollHeight - dom.previewPane.clientHeight;
    if (previewMaxBottom <= 0) dom.previewPane.scrollTop = 0;
    return;
  }

  // §scroll-bottom — when the editor is near its bottom, pin the preview to
  // its bottom too. Without this, the source-line alignment below puts the
  // last block's TOP at the viewport top, leaving its body (footnotes, etc.)
  // cut off below the viewport — so you couldn't wheel to the preview's end.
  const previewMaxBottom = dom.previewPane.scrollHeight - dom.previewPane.clientHeight;
  if (previewMaxBottom > 0 && scrollTop >= editorMax - 60) {
    dom.previewPane.scrollTop = previewMaxBottom;
    return;
  }
  // §scroll-top — symmetric: editor near its top → preview pinned to top.
  // Without this the first block's padding offset can leave the preview
  // scrolled a touch down when the editor is already at the very top.
  if (scrollTop <= 60) {
    dom.previewPane.scrollTop = 0;
    return;
  }

  // Find the document line under the editor's current top.
  let lineNo: number | null = null;
  const block = ctx.view.lineBlockAtHeight(scrollTop);
  if (block) {
    try {
      lineNo = ctx.view.state.doc.lineAt(block.from).number;
    } catch {
      lineNo = null;
    }
  }

  if (lineNo !== null) {
    // §scroll-perf — O(1) map lookup (rebuilt in renderPreview) with a
    // querySelector fallback for the brief window before the first render
    // finishes building it.
    const target =
      ctx.previewLineMap.get(lineNo) ??
      (dom.previewPane.querySelector(
        `[data-source-line="${lineNo}"]`
      ) as HTMLElement | null);
    if (target) {
      const previewRect = dom.previewPane.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      // Position the target at the top of the preview viewport. If the
      // preview is shorter than its content (no overflow), this is a
      // no-op. If the preview is taller, scroll to put the target at top.
      const previewMax = dom.previewPane.scrollHeight - dom.previewPane.clientHeight;
      if (previewMax > 0) {
        // Compute the target's offset within the preview's scrollable
        // content, then center it (or put it at the top — top-aligned
        // matches the editor's "what's at the top of my view" mental model).
        const targetTop = targetRect.top - previewRect.top + dom.previewPane.scrollTop;
        dom.previewPane.scrollTop = Math.max(0, Math.min(previewMax, targetTop));
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
  const previewMax = dom.previewPane.scrollHeight - dom.previewPane.clientHeight;
  dom.previewPane.scrollTop = Math.round(ratio * Math.max(0, previewMax));
  // Ratio fallback can't pinpoint a heading, so leave the existing
  // activeTocLine alone (don't reset to null — that would flicker
  // the highlight as the user scrolls through a long code block).
}

/**
 * §scroll — wire the editor's `scroll` event to `scheduleSyncPreviewScroll`,
 * forward wheel events over the preview pane to the editor's scroller, and
 * prime the initial sync. Called once from `createEditor` after the view
 * mounts.
 *
 * The preview is `overflow: hidden` (single-view design: the editor is the
 * sole scroll source, `syncPreviewScroll` mirrors its scrollTop onto the
 * preview), so without the wheel forwarder a wheel over the preview does
 * nothing. Forwarding to the editor's scroller scrolls the editor, which
 * fires its `scroll` event → syncPreviewScroll mirrors it back, keeping the
 * two panes in lock-step.
 */
export function setupScroll(view: EditorView): void {
  view.scrollDOM.addEventListener('scroll', scheduleSyncPreviewScroll, { passive: true });
  dom.previewPane.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      const scroller = view.scrollDOM;
      // Normalize deltaMode: 0 = px (Chrome/Windows/Mac default), 1 = lines,
      // 2 = pages. Most mice/touchpads fire mode 0; the 1/2 branches cover
      // the rare browsers/devices reporting in lines or pages.
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 24;
      else if (e.deltaMode === 2) dy *= scroller.clientHeight;
      // Forward to the editor's scroller first (single-scroll design: editor
      // scrolls → syncPreviewScroll mirrors it onto the preview). When the
      // editor has no scroll room (short doc) OR is already pinned at its
      // top/bottom, it can't absorb the delta — hand the remainder to the
      // preview so a tall preview (big images / tables) is still reachable.
      // Without this, a short source whose preview is tall leaves the preview
      // stuck with its bottom out of reach.
      const before = scroller.scrollTop;
      scroller.scrollTop += dy;
      const remaining = dy - (scroller.scrollTop - before);
      if (remaining !== 0) {
        dom.previewPane.scrollTop += remaining;
      }
    },
    { passive: true }
  );
  // First paint after the editor mounts: prime the sync so the preview's
  // initial scrollTop matches the editor's (defaults to 0).
  syncPreviewScroll();
}
