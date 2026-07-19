/**
 * md-editor keymap shortcuts — undo/redo (with status-bar flash), save,
 * find/goto-line, zoom, and markdown formatting (bold/italic/link).
 *
 * `buildEditorKeymaps(bindings?)` returns the set as a `KeyBinding[]`; each
 * action's `key` comes from `bindings` (host-pushed user overrides — see the
 * renderer's `domain/md-keybindings.ts`) or falls back to the built-in default.
 * `''` unbinds an action. The run handlers are a fixed implementation detail —
 * only the key string is user-rebindable. createEditor wraps the result in
 * `ctx.keymapCompartment.of(...)`, and handleMessage's `setKeybindings`
 * reconfigures it live, so rebinding in Settings takes effect immediately in
 * the already-open editor.
 *
 * Placed BEFORE defaultKeymap (first-match-wins) so the undo/redo flash wrapper
 * fires instead of defaultKeymap's silent undo/redo; the other bindings
 * (Mod-s/f/g/=/-/0/b/i/k) don't conflict with defaultKeymap, so their order
 * relative to it is harmless.
 */
import type { KeyBinding } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { ctx, MD_DEFAULT_FONT_SIZE, MD_FONT_SIZE_STEP } from './md-context';
import { applyFontSize } from './md-theme';
import { flashUndoIndicator, flashRedoIndicator } from './md-statusbar';
import {
  promptForLine,
  wrapSelection,
  insertLink,
  insertCallout,
  openTableDialog,
  toggleHeading,
  increaseHeading,
  decreaseHeading,
} from './md-toolbar';

const undoRun = (): boolean => {
  if (undo(ctx.view!)) {
    flashUndoIndicator();
    return true;
  }
  return false;
};
const redoRun = (): boolean => {
  if (redo(ctx.view!)) {
    flashRedoIndicator();
    return true;
  }
  return false;
};
const saveRun = (): boolean => {
  if (!ctx.currentPath || !ctx.view) return false;
  if (ctx.view.state.readOnly) return false;
  window.whaleExt.postMessage({
    type: 'parentSaveDocument',
    path: ctx.currentPath,
    content: ctx.view.state.doc.toString(),
  });
  return true;
};
const findRun = (): boolean => {
  if (!ctx.view) return false;
  openSearchPanel(ctx.view);
  return true;
};
const gotoRun = (): boolean => {
  if (!ctx.view) return false;
  promptForLine(ctx.view);
  return true;
};
const zoomInRun = (): boolean => {
  if (!ctx.view) return false;
  applyFontSize(ctx.mdFontSize + MD_FONT_SIZE_STEP, ctx.view);
  return true;
};
const zoomOutRun = (): boolean => {
  if (!ctx.view) return false;
  applyFontSize(ctx.mdFontSize - MD_FONT_SIZE_STEP, ctx.view);
  return true;
};
const zoomResetRun = (): boolean => {
  if (!ctx.view) return false;
  applyFontSize(MD_DEFAULT_FONT_SIZE, ctx.view);
  return true;
};

/**
 * Build the editor keymap. `bindings` is an action→CodeMirror-combo map
 * (host-pushed user overrides); a missing action uses the default, and `''`
 * unbinds the action. Returns `KeyBinding[]` for `keymap.of(...)`.
 */
export function buildEditorKeymaps(
  bindings?: Record<string, string>
): KeyBinding[] {
  const get = (action: string, def: string): string =>
    bindings?.[action] ?? def;
  const list: KeyBinding[] = [];
  const push = (
    action: string,
    def: string,
    run: KeyBinding['run'],
    opts?: Partial<KeyBinding>
  ): void => {
    const key = get(action, def);
    if (key === '') return; // '' = unbound
    list.push({ key, run, ...opts });
  };

  push('undo', 'Mod-z', undoRun);
  push('redo', 'Mod-Shift-z', redoRun);
  // Mod-y: Windows-style redo. Kept fixed (not user-rebindable) so the Windows
  // habit keeps working regardless of what the user sets the main redo key to.
  list.push({ key: 'Mod-y', run: redoRun });
  push('save', 'Mod-s', saveRun);
  push('find', 'Mod-f', findRun);
  push('gotoLine', 'Mod-g', gotoRun);
  push('zoomIn', 'Mod-=', zoomInRun);
  push('zoomOut', 'Mod--', zoomOutRun);
  push('zoomReset', 'Mod-0', zoomResetRun);
  // §fmt — preventDefault stops the browser's native Mod-B (bookmarks) / Mod-I.
  push('bold', 'Mod-b', (v) => wrapSelection(v, '**', '**'), { preventDefault: true });
  push('italic', 'Mod-i', (v) => wrapSelection(v, '*', '*'), { preventDefault: true });
  push('link', 'Mod-k', insertLink, { preventDefault: true });
  push('callout', 'Mod-q', insertCallout, { preventDefault: true });
  push('table', 'Mod-t', openTableDialog, { preventDefault: true });
  // §paragraph — Typora-style heading shortcuts (Ctrl+1..6 / Ctrl+= / Ctrl+-).
  push('heading1', 'Mod-1', () => { if (!ctx.view) return false; toggleHeading(ctx.view, 1); return true; });
  push('heading2', 'Mod-2', () => { if (!ctx.view) return false; toggleHeading(ctx.view, 2); return true; });
  push('heading3', 'Mod-3', () => { if (!ctx.view) return false; toggleHeading(ctx.view, 3); return true; });
  push('heading4', 'Mod-4', () => { if (!ctx.view) return false; toggleHeading(ctx.view, 4); return true; });
  push('heading5', 'Mod-5', () => { if (!ctx.view) return false; toggleHeading(ctx.view, 5); return true; });
  push('heading6', 'Mod-6', () => { if (!ctx.view) return false; toggleHeading(ctx.view, 6); return true; });
  push('headingIncrease', 'Mod-=', () => { if (!ctx.view) return false; increaseHeading(ctx.view); return true; });
  push('headingDecrease', 'Mod--', () => { if (!ctx.view) return false; decreaseHeading(ctx.view); return true; });
  // §edit — Replace opens the search panel (which carries the replace field).
  push('replace', 'Mod-h', () => { if (!ctx.view) return false; openSearchPanel(ctx.view); return true; });
  return list;
}
