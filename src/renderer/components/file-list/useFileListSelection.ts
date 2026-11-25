import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import type { DirEntry } from '../../../shared/ipc-types';

/** Tri-state for the list header's select-all checkbox. */
export type SelectAllState = 'checked' | 'indeterminate' | 'unchecked';

/**
 * Selection + keyboard-focus state extracted from `FileList` (P2 FileList
 * split). The Set stays in a ref that is mutated in place; `selectedTick` is
 * the revision counter that invalidates the memos reading it (P0-3: avoids an
 * O(n) Set allocation per interaction and keeps the Set identity stable so
 * Row's drag payload memo doesn't churn).
 */
export interface FileListSelection {
  /** Mutated-in-place selection; identity only changes on a full replace. */
  selectedPathsRef: MutableRefObject<Set<string>>;
  /** Revision counter bumped whenever the Set's contents change. */
  selectedTick: number;
  bumpSelection: () => void;
  /** Back-compat shim used by `useListCommands`: updater over the live ref. */
  setSelected: (updater: (prev: Set<string>) => Set<string>) => void;
  isSelected: (entry: DirEntry) => boolean;
  /** Visible entries that are selected (kept in `visible` order). */
  selectedEntries: DirEntry[];
  selectAllState: SelectAllState;
  toggleSelectAll: () => void;
  clearSelection: () => void;
  /**
   * Selection gesture on the visible row at `index`:
   *  - Shift: add the inclusive range from the anchor to here (easy multi-pick).
   *  - Ctrl / Cmd: toggle just this row and make it the new anchor.
   *  - Plain click: select only this row (so the properties tray updates).
   */
  selectRow: (
    index: number,
    mods: { shift: boolean; toggle: boolean }
  ) => void;
  focusIndex: number | null;
  setFocusIndex: (index: number | null) => void;
}

export interface UseFileListSelectionOptions {
  /** Current visible (post tag-filter), sorted entries. */
  visible: DirEntry[];
  /** Selection is scoped to the directory it was made in. */
  currentDirectoryPath: string;
  /**
   * Reveal the properties tray on a selection gesture. Passed in (rather than
   * dispatching here) so this hook stays free of Redux/actions; callers must
   * memoize it, exactly like the `trayVisible` dependency it replaces.
   */
  ensureTrayVisible: () => void;
}

export function useFileListSelection({
  visible,
  currentDirectoryPath,
  ensureTrayVisible,
}: UseFileListSelectionOptions): FileListSelection {
  const selectedPathsRef = useRef<Set<string>>(new Set());
  const [selectedTick, setSelectedTick] = useState(0);
  const bumpSelection = useCallback(
    () => setSelectedTick((x) => (x + 1) & 0xffff),
    []
  );

  // H.23 P1-1 keyboard navigation: focusIndex is the row index the user is
  // currently focused on (via ↑↓ / Home / End / click). Row visuals + the
  // ref-based keyboard handler both read this. Storing in state (not just
  // ref) so Row can react with its own outline / auto-focus when the parent
  // toggles focus programmatically.
  const [focusIndex, setFocusIndexState] = useState<number | null>(null);
  const setFocusIndex = useCallback((index: number | null) => {
    setFocusIndexState(index);
  }, []);

  // Back-compat shim: a few call sites (notably `useListCommands`) update
  // selection by passing an `updater: (prev) => Set<string>` callback. We
  // keep that contract by reading the current ref, computing `next`, and
  // aliasing iff changed. No allocation when the updater returns the same
  // Set (e.g. no-op click handlers).
  const setSelected = useCallback(
    (updater: (prev: Set<string>) => Set<string>) => {
      const prev = selectedPathsRef.current;
      const next = updater(prev);
      if (next === prev) return;
      selectedPathsRef.current = next;
      bumpSelection();
    },
    [bumpSelection]
  );

  const selectedEntries = useMemo(() => {
    // `selectedPathsRef` is mutated in place; `selectedTick` is the revision
    // counter that tells this memo the Set changed. Read it so the dependency
    // is real (exhaustive-deps otherwise flags it as unnecessary).
    void selectedTick;
    return visible.filter((e) => selectedPathsRef.current.has(e.path));
  }, [visible, selectedTick]);

  // `isSelected` reads the mutated-in-place selection ref (P0-3), but its
  // identity is keyed on `selectedTick` deliberately: react-window v2 already
  // memoizes each row with a shallow-compare, so a selection change must flip
  // SOME cellData field's identity to make rows re-render and re-evaluate
  // `isSelected(entry)`. Without `selectedTick` here the callback would be
  // stable forever and checkboxes would go stale. (This replaces the prior
  // hand-written `arePropsEqual` + in-body `React.memo` layer, which was both
  // redundant with react-window's built-in memo and broken — see F1/F4 in the
  // H.23 review.)
  const isSelected = useCallback(
    (entry: DirEntry) => {
      // See `selectedEntries`: `selectedTick` is read to keep this callback's
      // identity keyed on the selection revision while the Set stays in a ref.
      void selectedTick;
      return selectedPathsRef.current.has(entry.path);
    },
    [selectedTick]
  );

  // Anchor row for Shift range-selection (the last row toggled without Shift).
  // Keyed by PATH, not by index: `visible` is re-sorted / filtered between
  // clicks, so a stored index addresses a different row afterwards — or none
  // at all once the filter shrank the list, which made the range loop read
  // PAST the end of `visible` (TypeError before `bumpSelection`, leaving a
  // half-applied invisible selection behind). The path is looked up in the
  // CURRENT list on every Shift click; an anchor that is no longer visible
  // degrades to a plain click instead.
  const selectAnchorPathRef = useRef<string | null>(null);

  /**
   * P0-3: the Set is mutated in place; rerender is triggered by
   * `bumpSelection`. This keeps the Set identity stable across toggles, which
   * downstream of `cellData.selectedPaths` (P0-4) means Row's dragItem memo
   * doesn't churn on every click.
   *
   * H.23 P1-1: every click also moves keyboard focus to the same row, so
   * subsequent arrow nav starts from where the user clicked. Clicking a
   * file/folder should always bring the properties tray back — the user
   * having closed it once shouldn't suppress it for every later click. (A
   * toggle-off that empties the selection still hides the tray via the
   * `selectedEntries.length > 0` render guard, so this is safe to set
   * unconditionally on any selection gesture.)
   */
  const selectRow = useCallback(
    (index: number, mods: { shift: boolean; toggle: boolean }) => {
      const entry = visible[index];
      if (!entry) return;
      setFocusIndex(index);
      ensureTrayVisible();
      const set = selectedPathsRef.current;
      let mutated = false;
      const anchorPath = selectAnchorPathRef.current;
      const anchorIndex =
        anchorPath === null
          ? -1
          : visible.findIndex((e) => e.path === anchorPath);
      if (mods.shift && anchorIndex >= 0) {
        // Both bounds are valid indices of the CURRENT `visible` list.
        const [lo, hi] =
          anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
        for (let i = lo; i <= hi; i += 1) {
          const p = visible[i].path;
          if (!set.has(p)) {
            set.add(p);
            mutated = true;
          }
        }
        // anchor is preserved so a follow-up Shift-click re-extends from it.
      } else if (mods.toggle) {
        if (set.has(entry.path)) set.delete(entry.path);
        else set.add(entry.path);
        selectAnchorPathRef.current = entry.path;
        mutated = true;
      } else {
        // Plain click: single-select the row.
        if (set.size !== 1 || !set.has(entry.path)) {
          set.clear();
          set.add(entry.path);
          mutated = true;
        }
        selectAnchorPathRef.current = entry.path;
      }
      if (mutated) bumpSelection();
    },
    [visible, ensureTrayVisible, setFocusIndex, bumpSelection]
  );

  const clearSelection = useCallback(() => {
    const set = selectedPathsRef.current;
    if (set.size === 0) return;
    set.clear();
    selectAnchorPathRef.current = null;
    bumpSelection();
  }, [bumpSelection]);

  // Selection is scoped to the directory it was made in: a Set left over from
  // the previous folder made the header claim "8 selected" (and the tri-state
  // box claim checked) while bulk actions only touched the intersection with
  // the new `visible` list. Reset it whenever the directory changes.
  useEffect(() => {
    clearSelection();
  }, [currentDirectoryPath, clearSelection]);

  // Tri-state select-all for the list-view column header. Compared against the
  // CURRENT `visible` array so the header always reflects what the user sees
  // (post-filter / post-search). Comparing Set size to visible.length was wrong
  // whenever the previous folder contributed extra selected paths.
  const selectAllState = useMemo<SelectAllState>(() => {
    // Selection lives in a mutated ref; the tick is what invalidates this.
    void selectedTick;
    if (visible.length === 0) return 'unchecked';
    let selectedVisible = 0;
    for (const e of visible) {
      if (selectedPathsRef.current.has(e.path)) selectedVisible += 1;
    }
    if (selectedVisible === 0) return 'unchecked';
    return selectedVisible === visible.length ? 'checked' : 'indeterminate';
  }, [visible, selectedTick]);

  const toggleSelectAll = useCallback(() => {
    if (selectAllState === 'checked') {
      // Fully checked → clear every selection (visible or not).
      clearSelection();
      return;
    }
    // Unchecked / indeterminate → fill every visible entry, preserving any
    // out-of-visible selections.
    const set = selectedPathsRef.current;
    let mutated = false;
    for (const e of visible) {
      if (!set.has(e.path)) {
        set.add(e.path);
        mutated = true;
      }
    }
    // After a fill, the shift-range anchor no longer points at a sensible row.
    selectAnchorPathRef.current = null;
    if (mutated) bumpSelection();
  }, [selectAllState, visible, clearSelection, bumpSelection]);

  return {
    selectedPathsRef,
    selectedTick,
    bumpSelection,
    setSelected,
    isSelected,
    selectedEntries,
    selectAllState,
    toggleSelectAll,
    clearSelection,
    selectRow,
    focusIndex,
    setFocusIndex,
  };
}
