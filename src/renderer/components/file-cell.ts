import type { TFunction } from 'i18next';
import type { DirEntry } from '../../shared/ipc-types';
import type { TagGroup } from '../../shared/tag-library';

/**
 * Everything a single file cell needs to render and act — shared by the list
 * `Row` (react-window `List`) and the grid `GridCell` (react-window `Grid`).
 * `FileList` owns all the state and handlers and passes this bag down verbatim,
 * so the two views stay behavior-identical (selection, tagging, context menus).
 */
export interface FileCellData {
  /** The current visible (post tag-filter), sorted entries. */
  entries: DirEntry[];
  tagsByName: Map<string, string[]>;
  descByName: Map<string, string>;
  activeTag: string | null;
  tagColors: Record<string, string>;
  /** Tag groups — for three-tier color fallback (getTagColor). */
  groups: TagGroup[];
  /** When true (read-only location) the per-cell write actions are disabled. */
  readOnly: boolean;
  t: TFunction;
  /** Thumbnail data-URL cache (`${path}|${modified}` -> url); see ThumbIcon. */
  thumbCache: Map<string, string>;
  isSelected: (entry: DirEntry) => boolean;
  /**
   * H.23 P0-4: stable Set of currently-selected entry paths. Mutated by the
   * parent (FileList) and forwarded to each row so they don't have to
   * recompute `entries.filter(isSelected)` themselves — that was O(N²) for the
   * visible row window, every parent render. Set membership is O(1); the Set
   * identity only changes when the selection actually changes.
   *
   * Optional during the P0-1 extract: while FileList hasn't wired it up yet,
   * Row falls back to single-entry drag items (the pre-P0 behavior).
   */
  selectedPaths?: Set<string>;
  /**
   * H.23 P0-4: resolve a path back to its full entry — used by drop targets
   * to turn the dragged source paths into the `DirEntry[]` that `onDropFiles`
   * expects. Backed by `visibleByPath` (a `Map<string, DirEntry>` memo) on the
   * parent side. Optional during P0-1; falls back to an empty move (the parent
   * short-circuits on `sources.length === 0`).
   */
  resolveEntry?: (path: string) => DirEntry | undefined;
  /**
   * Select-gesture on the entry at `index` (into `entries`): plain toggles one,
   * `toggle` (Ctrl/Cmd) toggles without clearing, `shift` extends the range from
   * the last anchor. The linear index works for both list rows and grid cells.
   */
  onSelectRow: (index: number, mods: { shift: boolean; toggle: boolean }) => void;
  onOpen: (entry: DirEntry) => void;
  /** Toggle a tag as the active filter (already debounced of double-toggles). */
  onClickTag: (tag: string) => void;
  /** Right-click a tag chip: open the per-tag menu (remove) at (x, y). */
  onTagContextMenu: (entry: DirEntry, tag: string, x: number, y: number) => void;
  onDropTag: (entry: DirEntry, tag: string, functionality?: string) => void;
  /**
   * Drop one or more entries onto `target` (typically a folder) to move them
   * into it. Called by both the list row and the grid cell.
   */
  onDropFiles: (target: DirEntry, sources: DirEntry[]) => void;
  /** Right-click a cell: open the context menu at (x, y). */
  onContextEntry: (entry: DirEntry, x: number, y: number) => void;
  /** Create a new file/folder pre-tagged with a perspective value (Kanban/Calendar). */
  onCreateTagged?: (kind: 'file' | 'folder', autoTag: string) => void;
  /**
   * H.24 P0-1: set the file's date-typed tag (replaces any prior date tag).
   * `dateKey` is a normalized YYYY-MM-DD day key (e.g. `today-20260628`,
   * `20260628`, `20260628-20260630`). Optional because list/grid views don't
   * need it — only the Calendar right-click menu exposes it.
   */
  onSetEntryDateTag?: (entry: DirEntry, dateKey: string) => void;
  /**
   * H.24 P0-1: strip every date-typed tag from the file's sidecar. Optional
   * for the same reason as `onSetEntryDateTag`.
   */
  onRemoveEntryDateTag?: (entry: DirEntry) => void;
  /**
   * H.25 P0-1: move `sources` into a kanban/workflow column keyed by
   * `targetValue` (null = the untagged column → strip the whole group). The
   * caller supplies `groupTags` (the full stage axis) so the column target can
   * be resolved independently of the current state's group membership.
   * Mutually-exclusive semantics live in `tagsAfterMove` (shared/kanban.ts).
   * Optional: only the Kanban view uses it.
   */
  onMoveToColumn?: (
    sources: DirEntry[],
    targetValue: string | null,
    groupTags: string[]
  ) => void;
  /**
   * H.25 P0-1: append `tag` to the entry's sidecar. The underlying
   * `handleAddTag` runs `normalizeSmartTags` so rating / workflow / quadrant
   * stay mutually exclusive. No-op when the tag is already present.
   * Optional: only the Kanban right-click menu (and Properties tray) wire it.
   */
  onAddTag?: (entry: DirEntry, tag: string) => void;
  /**
   * H.25 P0-1: strip `tag` from the entry's sidecar. No-op when absent.
   * Optional: same scope as `onAddTag`.
   */
  onRemoveTag?: (entry: DirEntry, tag: string) => void;
  /**
   * H.25 P0-1: delegate to the generic file context menu (open / rename /
   * move / copy / delete / reveal / etc.) at (x, y). The Kanban right-click
   * menu uses this for its "More file actions" entry so users can reach the
   * full file-operation set without losing the kanban-specific context.
   * Optional: only KanbanEntryMenu wires it; default callers fall back to
   * the regular `onContextEntry` from EntryCard's right-click.
   */
  onMoreFileActions?: (entry: DirEntry, x: number, y: number) => void;
  /**
   * H.23 P1-5: per-column width overrides (px). Keys are the column ids
   * (`name` | `size` | `modified`); the `tags` column is `flex: 1` (fills
   * remaining space) and intentionally not in this map. `Row` reads the
   * value to set the cell's left-side `Typography` width; `RowColumnLabels`
   * reads it as the header's pixel width.
   */
  columnWidths: {
    name: number;
    size: number;
    modified: number;
  };
  /**
   * H.23 P1-5: column ids the user has toggled off via the right-click
   * header menu. `Row` skips rendering text for hidden columns to save
   * space; `RowColumnLabels` skips the header itself. Render order is
   * unaffected — columns are hidden in-place, not re-flowed.
   */
  hiddenColumns: readonly string[];
  /**
   * H.23 P2-1: zebra-striping toggle. When `true`, `Row` paints an
   * `action.hover` background on even-indexed rows (`index % 2 === 0`) —
   * common pattern for tabular UIs to help horizontal scanning. Off by
   * default (lighter on the eyes in low-light themes).
   */
  listZebra: boolean;
  /**
   * H.23 P2-3 date format preset for the list view's "modified" column.
   * Pushed into `cellData` so the toggle is one-click persistent without
   * re-rendering every row's onClick callbacks.
   */
  listDateFormat: 'absolute' | 'relative';
  /**
   * H.23 P1-1: index of the row currently focused via keyboard nav
   * (↑↓ / Home / End / click). `null` when nothing focused. Each row
   * compares its own `index` against this and renders an outline + auto-focuses
   * its `ListItemButton` on match. The grid view currently ignores it.
   */
  focusIndex: number | null;
  /**
   * H.23 P1-4: in-place rename state. `inlineRenameEntry?.path` identifies
   * the row currently in inline edit mode (only one at a time). When the
   * row's own entry matches, it swaps `Typography` for `TextField` with the
   * current name pre-filled & selected. F2 starts; Enter / blur commits;
   * Esc cancels. `null` ⇒ no row in edit mode.
   */
  inlineRenameEntry: DirEntry | null;
  /** Begin in-place rename on `entry`. Sets state so the matching row picks
   *  it up; pre-focuses and pre-selects the input on next render. */
  startInlineRename: (entry: DirEntry) => void;
  /** Discard current inline edit without committing. */
  cancelInlineRename: () => void;
  /** Commit the rename. Empty string or unchanged name are no-ops (treated
   *  as cancel). Errors surface via the parent's `setNotice`. */
  commitInlineRename: (entry: DirEntry, newName: string) => Promise<void>;
  // List-row inline action buttons. The grid omits these (it uses the context
  // menu / more-button), so GridCell simply doesn't read them.
  onCopy: (entry: DirEntry) => void;
  onMove: (entry: DirEntry) => void;
  onRename: (entry: DirEntry) => void;
  onDelete: (entry: DirEntry) => void;
  // Location-level shortcuts (set default / set reminder / toggle
  // read-only) were removed from per-entry right-click menus (P?).
  // They live in the Sidebar's per-location context menu, so
  // FileCellData no longer needs to carry them.
}
