import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Box, Typography } from '@mui/material';
import { List as VirtualList } from 'react-window';

import type { DirEntry } from '../../shared/ipc-types';
import MapiqueTrayRow, {
  TRAY_ROW_HEIGHT,
  type MapiqueTrayRowData,
} from './MapiqueTrayRow';

/** True if the keyboard event target is an input-like element that should
 *  swallow navigation shortcuts. */
function isInputLike(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  const editable = el.getAttribute('contenteditable') === 'true';
  return (
    editable ||
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select'
  );
}

export interface MapiqueTrayProps {
  entries: DirEntry[];
  selected: Set<string>;
  activeEntry: DirEntry | null;
  locatedPaths: Set<string>;
  geoColorMap: Map<string, string>;
  thumbCache: Map<string, string>;
  onSelectRow: (index: number, mods: { shift: boolean; ctrl: boolean }) => void;
  onOpen?: (entry: DirEntry) => void;
  onDelete?: (entries: DirEntry[]) => void;
  onClearSelection?: () => void;
  onSelectAll?: () => void;
  onContextMenu?: (entry: DirEntry, x: number, y: number) => void;
  /** P3-2: notify parent which row is hovered so the matching map marker
   *  can be visually emphasised (bounce). */
  onHoverRow?: (path: string | null) => void;
  /** Current filter label, used to reset focus when the visible set changes. */
  filter: string;
  t: (key: string) => string;
}

/**
 * H.26 P1-2 / P1-3: virtual-scroll file tray for Mapique with keyboard
 * navigation. Owns `focusIndex` and renders rows via `MapiqueTrayRow`.
 */
export default function MapiqueTray({
  entries,
  selected,
  activeEntry,
  locatedPaths,
  geoColorMap,
  thumbCache,
  onSelectRow,
  onOpen,
  onDelete,
  onClearSelection,
  onSelectAll,
  onContextMenu,
  onHoverRow,
  filter,
  t,
}: MapiqueTrayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(400);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const selectAnchorRef = useRef<number | null>(null);

  // Measure container height so react-window fills the available space.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) setHeight(h);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Reset focus when the visible set changes (filter or directory).
  useEffect(() => {
    setFocusIndex(null);
    selectAnchorRef.current = null;
  }, [entries, filter]);

  const selectedEntries = useMemo(
    () => entries.filter((e) => selected.has(e.path)),
    [entries, selected]
  );

  const moveFocus = useCallback(
    (nextIndex: number, extend?: boolean) => {
      const clamped = Math.max(0, Math.min(entries.length - 1, nextIndex));
      setFocusIndex(clamped);
      if (extend && selectAnchorRef.current !== null) {
        onSelectRow(clamped, { shift: true, ctrl: false });
      } else {
        onSelectRow(clamped, { shift: false, ctrl: false });
        selectAnchorRef.current = clamped;
      }
    },
    [entries.length, onSelectRow]
  );

  const toggleSelection = useCallback(
    (index: number) => {
      onSelectRow(index, { shift: false, ctrl: true });
      selectAnchorRef.current = index;
    },
    [onSelectRow]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isInputLike(e.target)) return;

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          const start = focusIndex ?? -1;
          moveFocus(start + 1, e.shiftKey);
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          const start = focusIndex ?? entries.length;
          moveFocus(start - 1, e.shiftKey);
          break;
        }
        case 'Home': {
          e.preventDefault();
          moveFocus(0, e.shiftKey);
          break;
        }
        case 'End': {
          e.preventDefault();
          moveFocus(entries.length - 1, e.shiftKey);
          break;
        }
        case 'Enter': {
          e.preventDefault();
          const idx = focusIndex ?? 0;
          if (idx >= 0 && idx < entries.length) {
            onOpen?.(entries[idx]);
          }
          break;
        }
        case ' ': {
          e.preventDefault();
          if (focusIndex !== null) {
            toggleSelection(focusIndex);
          }
          break;
        }
        case 'Escape': {
          e.preventDefault();
          onClearSelection?.();
          setFocusIndex(null);
          selectAnchorRef.current = null;
          containerRef.current?.blur();
          break;
        }
        case 'Delete': {
          e.preventDefault();
          if (selectedEntries.length > 0) {
            onDelete?.(selectedEntries);
          }
          break;
        }
        case 'a':
        case 'A': {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            onSelectAll?.();
          }
          break;
        }
        default:
          break;
      }
    },
    [
      entries,
      focusIndex,
      moveFocus,
      onClearSelection,
      onDelete,
      onOpen,
      onSelectAll,
      selectedEntries,
      toggleSelection,
    ]
  );

  const rowData: MapiqueTrayRowData = useMemo(
    () => ({
      entries,
      selected,
      activeEntry,
      locatedPaths,
      geoColorMap,
      thumbCache,
      onSelectRow,
      onOpen,
      onContextMenu,
      onHoverRow,
      focusIndex,
    }),
    [
      entries,
      selected,
      activeEntry,
      locatedPaths,
      geoColorMap,
      thumbCache,
      onSelectRow,
      onOpen,
      onContextMenu,
      onHoverRow,
      focusIndex,
    ]
  );

  if (entries.length === 0) {
    return (
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', px: 1.5, py: 1 }}
      >
        {t('noGeoCandidates')}
      </Typography>
    );
  }

  return (
    <Box
      ref={containerRef}
      tabIndex={-1}
      role="listbox"
      aria-label={t('files')}
      onKeyDown={handleKeyDown}
      sx={{ flex: '0 0 70%', overflow: 'hidden', flexShrink: 0 }}
    >
      <VirtualList
        style={{ height }}
        rowCount={entries.length}
        rowHeight={TRAY_ROW_HEIGHT}
        rowComponent={MapiqueTrayRow}
        rowProps={rowData}
      />
    </Box>
  );
}
