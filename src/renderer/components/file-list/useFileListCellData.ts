import type { TFunction } from 'i18next';

import type { DirEntry } from '../../../shared/ipc-types';
import type { FileCellData } from '-/components/file-cell';
import type { ListCommands } from '-/hooks/useListCommands';
import { useStableBag } from '-/hooks/useStableBag';
import type { TagGroup } from '../../domain/tag-library';
import type { FileListTagActions } from './useFileListTagActions';

/**
 * Builds the `FileCellData` bag shared by the list `Row`, the grid `GridCell`
 * and every perspective view (P2 FileList split).
 *
 * Two invariants are preserved from the inline literal this replaces:
 *  1. every value must already be reference-stable (`useCallback` handler,
 *     memoized map/array) — `useStableBag` compares the bag's own fields and
 *     returns the previous object when they are `Object.is`-equal, which is
 *     what lets react-window v2's per-row shallow memo short-circuit unrelated
 *     parent renders;
 *  2. `selectedPaths` is the live, mutated-in-place Set (`selectedPathsRef
 *     .current`), not a copy — `buildFileDragItem` reads it at drag-start.
 */
export interface UseFileListCellDataOptions {
  /** Current visible (post tag-filter), sorted entries. */
  visible: DirEntry[];
  thumbCache: Map<string, string>;
  tagsByName: Map<string, string[]>;
  descByName: Map<string, string>;
  activeTag: string | null;
  tagColors: Record<string, string>;
  groups: TagGroup[];
  readOnly: boolean;
  t: TFunction;
  onOpen: FileCellData['onOpen'];
  selection: Pick<
    FileCellData,
    'isSelected' | 'onSelectRow' | 'selectedPaths'
  >;
  /** The four IO commands the cells/tiles call directly. */
  commands: Pick<
    ListCommands,
    'handleMove' | 'handleDelete' | 'handleDropTag' | 'handleDropFiles'
  >;
  /** Sidecar tag/date/geo writers surfaced through the cell bag. */
  tagActions: Pick<
    FileListTagActions,
    | 'handleSetEntryDateTag'
    | 'handleRemoveEntryDateTag'
    | 'handleSetEntryDateTags'
    | 'handleRemoveEntryDateTags'
    | 'handleMoveToColumn'
    | 'handleAddTag'
    | 'handleRemoveTag'
  >;
  /** Stable reaction callbacks built in FileList. */
  cellActions: Pick<
    FileCellData,
    | 'onClickTag'
    | 'onTagContextMenu'
    | 'onContextEntry'
    | 'onCreateTagged'
    | 'onMoreFileActions'
  >;
  /** Copy/rename handlers open the FileList-owned prompt dialogs. */
  setters: Pick<FileCellData, 'onCopy' | 'onRename'>;
  /** O(1) path → entry / path → index lookups (P0-4 / P2-8). */
  lookups: Pick<FileCellData, 'resolveEntry' | 'entryIndex'>;
  /** Persisted list-view layout state. */
  layout: Pick<
    FileCellData,
    | 'columnWidths'
    | 'hiddenColumns'
    | 'listZebra'
    | 'listDateFormat'
    | 'focusIndex'
  >;
  /** Single-row in-place rename state (H.23 P1-4). */
  inlineRename: Pick<
    FileCellData,
    | 'inlineRenameEntry'
    | 'startInlineRename'
    | 'cancelInlineRename'
    | 'commitInlineRename'
  >;
}

export function useFileListCellData({
  visible,
  thumbCache,
  tagsByName,
  descByName,
  activeTag,
  tagColors,
  groups,
  readOnly,
  t,
  onOpen,
  selection,
  commands,
  tagActions,
  cellActions,
  setters,
  lookups,
  layout,
  inlineRename,
}: UseFileListCellDataOptions): FileCellData {
  return useStableBag<FileCellData>({
    entries: visible,
    thumbCache,
    tagsByName,
    descByName,
    activeTag,
    tagColors,
    groups,
    readOnly,
    t,
    isSelected: selection.isSelected,
    selectedPaths: selection.selectedPaths,
    onSelectRow: selection.onSelectRow,
    onOpen,
    ...cellActions,
    onCopy: setters.onCopy,
    onRename: setters.onRename,
    onMove: commands.handleMove,
    onDelete: commands.handleDelete,
    onDropTag: commands.handleDropTag,
    onDropFiles: commands.handleDropFiles,
    onSetEntryDateTag: tagActions.handleSetEntryDateTag,
    onRemoveEntryDateTag: tagActions.handleRemoveEntryDateTag,
    onSetEntryDateTags: tagActions.handleSetEntryDateTags,
    onRemoveEntryDateTags: tagActions.handleRemoveEntryDateTags,
    onMoveToColumn: tagActions.handleMoveToColumn,
    onAddTag: tagActions.handleAddTag,
    onRemoveTag: tagActions.handleRemoveTag,
    ...lookups,
    ...layout,
    ...inlineRename,
  });
}
