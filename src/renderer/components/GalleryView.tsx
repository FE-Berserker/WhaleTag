import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Typography } from '@mui/material';
import {
  Grid as VirtualGrid,
  type GridImperativeAPI,
} from 'react-window';

import type { DirEntry } from '../../shared/ipc-types';
import type { TagGroup } from '../domain/tag-library';
import { mediaPlaylist } from '../domain/gallery';
import GalleryCell from './GalleryCell';

// Stable fallbacks: GalleryCellData requires both containers, but FileList may
// pass them as undefined while tags are still loading. Reusing module-level
// singletons also keeps the per-cell memo comparison stable across renders.
const EMPTY_TAG_MAP = new Map<string, string[]>();
const EMPTY_TAG_COLORS: Record<string, string> = {};
const EMPTY_TAG_GROUPS: TagGroup[] = [];
interface GalleryViewProps {
  entries: DirEntry[];
  thumbCache: Map<string, string>;
  entrySize: number;
  selected?: Set<string>;
  /**
   * Modifier-aware select callback so FileList can apply the same multi-select
   * semantics as list/grid (Ctrl/Cmd toggles single, Shift extends from anchor).
   */
  onSelect?: (entry: DirEntry, mods: { shift: boolean; toggle: boolean }) => void;
  onOpen?: (entry: DirEntry) => void;
  tagsByName?: Map<string, string[]>;
  tagColors?: Record<string, string>;
  groups?: TagGroup[];
  onDropTag?: (
    entry: DirEntry,
    tag: string,
    functionality?: string,
    targets?: readonly DirEntry[]
  ) => void;
  /** Right-click a tile → the generic entry context menu (same as list/grid).
   *  Without this the event bubbles to FileList's blank-area handler and the
   *  user gets the "new folder/file" background menu for a real file. */
  onContextEntry?: (entry: DirEntry, x: number, y: number) => void;
  readOnly?: boolean;
  /** Show tag/rating overlay chips on tiles. Defaults to true. */
  showTags?: boolean;
}

/**
 * Gallery perspective: a virtualized grid of image/video thumbnails. Only media
 * files are shown. Clicking selects, double-clicking opens the shared lightbox.
 *
 * Previously this view rendered all media tiles with MUI `<ImageList>.map()`,
 * which collapsed under directories with 1000+ images. Now it uses react-window
 * `<VirtualGrid>` and only mounts the visible window of tiles (~2-3 rows),
 * mirroring the already-virtualized grid view.
 */
export default function GalleryView({
  entries,
  thumbCache,
  entrySize,
  selected,
  onSelect,
  onOpen,
  tagsByName,
  tagColors,
  groups,
  onDropTag,
  onContextEntry,
  readOnly,
  showTags = true,
}: GalleryViewProps) {
  const { t } = useTranslation();

  // `mediaPlaylist` is an O(n) filter; memoize so unrelated re-renders don't
  // recompute it.
  const mediaEntries = useMemo(() => mediaPlaylist(entries), [entries]);

  // Measure the scroll container so columns track real width (tray open/close,
  // window resize, zoom).
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [gridWidth, setGridWidth] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    setGridWidth(Math.max(0, el.clientWidth - 32));
    const ro = new ResizeObserver((entriesObs) => {
      for (const entry of entriesObs) {
        // P3-5 (perf audit): guard against spurious same-width notifications
        // (matches FileList's pattern) so resize ticks don't recompute cols.
        const w = entry.contentRect.width;
        setGridWidth((prev) => (prev === w ? prev : w));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Account for the gutter between tiles so the last column doesn't overflow.
  const gap = entrySize > 200 ? 16 : 8;
  const cols = Math.max(
    2,
    Math.floor(((gridWidth || 800) + gap) / (entrySize + gap))
  );
  const columnWidth = gridWidth > 0 ? Math.floor(gridWidth / cols) : entrySize;

  // Keyboard focus index. The container captures arrow keys; this is the caret
  // position inside `mediaEntries`, not the global `visible` index.
  const [focusedIndex, setFocusedIndex] = useState(0);
  // `useGridRef()` is typed as `GridImperativeAPI | undefined`, but the Grid's
  // `gridRef` prop is `Ref<GridImperativeAPI>` whose current is `… | null`.
  // A plain ref keeps both sides on the same null-based shape.
  const gridRef = useRef<GridImperativeAPI | null>(null);

  // Snap focus back into bounds when the playlist shrinks.
  useEffect(() => {
    if (focusedIndex >= mediaEntries.length) {
      setFocusedIndex(Math.max(0, mediaEntries.length - 1));
    }
  }, [mediaEntries.length, focusedIndex]);

  // Reset focus when the directory changes.
  useEffect(() => {
    setFocusedIndex(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaEntries[0]?.path]);

  // Keep the focused tile visible as the user arrows around.
  useEffect(() => {
    gridRef.current?.scrollToCell({
      rowIndex: Math.floor(focusedIndex / cols),
      columnIndex: focusedIndex % cols,
      behavior: 'auto',
    });
  }, [focusedIndex, cols, gridRef]);

  const moveFocus = useCallback(
    (delta: number) => {
      setFocusedIndex((i) => {
        const next = Math.max(0, Math.min(mediaEntries.length - 1, i + delta));
        return next;
      });
    },
    [mediaEntries.length]
  );

  const handleContainerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      // P1-1 (gui-audit 2026-11): the gallery container sits inside FileList's
      // outer keyboard Box, so without `stopPropagation` every handled key ran
      // BOTH handlers — arrows moved the gallery caret and the list selection,
      // Enter opened the lightbox and the list's focused entry, Space toggled
      // selection twice. Consume handled keys here (keeping `preventDefault`
      // for the browser default); keys we don't handle still bubble so
      // list-level shortcuts (Delete / F2 / Esc / view switch) keep working.
      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          e.stopPropagation();
          moveFocus(1);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          e.stopPropagation();
          moveFocus(-1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          e.stopPropagation();
          moveFocus(cols);
          break;
        case 'ArrowUp':
          e.preventDefault();
          e.stopPropagation();
          moveFocus(-cols);
          break;
        case 'Home':
          e.preventDefault();
          e.stopPropagation();
          setFocusedIndex(0);
          break;
        case 'End':
          e.preventDefault();
          e.stopPropagation();
          setFocusedIndex(Math.max(0, mediaEntries.length - 1));
          break;
        case 'Enter': {
          e.preventDefault();
          e.stopPropagation();
          const entry = mediaEntries[focusedIndex];
          if (entry) onOpen?.(entry);
          break;
        }
        case ' ': {
          e.preventDefault();
          e.stopPropagation();
          const entry = mediaEntries[focusedIndex];
          if (entry) onSelect?.(entry, { shift: false, toggle: true });
          break;
        }
        default:
          break;
      }
    },
    [moveFocus, cols, mediaEntries, focusedIndex, onOpen, onSelect]
  );

  // Memoize the props bag for react-window's per-cell shallow comparison.
  const cellProps = useMemo(
    () => ({
      entries: mediaEntries,
      columnCount: cols,
      entrySize,
      thumbCache,
      tagsByName: tagsByName ?? EMPTY_TAG_MAP,
      tagColors: tagColors ?? EMPTY_TAG_COLORS,
      groups: groups ?? EMPTY_TAG_GROUPS,
      selected: selected ?? new Set(),
      onSelect,
      onOpen,
      onDropTag,
      onContextEntry,
      readOnly,
      showTags,
      focusIndex: focusedIndex,
      onFocus: setFocusedIndex,
    }),
    [
      mediaEntries,
      cols,
      entrySize,
      thumbCache,
      tagsByName,
      tagColors,
      groups,
      selected,
      onSelect,
      onOpen,
      onDropTag,
      onContextEntry,
      readOnly,
      showTags,
      focusedIndex,
    ]
  );

  if (mediaEntries.length === 0) {
    return (
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Typography color="text.secondary">{t('noMedia')}</Typography>
      </Box>
    );
  }

  return (
    <Box
      ref={containerRef}
      tabIndex={0}
      role="grid"
      aria-label={t('gallery')}
      onKeyDown={handleContainerKeyDown}
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        height: '100%',
        outline: 'none',
        p: 2,
        '&:focus-visible': {
          boxShadow: 'inset 0 0 0 2px rgba(25,118,210,0.4)',
        },
      }}
    >
      <VirtualGrid
        style={{ width: '100%', height: '100%' }}
        columnCount={cols}
        columnWidth={columnWidth}
        rowCount={Math.ceil(mediaEntries.length / cols)}
        rowHeight={entrySize}
        cellComponent={GalleryCell}
        gridRef={gridRef}
        onResize={({ width }) => {
          setGridWidth((prev) => (prev === width ? prev : width));
        }}
        cellProps={cellProps}
        defaultWidth={800}
        defaultHeight={400}
      />
    </Box>
  );
}
