import type { KeyboardEvent, MutableRefObject } from 'react';

import type { DirEntry } from '../../../shared/ipc-types';
import type { ViewMode } from '../../../shared/whale-meta';
import {
  nextView,
  resolveAction,
  type KeyAction,
} from '../../domain/keybindings';

/**
 * Returns true for text-entry surfaces (TextField, textarea, contenteditable)
 * so shortcuts like Delete / F2 / arrows don't fire while the user is typing
 * in a search box, InlineTagInput, the inline rename TextField, or a
 * PromptDialog.
 *
 * Checkboxes are intentionally NOT treated as input-like. The row's
 * selection Checkbox is a common focus target after a click — if we bailed
 * on it here, F2 rename / Space toggle / ↑↓ nav would all be silently
 * swallowed (the user reported F2 doing nothing after clicking a row's
 * checkbox). The Checkbox's native behavior is already suppressed by being
 * controlled (`checked={isSelected(entry)}` with no onChange), so letting
 * our keydown handler run is a strict UX improvement, not a regression.
 */
export function isInputLike(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input' && (target as HTMLInputElement).type !== 'checkbox') {
    return true;
  }
  if (target.isContentEditable) return true;
  return false;
}

/**
 * Returns true when the event originates inside a modal dialog. MUI puts
 * `role="dialog"` on the Dialog paper and traps focus inside it, so every
 * keydown while the media lightbox (or any other dialog rendered inside the
 * list container) is open targets the dialog — but React synthetic events
 * bubble through the REACT tree, portals included, so they still arrived at
 * the outer container's `onKeyDown`. That made Delete / F2 / Space fire on the
 * list BEHIND the lightbox, and ← even navigated the folder history. A modal
 * owns the keyboard while it is open; the list's shortcuts stay suspended.
 */
export function isWithinDialog(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest('[role="dialog"]') !== null
  );
}

/**
 * Everything `createKeyDownHandler` reads, injected by `FileList` so the
 * handler itself stays a pure function of its call-time inputs (no hooks, no
 * state of its own). Every field is read at event time, so passing fresh
 * closures each render is the intended usage — exactly what the previous
 * inline `handleKeyDown` in `FileList` did.
 */
export interface FileListKeyDownDeps {
  /** User-configurable key→action map (Settings ▸ Keyboard). */
  keybindings: Record<string, KeyAction>;
  /** Current visible (post-filter) entries; range/index math uses this. */
  visible: DirEntry[];
  /** Row index the keyboard cursor is on (`null` = nothing focused). */
  focusIndex: number | null;
  setFocusIndex: (index: number | null) => void;
  selectRow: (
    index: number,
    mods: { shift: boolean; toggle: boolean }
  ) => void;
  clearSelection: () => void;
  /** Selection lives in a mutated-in-place ref; F2's fallback reads it. */
  selectedPathsRef: MutableRefObject<Set<string>>;
  onOpen: (entry: DirEntry) => void;
  onStartInlineRename: (entry: DirEntry) => void;
  onDeleteSelected: () => void;
  showNotice: (
    text: string,
    severity?: 'success' | 'info' | 'warning' | 'error'
  ) => void;
  /** Localized `t('noRowToRename')` — shown when F2 has no target at all. */
  noRowToRename: string;
  canGoBack: boolean;
  goBack: () => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  /**
   * True while a modal (the media lightbox) is open over the list. Every list
   * shortcut is suspended then — `isWithinDialog` already covers the steady
   * state (focus trapped inside the dialog); this flag also covers the frames
   * between "open" and the focus trap grabbing focus, where the keydown
   * target is still the backdrop or `body`.
   */
  modalOpen?: boolean;
}

/**
 * H.23 keyboard navigation. Single attachment point (the outer container
 * `onKeyDown`). Skips when focus is on an input-like element so typing in
 * PromptDialog / InlineTagInput / the search bar never steals keys — this
 * also means Tab inside the rename TextField still moves focus normally.
 *
 * Keys resolve to actions via the user-configurable keybindings map
 * (Settings ▸ Keyboard; defaults in `renderer/domain/keybindings`).
 * `resolveAction` ignores modifiers on purpose — Shift-range-extend stays
 * inside the navigate cases. The bindings apply in list/grid; GalleryView
 * etc. own their own focused-container keydown.
 *
 * P1-1 (gui-audit 2026-11): GalleryView is rendered *inside* the outer
 * container, and its handler calls `stopPropagation` for the keys it consumes
 * (arrows / Home / End / Enter / Space). So those never reach this handler
 * from the gallery, while list-level shortcuts it does NOT handle (Delete /
 * F2 / Esc / Tab view-switch) still bubble up here — exactly the split the
 * comment above promises, no `viewMode` guard needed.
 *
 * Default scheme: ↑/↓ navigate (Shift = range), → open, ← back (history),
 * Tab cycle view, Enter open, Space toggle, Esc clear, F2 rename,
 * Delete delete, Home/End jump.
 */
export function createKeyDownHandler(deps: FileListKeyDownDeps) {
  const {
    keybindings,
    visible,
    focusIndex,
    setFocusIndex,
    selectRow,
    clearSelection,
    selectedPathsRef,
    onOpen,
    onStartInlineRename,
    onDeleteSelected,
    showNotice,
    noRowToRename,
    canGoBack,
    goBack,
    viewMode,
    setViewMode,
    modalOpen = false,
  } = deps;

  return (e: KeyboardEvent<HTMLDivElement>) => {
    if (isInputLike(e.target)) return;
    // A modal over the list owns the keyboard (see `isWithinDialog`).
    if (modalOpen || isWithinDialog(e.target)) return;

    const action = resolveAction(keybindings, e);

    // Delete runs before the empty-list guard, matching the pre-refactor
    // ordering (the standalone `Delete` branch returned before `last` was
    // ever computed, so Delete worked even on an empty list).
    if (action === 'delete') {
      e.preventDefault();
      onDeleteSelected();
      return;
    }

    const last = visible.length - 1;
    if (last < 0) return;
    const cur = focusIndex === null ? -1 : Math.min(focusIndex, last);
    const stepIndex = (target: number) =>
      Math.max(0, Math.min(target, last));

    switch (action) {
      case 'navigateDown':
        e.preventDefault();
        if (cur >= last) return;
        // Shift-extend stays INSIDE the case (resolveAction ignores mods).
        selectRow(stepIndex(cur + 1), { shift: e.shiftKey, toggle: false });
        break;
      case 'navigateUp':
        e.preventDefault();
        if (cur <= 0) return;
        selectRow(stepIndex(cur - 1), { shift: e.shiftKey, toggle: false });
        break;
      case 'jumpHome':
        e.preventDefault();
        selectRow(0, { shift: false, toggle: false });
        break;
      case 'jumpEnd':
        e.preventDefault();
        selectRow(last, { shift: false, toggle: false });
        break;
      case 'open': {
        e.preventDefault();
        const entry = visible[cur];
        if (entry) onOpen(entry);
        break;
      }
      // F2 starts in-place rename on the focused row. When the user is
      // already in inline edit mode, the row's TextField owns the keystrokes
      // (Enter commits, Esc cancels) so this is a no-op then.
      //
      // Fallback chain (B1, 2026-07-03): `visible[cur]` can be undefined
      // even when the user *thinks* they have a focused row. Three common
      // ways that happens:
      //   1. User just opened the app and pressed F2 before any click / ↑↓.
      //   2. User clicked a tag chip — `EntryTagChips` calls
      //      `e.stopPropagation()` on its click handler, so the row's
      //      `onClick` → `onSelectRow` → `setFocusIndex` never runs.
      //   3. User applied a search / tag filter after navigating, and the
      //      previously-focused index is now out of `visible` range.
      // Previously we silently no-op'd; the user saw F2 do nothing. Now we
      // walk a fallback chain — single selection, then first visible row —
      // and only show a notice when the list is truly empty of any target.
      case 'rename': {
        e.preventDefault();
        let target: DirEntry | undefined = visible[cur];
        if (!target && selectedPathsRef.current.size === 1) {
          const [selectedPath] = selectedPathsRef.current;
          target = visible.find((entry) => entry.path === selectedPath);
        }
        if (!target) target = visible[0];
        if (!target) {
          showNotice(noRowToRename, 'info');
          return;
        }
        // Keep the keyboard cursor on the row we just started renaming so
        // a follow-up Esc/Enter still lands on the right row.
        if (focusIndex === null || focusIndex !== visible.indexOf(target)) {
          setFocusIndex(visible.indexOf(target));
        }
        onStartInlineRename(target);
        break;
      }
      case 'toggleSelect':
        e.preventDefault();
        if (cur < 0) return;
        selectRow(cur, { shift: false, toggle: true });
        break;
      case 'clearSelection':
        e.preventDefault();
        clearSelection();
        break;
      case 'back':
        // History-LRU back (toolbar ← semantics). No-op at the location root
        // where `canGoBack === false`.
        if (canGoBack) {
          e.preventDefault();
          goBack();
        }
        break;
      case 'switchView':
        // The only case that swallows Tab — mapping Tab to 'none' makes
        // `resolveAction` return null, so we fall through to `default` and the
        // browser keeps its native focus traversal.
        e.preventDefault();
        setViewMode(nextView(viewMode));
        break;
      case 'none':
      default:
        break;
    }
  };
}
