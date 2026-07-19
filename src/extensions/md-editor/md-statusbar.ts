/**
 * md-editor status bar — cursor / selection / word-count / undo-redo
 * indicators. Extracted from index.ts (Phase 1 of the architecture split).
 *
 * Reads/writes the shared `ctx` (isDirty, wordCountTimer, undoFlashTimer,
 * redoFlashTimer) and `dom` (status* element refs) singletons from
 * md-context. The host updateListener (still in index.ts) calls these on
 * every doc/selection change + after undo/redo keypresses; `setContent` /
 * `setReadOnly` / `handleMessage.savingFile` also call `updateStatus` to
 * re-seed.
 *
 * §status-split — the status bar updates in two paths:
 *  - `updateCursorStatus` (O(1)): line/col/length/selection + read-only +
 *    dirty + undo/redo availability. Runs on every cursor move and edit.
 *  - `updateWordCount` (O(n)): words + reading time. Runs debounced
 *    (`scheduleWordCount`) only on edits — never on a bare cursor move.
 *    Previously a single `updateStatus` ran the full `getStatusInfo`
 *    (incl. `doc.toString()` + word count) on every selectionSet, which
 *    made large docs jank on arrow keys.
 */
import { EditorView } from '@codemirror/view';
import { historyField } from '@codemirror/commands';
import { ctx, dom } from './md-context';
import { getStatusInfo } from './md-render';
import { T } from './md-i18n';

/**
 * Recompute the cheap (O(1)) status fields from the current
 * `EditorView.state` and patch the DOM. Called from the
 * `EditorView.updateListener` on every doc or selection change, and once
 * after `createEditor` to seed the bar (the listener doesn't fire on view
 * creation).
 */
export function updateCursorStatus(view: EditorView): void {
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  const lineObj = doc.lineAt(sel.from);
  dom.statusLnEl.textContent = String(lineObj.number);
  dom.statusColEl.textContent = String(sel.from - lineObj.from + 1);
  dom.statusLengthEl.textContent = String(doc.length);
  dom.statusSelEl.textContent = String(sel.to - sel.from);
  dom.statusReadonlyEl.hidden = !view.state.readOnly;
  dom.statusDirtyEl.hidden = !ctx.isDirty;
  // §18.3.5 — undo/redo availability from the `history()` field.
  // CodeMirror 6's HistoryState exposes `done` / `undone` arrays (NOT
  // v5's `undoStack` / `redoStack`). `field(name, false)` returns
  // undefined if the extension isn't loaded (it is).
  const hist = view.state.field(historyField, false);
  const canUndo = !!hist && (hist as { done: unknown[] }).done.length > 0;
  const canRedo = !!hist && (hist as { undone: unknown[] }).undone.length > 0;
  dom.statusUndoEl.hidden = !canUndo;
  dom.statusRedoEl.hidden = !canRedo;
}

export function updateWordCount(view: EditorView): void {
  const info = getStatusInfo(view.state);
  dom.statusWordsEl.textContent = String(info.words);
  // §18.3.6 — reading time, only shown when meaningful (≥ 1 min).
  if (info.readingMinutes > 0) {
    dom.statusWordsEl.title = T.minRead.replace('{n}', String(info.readingMinutes));
  }
}

/** Full status refresh (cursor + word count). Used for the initial seed
 *  after `createEditor` / `setContent`, where we want everything painted
 *  at once. The per-keystroke path uses the split functions directly. */
export function updateStatus(view: EditorView): void {
  updateCursorStatus(view);
  updateWordCount(view);
}

/** Debounced word-count refresh — only edits change it, so a bare cursor
 *  move never pays the O(n) `getStatusInfo` cost. 300ms matches the preview
 *  scheduler. Cancelled on file switch (`setContent`). */
export function scheduleWordCount(view: EditorView): void {
  if (ctx.wordCountTimer !== null) clearTimeout(ctx.wordCountTimer);
  ctx.wordCountTimer = setTimeout(() => {
    ctx.wordCountTimer = null;
    if (view) updateWordCount(view);
  }, 300);
}

// §18.3.5 — brief flash of the undo/redo indicator on the matching
// keypress. Cmd+Z / Ctrl+Z pops the undo stack → we already updated
// the indicator via the updateListener; the flash adds visual
// confirmation that the keypress did something. We avoid touching
// the indicator classes from `updateStatus` — it just sets `hidden`,
// the flash adds a separate `.status-flash` class for ~250ms.
//
// Why a flash and not a permanent style change: the indicator's
// visible state already encodes "can undo / can redo" via `hidden`;
// a permanent "just-used" highlight would be redundant. The flash
// is purely feedback for the keystroke event itself.
export function flashUndoIndicator(): void {
  dom.statusUndoEl.classList.add('status-flash');
  if (ctx.undoFlashTimer !== null) clearTimeout(ctx.undoFlashTimer);
  ctx.undoFlashTimer = setTimeout(() => {
    dom.statusUndoEl.classList.remove('status-flash');
    ctx.undoFlashTimer = null;
  }, 250);
}

export function flashRedoIndicator(): void {
  dom.statusRedoEl.classList.add('status-flash');
  if (ctx.redoFlashTimer !== null) clearTimeout(ctx.redoFlashTimer);
  ctx.redoFlashTimer = setTimeout(() => {
    dom.statusRedoEl.classList.remove('status-flash');
    ctx.redoFlashTimer = null;
  }, 250);
}
