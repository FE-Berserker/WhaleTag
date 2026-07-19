/**
 * md-editor code/heading folding — foldService registration + preview mirror.
 * Extracted from index.ts (Phase 3 of the architecture split).
 *
 * lang-markdown ships no heading or code-fence fold, so we provide both as
 * language-data foldServices (foldGutter markers + Ctrl-Shift-[ keymap).
 * `applyFoldToPreview` mirrors the editor's foldState onto the preview pane
 * (hide folded section blocks / collapse folded code blocks), called from
 * the updateListener on foldEffect/unfoldEffect + from renderPreview.
 *
 * Reads the shared `ctx` (view) + `dom` (previewPane) from md-context.
 */
import { EditorState, type Extension } from '@codemirror/state';
import { foldState } from '@codemirror/language';
import { ctx, dom } from './md-context';

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
export function applyFoldToPreview(): void {
  if (!ctx.view) return;
  const folds = ctx.view.state.field(foldState, false);
  const ranges: Array<{ fromLine: number; toLine: number }> = [];
  if (folds) {
    folds.between(0, ctx.view.state.doc.length, (from, to) => {
      ranges.push({
        fromLine: ctx.view!.state.doc.lineAt(from).number,
        toLine: ctx.view!.state.doc.lineAt(to).number,
      });
    });
  }
  const blocks = dom.previewPane.querySelectorAll('[data-source-line]');
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
      const fromLineText = ctx.view!.state.doc.line(r.fromLine).text;
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
export const markdownFoldExtension: Extension = EditorState.languageData.of(() => [
  { foldService: foldMarkdownHeading },
  { foldService: foldCodeBlock },
]);
