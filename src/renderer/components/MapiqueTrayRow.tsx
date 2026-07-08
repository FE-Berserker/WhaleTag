import { useEffect, useRef } from 'react';
import { Checkbox, Stack, Typography } from '@mui/material';
import LocationOnIcon from '@mui/icons-material/LocationOn';
import type { RowComponentProps } from 'react-window';

import type { DirEntry } from '../../shared/ipc-types';
import ThumbIcon from './ThumbIcon';

export const TRAY_ROW_HEIGHT = 40;

export interface MapiqueTrayRowData {
  entries: DirEntry[];
  selected: Set<string>;
  activeEntry: DirEntry | null;
  locatedPaths: Set<string>;
  geoColorMap: Map<string, string>;
  thumbCache: Map<string, string>;
  onSelectRow: (index: number, mods: { shift: boolean; ctrl: boolean }) => void;
  onOpen?: (entry: DirEntry) => void;
  onContextMenu?: (entry: DirEntry, x: number, y: number) => void;
  /** P3-2: notify parent of which row is hovered so the matching map
   *  marker can be visually emphasised (bounce). */
  onHoverRow?: (path: string | null) => void;
  focusIndex: number | null;
}

/**
 * H.26 P1-2: one virtualized row in the Mapique file tray. Mirrors the visual
 * shape of the old inline `.map()` row but adds focus-ring support for keyboard
 * navigation and a context-menu surface.
 */
export default function MapiqueTrayRow({
  index,
  style,
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
}: RowComponentProps<MapiqueTrayRowData>) {
  const rowRef = useRef<HTMLDivElement>(null);
  const entry = entries[index];

  useEffect(() => {
    if (focusIndex === index && rowRef.current) {
      rowRef.current.focus({ preventScroll: true });
    }
  }, [focusIndex, index]);

  if (!entry) {
    return <div style={style} />;
  }

  const isSel = selected.has(entry.path);
  const isActive = activeEntry?.path === entry.path;
  const hasGeo = locatedPaths.has(entry.path);
  const geoColor = geoColorMap.get(entry.path);
  const isFocused = focusIndex === index;

  return (
    <Stack
      ref={rowRef}
      tabIndex={-1}
      direction="row"
      spacing={1}
      data-entry-path={entry.path}
      data-focused={isFocused || undefined}
      role="option"
      aria-selected={isSel}
      onClick={(e) =>
        onSelectRow(index, {
          shift: e.shiftKey,
          ctrl: e.ctrlKey || e.metaKey,
        })
      }
      onDoubleClick={() => onOpen?.(entry)}
      // P3-2: hover → bounce the matching map marker. Only fire when the
      // row has a known location (otherwise there is no marker to bounce).
      onMouseEnter={() => {
        if (onHoverRow && hasGeo) onHoverRow(entry.path);
      }}
      onMouseLeave={() => {
        if (onHoverRow) onHoverRow(null);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu?.(entry, e.clientX, e.clientY);
      }}
      sx={{
        px: 1.5,
        py: 0.4,
        cursor: 'pointer',
        alignItems: 'center',
        // Stop the browser from highlighting the row's text on shift-click.
        // Without this, shift-clicking the last row in a range multi-select
        // turns the filename text grey — the default ::selection background
        // bleeds through because the row has no `userSelect: 'none'`. The
        // regular FileList row (`src/renderer/components/Row.tsx:261`) hit
        // the same issue and added the same fix.
        userSelect: 'none',
        bgcolor: isSel ? 'action.selected' : 'transparent',
        borderLeft: 3,
        borderColor: geoColor ?? 'transparent',
        // The active-entry outline is suppressed on every row that is part
        // of the selection. `selectRow` always calls `setActiveEntry` on
        // every click, so a shift-range multi-select leaves the last clicked
        // row with BOTH isSel AND isActive — without this guard the outline
        // draws a 1px ring around just that one row, making it look like a
        // gray "shadow" sitting in front of the other selected rows.
        //
        // Keyboard focus (focusIndex) still gets its outline so ↑↓ nav keeps
        // its visible cursor. When multiple rows are selected we also drop
        // the active outline — the active entry is only meaningful for
        // single-select (it drives the detail panel and the draggable map
        // marker), so showing it on the last-clicked row during a range
        // select is just visual noise.
        //
        // `!important` defeats both the legacy outline that the browser
        // applies to the focused div (tabIndex={-1}) and any MUI Stack /
        // Box default focus styles that may be layered on top.
        outline: isFocused ? '1px solid' : 'none !important',
        outlineColor: 'primary.main',
        outlineOffset: '-1px',
        // Hover tint: only applies to unselected rows. `action.hover` and
        // `action.selected` are the same opaque color in this theme (see
        // createWhaleTheme → action), so explicitly forcing selected rows to
        // keep `action.selected` is a defensive no-op here, but it documents
        // intent and protects against a future preset that diverges the two.
        '&:hover': {
          bgcolor: isSel ? 'action.selected' : 'action.hover',
        },
      }}
      style={style}
    >
      <Checkbox
        size="small"
        checked={isSel}
        onClick={(e) => {
          e.stopPropagation();
          onSelectRow(index, {
            shift: e.shiftKey,
            ctrl: true,
          });
        }}
        sx={{ p: 0, mr: 0.5 }}
      />
      <ThumbIcon entry={entry} thumbCache={thumbCache} size={28} rounded={2} />
      <Typography variant="body2" noWrap sx={{ flex: 1, fontSize: 12 }}>
        {entry.name}
      </Typography>
      {hasGeo && (
        <LocationOnIcon
          sx={{ fontSize: 14, color: geoColor ?? 'success.main', flexShrink: 0 }}
        />
      )}
    </Stack>
  );
}
