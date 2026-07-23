import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Checkbox,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  TextField,
  Typography,
} from '@mui/material';
import type { RowComponentProps } from 'react-window';
import { useDrop, useDrag } from 'react-dnd';
import { usePeriodTagDialog } from './PeriodTagDialog';

/** Local `YYYY-MM-DD` for "today", used as the dialog's default start/end. */
function todayIsoLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

import type { DirEntry } from '../../shared/ipc-types';
import {
  DND_TYPE_TAG,
  type TagDragItem,
  DND_TYPE_FILE,
  type FileDragItem,
} from '-/services/dnd';
import ThumbIcon from '-/components/ThumbIcon';
import EntryTagChips from '-/components/EntryTagChips';
import { EMPTY_ARR } from '-/constants';
import type { FileCellData } from '-/components/file-cell';
import { stripTagsFromName } from '-/services/tags';
import { formatSize, formatDate } from '-/services/format';

/** Max number of tag chips rendered before the row truncates (`+N` chip is
 *  tracked under H.23 P1-6 follow-up — currently it just slices). */
const MAX_TAGS_PER_ROW = 4;

// P2-5 (perf audit): hoisted so the memo'd <EntryTagChips> gets a referentially
// stable `containerSx` prop instead of a fresh `{ flex: 1 }` every render.
const TAG_CHIPS_SX = { flex: 1 } as const;

/** Edge length of the list row's thumbnail / icon area (px). Must match the
 *  width FileListHeader reserves for the column-header checkbox + thumb slot
 *  (`ROW_THUMB_SIZE + 8` px). */
const ROW_THUMB_SIZE = 40;

/**
 * Renders one file/folder row inside the virtualized list. Receives the entire
 * `FileCellData` bag flattened as props (react-window v2 unpacks `rowProps`
 * into individual fields).
 *
 * Drag: an entry can be dragged to a folder. If it is part of the current
 * selection, the whole selection moves; otherwise only the dragged entry.
 *
 * Drop: tags can be dropped on any row; files can only be dropped onto folder
 * rows. Self-drop is filtered out (no folder into itself or its descendants).
 *
 * H.23 P0 notes: the previous version did `entries.filter(isSelected)` here to
 * build the drag item. That's O(N) per render per visible row, so for a
 * 1000-row directory with 30 rows on screen we computed 30 000 filter() calls.
 * P0-4 moves that work into `cellData.selectedPaths`; P0-5 then keeps
 * `useDrag`/`useDrop` from re-subscribing when nothing meaningful changed.
 */
export default function Row(props: RowComponentProps<FileCellData>) {
  const {
    index,
    style,
    entries,
    tagsByName,
    descByName,
    activeTag,
    tagColors,
    groups,
    readOnly,
    t,
    isSelected,
    onSelectRow,
    onOpen,
    onClickTag,
    onTagContextMenu,
    onDropTag,
    onDropFiles,
    onContextEntry,
    thumbCache,
    selectedPaths,
    resolveEntry,
    focusIndex,
    // H.23 P1-5 column-width plumbing.
    columnWidths,
    hiddenColumns,
    listZebra,
    listDateFormat,
    // H.23 P1-4 inline rename plumbing. Most rows don't pull startInlineRename
    // because they don't trigger their own edit (FileList owns the F2 → entry
    // mapping). Only the editing row dispatches commit/cancel.
    inlineRenameEntry,
    cancelInlineRename,
    commitInlineRename,
  } = props;
  const entry = entries[index];
  const tags = tagsByName.get(entry.path) ?? EMPTY_ARR;
  const desc = descByName.get(entry.path);

  // H.23 P1-3: scale the row's thumb/icon with the virtual-list row height so
  // compact rows (32 px) don't clip a 40 px icon and comfortable rows (72 px)
  // don't leave the icon swimming in whitespace. The header's column slot stays
  // 40 px + margin, so horizontal alignment is unaffected.
  const rowHeightPx =
    typeof style.height === 'number'
      ? style.height
      : parseInt(String(style.height), 10) || ROW_THUMB_SIZE;
  const thumbSize = Math.min(
    ROW_THUMB_SIZE,
    Math.max(24, rowHeightPx - 8)
  );

  // H.23 P1-1: render a 2px primary outline + ring when this row is the
  // keyboard-focused row, and call `.focus()` on its ListItemButton when
  // focusIndex changes to match — gives ↑↓ keyboard nav a visible cursor.
  // The ref also includes the drag/drop refs (combined below).
  const listItemRef = useRef<HTMLDivElement | null>(null);
  const isFocused = focusIndex === index;
  useEffect(() => {
    if (isFocused) {
      // DOM `.focus()` moves the actual keyboard cursor. Without it the
      // user would have a CSS-only "focus" they can't tell apart from any
      // other selected row.
      listItemRef.current?.focus({ preventScroll: true });
    }
  }, [isFocused]);

  // Drag item: either the dragged entry alone, or (if it's selected) the whole
  // current selection. Iterate the parent-pushed `selectedPaths` Set (P0-4) and
  // resolve each path through `resolveEntry` — O(k) where k = selection.size,
  // instead of the prior O(n) walk over every visible entry. Only visible
  // selected entries resolve (matches the pre-fix scope: `entries` is `visible`).
  const dragItem = useMemo<FileDragItem>(() => {
    if (selectedPaths && selectedPaths.has(entry.path)) {
      const paths: string[] = [];
      const names: string[] = [];
      selectedPaths.forEach((p) => {
        const e = resolveEntry?.(p);
        if (e) {
          paths.push(p);
          names.push(e.name);
        }
      });
      return { paths, names };
    }
    return { paths: [entry.path], names: [entry.name] };
  }, [selectedPaths, resolveEntry, entry.path, entry.name]);

  const [{ isDragging }, dragRef] = useDrag(
    () => ({
      type: DND_TYPE_FILE,
      item: dragItem,
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
      canDrag: () => !readOnly,
    }),
    [dragItem, readOnly]
  );

  // Period-tag drop: opened via context (Phase 5 / §8). We don't write the
  // period tag directly; instead the user picks a start + end date in a
  // dialog, and on confirm the dialog calls back to apply the resulting
  // `YYYYMMDD-YYYYMMDD` token.
  const { openDialog: openPeriodDialog } = usePeriodTagDialog();
  // `dropPeriodFor` remembers which entry / entries the dialog applies to.
  // (Multi-file batch not wired in this pass — single-entry only; the
  // multi-select path is documented in the plan as a follow-up.)
  const dropPeriodFor = useRef<DirEntry | null>(null);

  // Drop target for tags (always) and files (only onto folders).
  const [{ isOver, canDrop, isOverFile }, dropRef] = useDrop<
    TagDragItem | FileDragItem,
    unknown,
    { isOver: boolean; canDrop: boolean; isOverFile: boolean }
  >(
    () => ({
      accept: [DND_TYPE_TAG, DND_TYPE_FILE],
      drop: (item) => {
        if ('tag' in item) {
          // Phase 5: dropping the `period:` fold chip opens the date dialog
          // instead of immediately writing — period needs start + end.
          if (item.tag === 'period:') {
            dropPeriodFor.current = entry;
            openPeriodDialog({
              defaultStart: todayIsoLocal(),
              defaultEnd: todayIsoLocal(),
              onConfirm: (period) => {
                const target = dropPeriodFor.current;
                dropPeriodFor.current = null;
                if (target) onDropTag(target, period, undefined);
              },
            });
            return;
          }
          onDropTag(entry, item.tag, item.functionality);
        } else if (entry.isDirectory) {
          const sources = item.paths
            .map((p) => resolveEntry?.(p))
            .filter(Boolean) as DirEntry[];
          onDropFiles(entry, sources);
        }
      },
      canDrop: (item) => {
        if ('tag' in item) return true;
        // Files can only be dropped onto folders, and never onto themselves.
        return (
          entry.isDirectory &&
          !item.paths.includes(entry.path)
        );
      },
      collect: (monitor) => ({
        isOver: monitor.isOver(),
        canDrop: monitor.canDrop(),
        isOverFile:
          monitor.isOver() && (monitor.getItemType() as string) === DND_TYPE_FILE,
      }),
    }),
    // `entries` is intentionally absent — the drop spec resolves dragged
    // sources via `resolveEntry` (P0-4), so it doesn't close over the array.
    [entry, resolveEntry, onDropTag, onDropFiles]
  );

  const dropActive = (isOver && canDrop) || (isOverFile && entry.isDirectory);
  return (
    <ListItemButton
      disableRipple
      ref={(node) => {
        // Combine drag ref + drop ref + our keyboard-focus ref on the same
        // element. `listItemRef` is what `useEffect(isFocused)` calls
        // `.focus()` on.
        listItemRef.current = node;
        dragRef(node);
        dropRef(node);
      }}
      style={{
        ...style,
        opacity: isDragging ? 0.4 : undefined,
      }}
      // tabIndex + onKeyDown live on the container (FileList). Setting
      // tabIndex here makes the row focusable as a side effect, which is
      // what powers the auto-focus above.
      tabIndex={-1}
      data-focused={isFocused ? 'true' : undefined}
      onClick={(e) => {
        // Shift / Ctrl / Cmd + click selects (range or toggle); a plain click
        // selects the row so the properties tray updates. Double-click opens.
        onSelectRow(index, {
          shift: e.shiftKey,
          toggle: e.ctrlKey || e.metaKey,
        });
      }}
      onDoubleClick={() => onOpen(entry)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextEntry(entry, e.clientX, e.clientY);
      }}
      // Tooltip shows the description when present, otherwise the full file
      // name — the name column is noWrap-truncated, so hover is the only way
      // to read a long name (GridCell already does this).
      title={desc ?? entry.name}
      sx={{
        pl: 1,
        py: 0,
        boxSizing: 'border-box',
        userSelect: 'none', // stop Shift-click from highlighting row text
        // H.23 P2-1: even-indexed zebra stripe. `index % 2 === 0` paints the
        // first, third, fifth, … row with a subtle tint. We deliberately
        // do NOT paint the focus / drop-active outlines here — those
        // expressions (below) override `bgcolor` with their own `action.hover`
        // when active, so the visual hierarchy is drop > focus > zebra.
        ...(listZebra &&
          index % 2 === 0 &&
          !isFocused &&
          !dropActive && {
            bgcolor: 'action.hover',
          }),
        // H.23 P1-1: keyboard-focus outline. Sized to match the drag-active
        // outline (also 2px primary). Both can be on at once without
        // double-rendering because they're mutually-exclusive styling.
        ...(isFocused && !dropActive && {
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: -2,
          // focus row: outline only — no bgcolor tint. The previous
          // 'action.hover' background read as a stuck grey shadow on the
          // focused row; keep just the blue outline to mark keyboard focus.
        }),
        ...(dropActive && {
          bgcolor: 'action.hover',
        }),
        // Disable MUI ListItemButton's default hover / focus-visible /
        // selected / active backgrounds. Without this, the browser's
        // focus-visible / active state can stick on rows after the user moves
        // to another row (especially with virtual scrolling), leaving multiple
        // rows highlighted. We already render explicit focus + zebra states
        // above. Target MUI's root class to win specificity.
        '&.MuiListItemButton-root:hover': {
          backgroundColor: 'transparent !important',
        },
        '&.MuiListItemButton-root:active': {
          backgroundColor: 'transparent !important',
        },
        '&.MuiListItemButton-root:focus': {
          backgroundColor: 'transparent !important',
        },
        '&.MuiListItemButton-root.Mui-focusVisible': {
          backgroundColor: 'transparent !important',
          outline: 'none',
        },
        '&.MuiListItemButton-root.Mui-selected': {
          backgroundColor: 'transparent !important',
        },
        '&.MuiListItemButton-root.Mui-selected:hover': {
          backgroundColor: 'transparent !important',
        },
      }}
    >
      <Checkbox
        size="small"
        checked={isSelected(entry)}
        // H.23 P2-6: screen-reader announcement for the row's selection box.
        slotProps={{
          input: { 'aria-label': t('selectFile', { name: entry.name }) },
        }}
        onClick={(e) => {
          e.stopPropagation();
          onSelectRow(index, {
            shift: e.shiftKey,
            toggle: e.ctrlKey || e.metaKey,
          });
        }}
        sx={{ py: 0, mr: 0.5 }}
      />
      <ListItemIcon
        sx={{ minWidth: thumbSize + 8, justifyContent: 'center' }}
      >
        <ThumbIcon
          entry={entry}
          thumbCache={thumbCache}
          size={thumbSize}
        />
      </ListItemIcon>
      <ListItemText
        primary={
          // H.23 P1-4: swap the static name for an autoFocus'd TextField when
          // this row is the one being renamed. Must live in `primary` (not
          // children) because MUI ListItemText does not render children while
          // `primary` is set — the input would never mount.
          inlineRenameEntry?.path === entry.path ? (
            <InlineRenameInput
              initial={entry.name}
              onCommit={(newName) => void commitInlineRename(entry, newName)}
              onCancel={cancelInlineRename}
            />
          ) : (
            stripTagsFromName(entry.name)
          )
        }
        slotProps={{ primary: { noWrap: true, variant: 'body2' } }}
        sx={
          hiddenColumns.includes('name')
            ? { width: 0, minWidth: 0, overflow: 'hidden', p: 0 }
            : { flex: '0 1 30%', flexBasis: columnWidths.name, flexShrink: 0, minWidth: 0 }
        }
      />
      {/* inline tag chips */}
      <EntryTagChips
        entry={entry}
        tags={tags}
        activeTag={activeTag}
        tagColors={tagColors}
        groups={groups}
        max={MAX_TAGS_PER_ROW}
        t={t}
        onClickTag={onClickTag}
        onTagContextMenu={onTagContextMenu}
        containerSx={TAG_CHIPS_SX}
      />
      {!hiddenColumns.includes('size') ? (
        // H.23 P2-6: span wrapper carries an aria-label so screen readers
        // announce a human-readable size ("8.3 KB") instead of the raw text.
        <Typography
          variant="body2"
          color="text.secondary"
          component="span"
          aria-label={
            entry.isFile ? t('cellSize', { size: formatSize(entry.size) }) : undefined
          }
          sx={{
            flex: '0 0 auto',
            width: columnWidths.size,
            minWidth: 0,
            textAlign: 'right',
            flexShrink: 0,
          }}
        >
          {entry.isFile ? formatSize(entry.size) : ''}
        </Typography>
      ) : null}
      {!hiddenColumns.includes('modified') ? (
        <Typography
          variant="body2"
          color="text.secondary"
          component="span"
          aria-label={t('cellModified', {
            date: formatDate(entry.modified, {
              mode: listDateFormat,
              t,
            }),
          })}
          sx={{
            flex: '0 0 auto',
            width: columnWidths.modified,
            minWidth: 0,
            textAlign: 'right',
            flexShrink: 0,
          }}
        >
          {formatDate(entry.modified, { mode: listDateFormat, t })}
        </Typography>
      ) : null}
    </ListItemButton>
  );
}

/**
 * H.23 P1-4 inline-rename editor. Replaces the row's name slot while the
 * user is renaming. Three exit paths:
 *   - **Enter**: commits (debounced via `onCommit` -> parent `commitInlineRename`).
 *   - **Esc**:   cancels via `onCancel` -> parent clears `inlineRenameEntry`.
 *   - **Blur**:  commits the same way as Enter (clicking elsewhere / clicking
 *               another row should not silently discard the new name).
 *
 * Autofocus + select-on-mount lets the user type to overwrite immediately.
 * `stopPropagation` on click + keydown prevents the underlying
 * `ListItemButton`'s onClick / onKeyDown from interpreting the same events
 * (e.g. selecting the row, opening the entry on Enter).
 */
function InlineRenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (newName: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      // Select the full filename so typing replaces it (Explorer-style).
      // setSelectionRange can throw if input isn't yet visible; guarded by
      // requestAnimationFrame to defer to the next paint.
      requestAnimationFrame(() => {
        try {
          el.setSelectionRange(0, el.value.length);
        } catch {
          /* ignore */
        }
      });
    }
    // `initial` is the seed; we never want to re-fire focus / select when
    // parent re-renders with a new value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <TextField
      inputRef={inputRef}
      size="small"
      variant="standard"
      value={value}
      autoFocus
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      // Blur commits: clicking another row or pressing Tab should not lose
      // edits. `onBlur` fires before unmount so the value is preserved.
      onBlur={() => onCommit(value)}
      sx={{
        width: '100%',
        '& .MuiInputBase-input': {
          fontSize: 'inherit',
          padding: '2px 4px',
        },
      }}
    />
  );
}
