import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  Checkbox,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  type SxProps,
  type Theme,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import SortIcon from '@mui/icons-material/Sort';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import RemoveIcon from '@mui/icons-material/Remove';
import AddIcon from '@mui/icons-material/Add';
import ViewListIcon from '@mui/icons-material/ViewList';
import GridViewIcon from '@mui/icons-material/GridView';
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary';
// H.29: Kanban / Matrix are no longer top-level perspectives — they live
// inside the `'task'` perspective as a sub-switch, so their toolbar icons
// (`ViewKanbanIcon` / `WindowIcon`) moved out of the header. `AssignmentIcon`
// is the single Task perspective icon (the in-view SegmentedButton owns the
// Kanban vs. Matrix glyph).
import AssignmentIcon from '@mui/icons-material/Assignment';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import MapIcon from '@mui/icons-material/Map';
import CloudIcon from '@mui/icons-material/Cloud';
import HubIcon from '@mui/icons-material/Hub';
import DensitySmall from '@mui/icons-material/DensitySmall';
import DensityMedium from '@mui/icons-material/DensityMedium';
import DensityLarge from '@mui/icons-material/DensityLarge';
import BorderHorizontalIcon from '@mui/icons-material/BorderHorizontal';
import ScheduleIcon from '@mui/icons-material/Schedule';
import LabelIcon from '@mui/icons-material/Label';
import LabelOffIcon from '@mui/icons-material/LabelOff';

import type { ViewMode } from '../../shared/whale-meta';
import type { SortState, SortKey } from '-/hooks/DirectoryContentContextProvider';
import type { ListRowDensity } from '-/reducers/settings';

export interface FileListHeaderProps {
  // —— Sort ——
  sort: SortState;
  /** Called with the same shape used to update the context. The component
   *  internally implements toggle-dir on the same key. H.23 P1-2: this same
   *  pair is also pushed down into `RowColumnLabels`, where each sortable
   *  column header is its own `<Button>` that toggles direction on a
   *  second click. The auxiliary `Sort` menu at the top of the toolbar
   *  (and its `changeSort` reducer-equivalent below) keeps working as a
   *  fallback entry point for keyboard / a11y users. */
  setSort: (next: SortState) => void;
  /** List of sortable keys; rendered in the sort menu in this order. */
  sortKeys: readonly SortKey[];
  // —— View toggle ——
  viewMode: ViewMode;
  setViewMode: (m: ViewMode) => void;
  // —— Zoom (grid + gallery only) ——
  entrySize: number;
  setEntrySize: (n: number) => void;
  minEntrySize: number;
  maxEntrySize: number;
  entrySizeStep: number;
  // —— H.23 P1-3: list-row density preset. Drives row height via the
  // `rowHeightFromDensity` helper in FileList. Only the list view consumes
  // the change — grid / gallery keep their own sizing — so FileListHeader
  // renders the toggle inside the existing toolbar near the view toggle. ——
  listRowDensity: ListRowDensity;
  onChangeListRowDensity: (d: ListRowDensity) => void;
  // —— Selection ——
  selectedCount: number;
  onClearSelection: () => void;
  // —— List-column header (consumed by `RowColumnLabels`) ——
  listSelectAllState: 'checked' | 'indeterminate' | 'unchecked';
  onToggleSelectAll: () => void;
  /** Number of visible rows (drives the select-all disabled state). */
  visibleCount: number;
  rowThumbSize: number;
  /** Pre-translated column header captions. The caller applies i18n so this
   *  file stays free of any text-formatting policy. */
  columnLabels: {
    name: string;
    tags: string;
    size: string;
    modified: string;
  };
  // —— H.23 P1-5: column-width + visibility plumbing. Pushed into
  // `RowColumnLabels`. The header's resize handle calls `setColumnWidth`
  // with a clamped px value; the right-click menu calls `toggleColumn`
  // with a column id. ——
  columnWidths: { name: number; size: number; modified: number };
  hiddenColumns: readonly string[];
  setColumnWidth: (columnId: 'name' | 'size' | 'modified', widthPx: number) => void;
  toggleColumn: (columnId: string) => void;
  // —— H.23 P2-1 zebra striping toggle. Top-bar IconButton flips a single
  // boolean; the actual styling happens in Row.sx based on `cellData.listZebra`. ——
  listZebra: boolean;
  onToggleListZebra: () => void;
  // —— H.23 P2-3 date format toggle (absolute / relative). ——
  listDateFormat: 'absolute' | 'relative';
  onToggleListDateFormat: () => void;
  // —— Gallery tag overlay toggle. ——
  galleryShowTags: boolean;
  onToggleGalleryShowTags: () => void;
}

/**
 * Sticky top toolbar: clear-selection, sort dropdown, view toggle, zoom, and
 * the selected-count display. Everything is purely presentational — the
 * caller owns all state and provides handlers.
 *
 * H.23 P0-1: extracted from FileList.tsx. The component holds exactly one
 * piece of UI state (`sortAnchor`) for the menu's anchor element; selection /
 * sort / view / zoom all live in the parent.
 */
export default function FileListHeader(props: FileListHeaderProps) {
  const {
    sort,
    setSort,
    sortKeys,
    viewMode,
    setViewMode,
    entrySize,
    setEntrySize,
    minEntrySize,
    maxEntrySize,
    entrySizeStep,
    listRowDensity,
    onChangeListRowDensity,
    listZebra,
    onToggleListZebra,
    listDateFormat,
    onToggleListDateFormat,
    galleryShowTags,
    onToggleGalleryShowTags,
    selectedCount,
    onClearSelection,
  } = props;
  const { t } = useTranslation();
  const [sortAnchor, setSortAnchor] = useState<HTMLElement | null>(null);

  const closeSortMenu = useCallback(() => {
    setSortAnchor(null);
    // MUI Menu restores focus to the anchor button on close, which leaves the
    // button stuck in a visible focus/active state. Defer blurring so it runs
    // after MUI's focus restoration.
    requestAnimationFrame(() => {
      sortAnchor?.blur();
    });
  }, [sortAnchor]);

  const changeSort = (key: SortKey) => {
    const dir: SortState['dir'] =
      sort.key === key && sort.dir === 'asc' ? 'desc' : 'asc';
    setSort({ key, dir });
  };

  return (
    <Stack
      direction="row"
      sx={{
        px: 2,
        py: 0.5,
        borderBottom: 1,
        borderColor: 'divider',
        position: 'sticky',
        top: 0,
        bgcolor: 'background.paper',
        zIndex: 1,
        alignItems: 'center',
        gap: 1,
      }}
    >
      <Box sx={{ width: 42 }}>
        {selectedCount > 0 ? (
          <Tooltip title={t('clearSelection')}>
            <IconButton size="small" onClick={onClearSelection}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null}
      </Box>

      {/* Unified sort control (field dropdown + direction), shared by both
          views. Hidden for TagCloud + KnowledgeGraph: those views don't render
          file rows at all (they visualize tags / tag↔file relations), so a
          name/size/modified sort is meaningless. The column-header sort
          buttons in `RowColumnLabels` are already gated by `viewMode === 'list'`
          at the call site, so this is the only Sort entry point that needs an
          explicit viewMode guard here. */}
      {viewMode !== 'tagcloud' && viewMode !== 'knowledge-graph' ? (
        <>
          <Button
            size="small"
            color="inherit"
            startIcon={<SortIcon fontSize="small" />}
            endIcon={
              sort.dir === 'asc' ? (
                <ArrowUpwardIcon fontSize="small" />
              ) : (
                <ArrowDownwardIcon fontSize="small" />
              )
            }
            onClick={(e) => setSortAnchor(e.currentTarget)}
            sx={{ textTransform: 'none' }}
          >
            {t(sort.key)}
          </Button>
          <Menu
            open={sortAnchor !== null}
            anchorEl={sortAnchor}
            onClose={closeSortMenu}
          >
            {sortKeys.map((key) => (
              <MenuItem
                key={key}
                selected={sort.key === key}
                onClick={() => {
                  changeSort(key);
                  closeSortMenu();
                }}
              >
                <ListItemText>{t(key)}</ListItemText>
                {sort.key === key ? (
                  <ListItemIcon sx={{ ml: 1, minWidth: 0 }}>
                    {sort.dir === 'asc' ? (
                      <ArrowUpwardIcon fontSize="small" />
                    ) : (
                      <ArrowDownwardIcon fontSize="small" />
                    )}
                  </ListItemIcon>
                ) : null}
              </MenuItem>
            ))}
          </Menu>
        </>
      ) : null}

      <Box sx={{ flex: 1 }} />

      {/* Cell-size zoom (grid + gallery views). */}
      {viewMode === 'grid' || viewMode === 'gallery' ? (
        <>
          <Tooltip title={t('zoomOut')}>
            <span>
              <IconButton
                size="small"
                disabled={entrySize <= minEntrySize}
                onClick={() =>
                  setEntrySize(
                    Math.max(minEntrySize, entrySize - entrySizeStep)
                  )
                }
              >
                <RemoveIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={t('zoomIn')}>
            <span>
              <IconButton
                size="small"
                disabled={entrySize >= maxEntrySize}
                onClick={() =>
                  setEntrySize(
                    Math.min(maxEntrySize, entrySize + entrySizeStep)
                  )
                }
              >
                <AddIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </>
      ) : null}

      {/* Gallery tag overlay toggle. */}
      {viewMode === 'gallery' ? (
        <Tooltip title={t(galleryShowTags ? 'hideGalleryTags' : 'showGalleryTags')}>
          <IconButton
            size="small"
            color={galleryShowTags ? 'primary' : 'default'}
            onClick={onToggleGalleryShowTags}
            aria-label={t(galleryShowTags ? 'hideGalleryTags' : 'showGalleryTags')}
            aria-pressed={galleryShowTags}
          >
            {galleryShowTags ? (
              <LabelIcon fontSize="small" />
            ) : (
              <LabelOffIcon fontSize="small" />
            )}
          </IconButton>
        </Tooltip>
      ) : null}

      {/* H.23 P1-3: list-row density (compact / normal / comfortable).
          Renders only for the list view — grid / gallery have their own
          cell sizing via `entrySize`. A 3-state ToggleButtonGroup lets the
          user pick row height 32 / 56 / 72 px; the actual height comes from
          `rowHeightFromDensity` in FileList. */}
      {viewMode === 'list' ? (
        <Tooltip title={t('listRowDensity')}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={listRowDensity}
            onChange={(_e, d: 'compact' | 'normal' | 'comfortable' | null) => {
              // MUI passes `null` when the active toggle is clicked again;
              // we keep the current selection in that case (no clear).
              if (d) onChangeListRowDensity(d);
            }}
            sx={{ '& .MuiToggleButton-root': { px: 0.75, py: 0.125 } }}
          >
            <ToggleButton value="compact" aria-label={t('densityCompact')}>
              <DensitySmall fontSize="small" />
            </ToggleButton>
            <ToggleButton value="normal" aria-label={t('densityNormal')}>
              <DensityMedium fontSize="small" />
            </ToggleButton>
            <ToggleButton
              value="comfortable"
              aria-label={t('densityComfortable')}
            >
              <DensityLarge fontSize="small" />
            </ToggleButton>
          </ToggleButtonGroup>
        </Tooltip>
      ) : null}

      {/* H.23 P2-1: zebra-stripe toggle. List-only (grid has its own card
          rendering, not a per-row tint). Single IconButton that flips a
          boolean; visual style lives in Row.sx. */}
      {viewMode === 'list' ? (
        <Tooltip title={t('listZebra')}>
          <IconButton
            size="small"
            color={listZebra ? 'primary' : 'default'}
            onClick={onToggleListZebra}
            aria-label={t('listZebra')}
            aria-pressed={listZebra}
          >
            <BorderHorizontalIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      ) : null}

      {/* H.23 P2-3: relative-time toggle. List-only (grid / map etc.
          don't show a modified column). One IconButton; visual = primary
          color when 'relative' is active. */}
      {viewMode === 'list' ? (
        <Tooltip title={t('listDateFormat')}>
          <IconButton
            size="small"
            color={listDateFormat === 'relative' ? 'primary' : 'default'}
            onClick={onToggleListDateFormat}
            aria-label={t('listDateFormat')}
            aria-pressed={listDateFormat === 'relative'}
          >
            <ScheduleIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      ) : null}

      {/* View toggle: list vs grid. */}
      <ToggleButtonGroup
        size="small"
        exclusive
        value={viewMode}
        onChange={(_e, mode: ViewMode | null) => {
          if (mode) setViewMode(mode);
        }}
      >
        <ToggleButton value="list" sx={{ px: 1, py: 0.25 }}>
          <Tooltip title={t('viewList')}>
            <ViewListIcon fontSize="small" />
          </Tooltip>
        </ToggleButton>
        <ToggleButton value="grid" sx={{ px: 1, py: 0.25 }}>
          <Tooltip title={t('viewGrid')}>
            <GridViewIcon fontSize="small" />
          </Tooltip>
        </ToggleButton>
        <ToggleButton value="gallery" sx={{ px: 1, py: 0.25 }}>
          <Tooltip title={t('viewGallery')}>
            <PhotoLibraryIcon fontSize="small" />
          </Tooltip>
        </ToggleButton>
        <ToggleButton value="task" sx={{ px: 1, py: 0.25 }}>
          <Tooltip title={t('viewTask')}>
            <AssignmentIcon fontSize="small" />
          </Tooltip>
        </ToggleButton>
        <ToggleButton value="calendar" sx={{ px: 1, py: 0.25 }}>
          <Tooltip title={t('viewCalendar')}>
            <CalendarMonthIcon fontSize="small" />
          </Tooltip>
        </ToggleButton>
        <ToggleButton value="folderviz" sx={{ px: 1, py: 0.25 }}>
          <Tooltip title={t('viewFolderViz')}>
            <AccountTreeIcon fontSize="small" />
          </Tooltip>
        </ToggleButton>
        <ToggleButton value="mapique" sx={{ px: 1, py: 0.25 }}>
          <Tooltip title={t('viewMapique')}>
            <MapIcon fontSize="small" />
          </Tooltip>
        </ToggleButton>
        <ToggleButton value="tagcloud" sx={{ px: 1, py: 0.25 }}>
          <Tooltip title={t('viewTagCloud')}>
            <CloudIcon fontSize="small" />
          </Tooltip>
        </ToggleButton>
        <ToggleButton value="knowledge-graph" sx={{ px: 1, py: 0.25 }}>
          <Tooltip title={t('viewKnowledgeGraph')}>
            <HubIcon fontSize="small" />
          </Tooltip>
        </ToggleButton>
      </ToggleButtonGroup>

      {selectedCount > 0 ? (
        <Box sx={{ minWidth: 132, display: 'flex', justifyContent: 'flex-end' }}>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ alignSelf: 'center', mr: 1 }}
          >
            {t('nSelected', { count: selectedCount })}
          </Typography>
        </Box>
      ) : null}
    </Stack>
  );
}

/**
 * List-view column header: tri-state select-all checkbox + 5 column captions.
 * Mirrors the Row layout (pl: 1 + checkbox + thumb + name + tags + size +
 * modified) so labels align with row content.
 *
 * H.23 P0-1: extracted from FileList.tsx (was inline above the VirtualList).
 * Lives in FileListHeader.tsx because it's part of the same presentational
 * header stack.
 */
export function RowColumnLabels(props: {
  selectAllState: 'checked' | 'indeterminate' | 'unchecked';
  onToggleSelectAll: () => void;
  disabled: boolean;
  thumbSize: number;
  labels: { name: string; tags: string; size: string; modified: string };
  sort: SortState;
  setSort: (next: SortState) => void;
  // H.23 P1-5 column plumbing.
  columnWidths: { name: number; size: number; modified: number };
  hiddenColumns: readonly string[];
  setColumnWidth: (
    columnId: 'name' | 'size' | 'modified',
    widthPx: number
  ) => void;
  toggleColumn: (columnId: string) => void;
}) {
  const { t } = useTranslation();
  const {
    selectAllState,
    onToggleSelectAll,
    disabled,
    thumbSize,
    labels,
    sort,
    setSort,
    columnWidths,
    hiddenColumns,
    setColumnWidth,
    toggleColumn,
  } = props;

  // H.23 P1-5: drag-state for in-place column resize. Tracks which column
  // is being dragged + the initial mouse x + the initial column width so
  // mousemove can compute a delta and call setColumnWidth with a new px.
  // `cursor: col-resize` is applied to the document body during drag for
  // visual feedback; reset on mouseup.
  const dragStateRef = useRef<{
    columnKey: 'name' | 'size' | 'modified';
    startX: number;
    startWidth: number;
  } | null>(null);
  // Right-click menu anchor (column-visibility toggle menu). null = closed.
  const [menuAnchor, setMenuAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);

  // H.23 P1-2: build a sortable-column Button on the fly. Clicking sets the
  // active key; clicking the active key again flips `dir` (asc ↔ desc).
  // Tags column is intentionally absent here — there's no `tags` SortKey.
  const SortableHeader = ({
    columnKey,
    label,
    sx,
  }: {
    columnKey: SortKey;
    label: string;
    sx?: SxProps<Theme>;
  }) => {
    const active = sort.key === columnKey;
    const nextDir = active
      ? sort.dir === 'asc'
        ? 'desc'
        : 'asc'
      : 'asc';
    return (
      <Button
        size="small"
        variant="text"
        disableRipple
        onClick={() => setSort({ key: columnKey, dir: nextDir })}
        endIcon={
          active ? (
            sort.dir === 'asc' ? (
              <ArrowUpwardIcon fontSize="small" />
            ) : (
              <ArrowDownwardIcon fontSize="small" />
            )
          ) : undefined
        }
        sx={{
          minWidth: 0,
          px: 0.5,
          color: active ? 'primary.main' : 'text.primary',
          fontWeight: 600,
          fontSize: 'caption.fontSize',
          textTransform: 'none',
          justifyContent: 'flex-start',
          ...sx,
        }}
        aria-label={`${t('sortBy')} ${label}`}
      >
        {label}
      </Button>
    );
  };
  // H.23 P1-5: column resize handle. 6px wide invisible-by-default strip on
  // the right edge of a sortable column header. On mousedown, capture the
  // initial x + initial width + column id into `dragStateRef`, attach
  // document-level mousemove + mouseup, and on every mousemove call
  // `setColumnWidth(columnId, startWidth + dxPx)`. Bounds (min/max) are
  // applied at the call site (FileList's wrapper), not here.
  const onResizeMouseDown =
    (columnKey: 'name' | 'size' | 'modified') =>
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragStateRef.current = {
        columnKey,
        startX: e.clientX,
        startWidth: columnWidths[columnKey],
      };
      const onMove = (ev: MouseEvent) => {
        const s = dragStateRef.current;
        if (!s) return;
        setColumnWidth(s.columnKey, s.startWidth + (ev.clientX - s.startX));
      };
      const onUp = () => {
        dragStateRef.current = null;
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.body.style.cursor = 'col-resize';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };

  // H.23 P1-5: render one resize strip on the right of each sortable
  // column. Hot zone is `position: absolute; right: 0; width: 6px; height: 100%`
  // inside a `position: relative` parent (the column Box). On hover we set
  // cursor: col-resize for visual feedback.
  const ResizeHandle = ({
    columnKey,
  }: {
    columnKey: 'name' | 'size' | 'modified';
  }) => (
    <Box
      onMouseDown={onResizeMouseDown(columnKey)}
      sx={{
        position: 'absolute',
        right: 0,
        top: 0,
        bottom: 0,
        width: 6,
        cursor: 'col-resize',
        zIndex: 1,
        // Tiny invisible hit zone for the resize gesture; visible only on hover.
        '&:hover': { backgroundColor: 'action.hover' },
      }}
      aria-label={t('columnResizeHandle', { column: columnKey })}
    />
  );

  // Right-click anywhere on the header bar opens a visibility-toggle menu.
  // Clicking outside or selecting close it.
  const onHeaderContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuAnchor({ x: e.clientX, y: e.clientY });
  };
  const closeMenu = () => setMenuAnchor(null);

  return (
    <Stack
      direction="row"
      onContextMenu={onHeaderContextMenu}
      sx={{
        alignItems: 'center',
        px: 1,
        py: 0.25,
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: 'background.default',
        userSelect: 'none',
      }}
    >
      <Checkbox
        size="small"
        checked={selectAllState === 'checked'}
        indeterminate={selectAllState === 'indeterminate'}
        onChange={onToggleSelectAll}
        disabled={disabled}
        slotProps={{ input: { 'aria-label': t('selectAll') } }}
        sx={{ py: 0, mr: 0.5 }}
      />
      <Box sx={{ minWidth: thumbSize + 8 }} />
      {/* H.23 P2-6: each column header carries role="columnheader" so
          screen readers + axe-core can verify the table-like structure. */}
      <Box
        role="columnheader"
        sx={{
          position: 'relative',
          flex: '0 1 30%',
          flexBasis: columnWidths.name,
          flexShrink: 0,
          minWidth: 0,
        }}
      >
        <SortableHeader
          columnKey="name"
          label={labels.name}
          sx={{ flex: 1, minWidth: 0, pl: 0.5 }}
        />
        <ResizeHandle columnKey="name" />
      </Box>
      <Typography
        role="columnheader"
        variant="caption"
        sx={{ flex: 1, fontWeight: 600, pl: 0.5 }}
      >
        {labels.tags}
      </Typography>
      {!hiddenColumns.includes('size') ? (
        <Box
          role="columnheader"
          sx={{
            position: 'relative',
            flex: '0 0 auto',
            width: columnWidths.size,
            minWidth: 0,
            flexShrink: 0,
          }}
        >
          <SortableHeader
            columnKey="size"
            label={labels.size}
            sx={{ flex: 1, minWidth: 0, justifyContent: 'flex-end' }}
          />
          <ResizeHandle columnKey="size" />
        </Box>
      ) : null}
      {!hiddenColumns.includes('modified') ? (
        <Box
          role="columnheader"
          sx={{
            position: 'relative',
            flex: '0 0 auto',
            width: columnWidths.modified,
            minWidth: 0,
            flexShrink: 0,
          }}
        >
          <SortableHeader
            columnKey="modified"
            label={labels.modified}
            sx={{ flex: 1, minWidth: 0, justifyContent: 'flex-end' }}
          />
          <ResizeHandle columnKey="modified" />
        </Box>
      ) : null}
      {/* H.23 P1-5: column-visibility menu (right-click anywhere on the
          header strip opens this). Items are checkboxes — clicking toggles
          `hiddenColumns` via `toggleColumn`. The `tags` column is the only
          one that *cannot* be hidden (it's the only `flex: 1` column and
          removing it would leave the layout broken); we render its entry
          disabled with a tooltip instead. */}
      <Menu
        open={menuAnchor !== null}
        onClose={closeMenu}
        anchorReference="anchorPosition"
        anchorPosition={
          menuAnchor ? { top: menuAnchor.y, left: menuAnchor.x } : undefined
        }
      >
        {(['name', 'tags', 'size', 'modified'] as const).map((cid) => {
          const isTags = cid === 'tags';
          const hidden = hiddenColumns.includes(cid);
          return (
            <MenuItem
              key={cid}
              disabled={isTags}
              onClick={() => {
                if (!isTags) toggleColumn(cid);
                closeMenu();
              }}
            >
              <Checkbox
                size="small"
                checked={isTags || !hidden}
                disabled={isTags}
                onClick={(e) => e.stopPropagation()}
                onChange={() => {
                  if (!isTags) toggleColumn(cid);
                }}
              />
              <ListItemText>{labels[cid]}</ListItemText>
            </MenuItem>
          );
        })}
      </Menu>
    </Stack>
  );
}
