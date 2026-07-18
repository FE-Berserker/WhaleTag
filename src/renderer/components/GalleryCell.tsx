import type { CellComponentProps } from 'react-window';
import { useRef } from 'react';
import { useDrop } from 'react-dnd';
import {
  Box,
  Checkbox,
  ImageListItemBar,
  Tooltip,
} from '@mui/material';
import { useTranslation } from 'react-i18next';

import type { DirEntry } from '../../shared/ipc-types';
import type { TagGroup } from '../domain/tag-library';
import { ratingOfTag } from '../../shared/smart-tags';
import { getTagColor } from '../domain/tag-colors';
import { DND_TYPE_TAG, type TagDragItem } from '../services/dnd';
import { tagDisplayLabel } from '../services/tag-display';
import { usePeriodTagDialog } from './PeriodTagDialog';
import ThumbIcon from './ThumbIcon';

/** Local `YYYY-MM-DD` for "today" — used as the default for the period
 *  drop dialog. See Row.tsx / GridCell.tsx for the same helper; small
 *  enough to inline. */
function todayIsoLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const TILE_TAG_MAX = 2;

export interface GalleryCellData {
  /** The current visible (post tag-filter), sorted media entries. */
  entries: DirEntry[];
  /** Columns currently laid out (derived from container width / entrySize). */
  columnCount: number;
  /** Gallery tile edge length (px) — drives the thumbnail size. */
  entrySize: number;
  /** Thumbnail data-URL cache (`${path}|${modified}` -> url); see ThumbIcon. */
  thumbCache: Map<string, string>;
  tagsByName: Map<string, string[]>;
  tagColors: Record<string, string>;
  /** Tag groups — for three-tier color fallback (getTagColor). */
  groups: TagGroup[];
  /** Currently selected entry paths. */
  selected: Set<string>;
  /**
   * Select-gesture on a tile: plain selects one, `toggle` (Ctrl/Cmd) toggles,
   * `shift` extends the range from the anchor (handled by FileList).
   */
  onSelect?: (entry: DirEntry, mods: { shift: boolean; toggle: boolean }) => void;
  onOpen?: (entry: DirEntry) => void;
  /** Drop a tag chip onto the tile (single entry or batch when multi-selected). */
  onDropTag?: (entry: DirEntry, tag: string, functionality?: string) => void;
  /** When true, tile-level write actions are disabled. */
  readOnly?: boolean;
  /** When false, hide the tag/rating overlay chips for a clean thumbnail view. */
  showTags?: boolean;
  /** Index of the tile currently focused via keyboard nav. */
  focusIndex: number;
  /** Move keyboard focus to `index`. */
  onFocus: (index: number) => void;
}

/**
 * One media tile inside the virtualized Gallery grid. Mirrors the contract of
 * `GridCell`: map (rowIndex, columnIndex) to a linear entry index, render empty
 * for trailing cells, and reuse the same selection / tagging gestures as the
 * rest of the perspectives.
 */
export default function GalleryCell({
  rowIndex,
  columnIndex,
  style,
  entries,
  columnCount,
  entrySize,
  thumbCache,
  tagsByName,
  tagColors,
  groups,
  selected,
  onSelect,
  onOpen,
  onDropTag,
  readOnly,
  showTags = true,
  focusIndex,
  onFocus,
}: CellComponentProps<GalleryCellData>) {
  const index = rowIndex * columnCount + columnIndex;
  const entry = entries[index];
  if (!entry) return <div style={style} />;

  // Tag-only drop target. Dependency discipline mirrors GridCell / Row:
  // Period-tag drop: opened via context (Phase 5 / §8). Mirrors the same
  // pattern as Row.tsx / GridCell.tsx — the dialog collects a start + end
  // date, on confirm we apply the resulting `YYYYMMDD-YYYYMMDD` token via
  // the regular `onDropTag` path. Without this branch, dropping `period:`
  // would write the literal string `'period:'` to sidecar (broken).
  //
  // Multi-select: when the drop target is selected and the selection
  // contains more than one tile, we open ONE dialog and apply the same
  // `YYYYMMDD-YYYYMMDD` to every selected entry (matches the existing
  // batch rule for ordinary smart-tag drops below).
  const { openDialog: openPeriodDialog } = usePeriodTagDialog();
  const dropPeriodFor = useRef<DirEntry[] | null>(null);

  // `targetPath` is a primitive, handlers are stable callbacks from the parent.
  const targetPath = entry.path;
  const [{ isOver, canDrop }, dropRef] = useDrop<
    TagDragItem,
    unknown,
    { isOver: boolean; canDrop: boolean }
  >(
    () => ({
      accept: [DND_TYPE_TAG],
      canDrop: () => !readOnly,
      drop: (item) => {
        if (!onDropTag) return;
        // Period branch — open the date dialog first, then apply.
        if (item.tag === 'period:') {
          const targets =
            selected.has(entry.path) && selected.size > 1
              ? entries.filter((e) => selected.has(e.path))
              : [entry];
          dropPeriodFor.current = targets;
          openPeriodDialog({
            defaultStart: todayIsoLocal(),
            defaultEnd: todayIsoLocal(),
            onConfirm: (period) => {
              const t = dropPeriodFor.current;
              dropPeriodFor.current = null;
              if (t) for (const target of t) onDropTag(target, period, undefined);
            },
          });
          return;
        }
        // Batch rule: dropping on a selected tile tags every selected media entry.
        if (selected.has(entry.path) && selected.size > 1) {
          const targets = entries.filter((e) => selected.has(e.path));
          for (const target of targets) {
            onDropTag(target, item.tag, item.functionality);
          }
        } else {
          onDropTag(entry, item.tag, item.functionality);
        }
      },
      collect: (monitor) => ({
        isOver: monitor.isOver(),
        canDrop: monitor.canDrop(),
      }),
    }),
    [targetPath, onDropTag, readOnly, entries, selected]
  );

  const dropActive = isOver && canDrop;
  const isSelected = selected.has(entry.path);
  const isFocused = index === focusIndex;

  const tags = tagsByName.get(entry.path) ?? [];
  const hasRating = tags.some((tag) => ratingOfTag(tag) !== null);
  const showTagOverlay = showTags && (tags.length > 0 || hasRating);

  return (
    <div style={style}>
      <Box
        ref={(node: HTMLDivElement | null) => {
          dropRef(node);
        }}
        data-testid="gallery-tile"
        tabIndex={-1}
        onClick={(e) => {
          onFocus(index);
          onSelect?.(entry, {
            shift: e.shiftKey,
            toggle: e.ctrlKey || e.metaKey,
          });
        }}
        onDoubleClick={() => onOpen?.(entry)}
        sx={{
          position: 'relative',
          width: '100%',
          height: '100%',
          cursor: 'pointer',
          borderRadius: 1,
          overflow: 'hidden',
          bgcolor: dropActive
            ? 'action.selected'
            : isSelected
              ? 'action.selected'
              : 'action.hover',
          outline: dropActive || isSelected || isFocused ? 3 : 0,
          outlineColor: dropActive
            ? 'primary.main'
            : isSelected
              ? 'primary.main'
              : 'rgba(25,118,210,0.6)',
          outlineStyle: dropActive ? 'dashed' : isSelected ? 'solid' : 'dashed',
          outlineOffset: isSelected ? 0 : -2,
          '&:hover': { opacity: isSelected ? 1 : 0.9 },
        }}
      >
        <Box
          sx={{
            width: '100%',
            height: entrySize,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
          }}
        >
          <ThumbIcon
            entry={entry}
            thumbCache={thumbCache}
            size={entrySize}
            rounded={0}
          />
          <Checkbox
            className="gallery-cell-checkbox"
            size="small"
            checked={isSelected}
            onClick={(e) => {
              e.stopPropagation();
              onSelect?.(entry, {
                shift: e.shiftKey,
                toggle: e.ctrlKey || e.metaKey,
              });
            }}
            sx={{
              position: 'absolute',
              top: 4,
              right: 4,
              p: 0.25,
              bgcolor: 'background.paper',
              borderRadius: 1,
              boxShadow: 1,
              opacity: isSelected ? 1 : 0,
              transition: 'opacity 120ms',
              '&:hover': { opacity: 1 },
              '[data-testid="gallery-tile"]:hover &': { opacity: 1 },
            }}
          />
          {showTagOverlay && (
            <TileTagOverlay
              data-testid="tile-tag-overlay"
              tags={tags}
              tagColors={tagColors}
              groups={groups}
            />
          )}
        </Box>
        <ImageListItemBar
          title={entry.name}
          sx={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            background:
              'linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.3) 70%, transparent 100%)',
          }}
        />
      </Box>
    </div>
  );
}

/**
 * Compact badge layered on top of the tile thumbnail.
 */
function TileTagOverlay({
  'data-testid': dataTestid,
  tags,
  tagColors,
  groups,
}: {
  'data-testid'?: string;
  tags: string[];
  tagColors: Record<string, string>;
  groups: TagGroup[];
}) {
  const { t } = useTranslation();

  const rating = tags.reduce<number | null>(
    (acc, tag) => acc ?? ratingOfTag(tag),
    null
  );
  const nonRatingTags = tags.filter((tag) => ratingOfTag(tag) === null);
  const shown = nonRatingTags.slice(0, TILE_TAG_MAX);
  const overflow = nonRatingTags.length - shown.length;
  const hasContent = rating !== null || shown.length > 0 || overflow > 0;
  if (!hasContent) return null;

  const tooltipText = tags.map((tag) => tagDisplayLabel(tag, t)).join(' · ');

  return (
    <Tooltip title={tooltipText} placement="top" arrow enterDelay={300}>
      <Box
        data-testid={dataTestid}
        sx={{
          position: 'absolute',
          top: 4,
          left: 4,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 0.25,
          padding: '2px 4px',
          borderRadius: 0.5,
          backgroundColor: 'rgba(0, 0, 0, 0.45)',
          maxWidth: '90%',
          pointerEvents: 'none',
        }}
      >
        {rating !== null && (
          <Box
            component="span"
            sx={{
              color: '#ffcc24',
              fontSize: 14,
              lineHeight: 1,
              letterSpacing: '-0.05em',
            }}
          >
            {'★'.repeat(rating)}
          </Box>
        )}
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.25 }}>
          {shown.map((tag) => {
            const color = getTagColor(tag, tagColors, groups);
            return (
              <Box
                key={tag}
                component="span"
                sx={{
                  fontSize: 10,
                  lineHeight: 1.2,
                  padding: '1px 4px',
                  borderRadius: 0.5,
                  backgroundColor: color ?? 'rgba(255,255,255,0.18)',
                  color: 'common.white',
                  whiteSpace: 'nowrap',
                  textShadow: '0 0 2px rgba(0,0,0,0.6)',
                }}
              >
                {tagDisplayLabel(tag, t)}
              </Box>
            );
          })}
          {overflow > 0 && (
            <Box
              component="span"
              sx={{
                fontSize: 10,
                lineHeight: 1.2,
                padding: '1px 4px',
                borderRadius: 0.5,
                backgroundColor: 'rgba(255,255,255,0.18)',
                color: 'common.white',
              }}
            >
              +{overflow}
            </Box>
          )}
        </Box>
      </Box>
    </Tooltip>
  );
}
