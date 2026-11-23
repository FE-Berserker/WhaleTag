import { lazy, Suspense } from 'react';
import type { MutableRefObject } from 'react';
import { Box, CircularProgress } from '@mui/material';
import {
  Grid as VirtualGrid,
  List as VirtualList,
  type GridImperativeAPI,
  type ListImperativeAPI,
} from 'react-window';

import type { DirEntry } from '../../../shared/ipc-types';
import type { ViewMode } from '../../../shared/whale-meta';
import type { MapProvider } from '-/reducers/settings';
import type { FileCellData } from '-/components/file-cell';
import type { WorkflowStage } from '../../domain/workflow';
import GridCell from '-/components/GridCell';
import Row from '-/components/Row';
// Perspective views are lazy-loaded so the heavy viz libs they transitively
// pull in (echarts via Calendar/TagCloud/FolderViz, leaflet via Mapique,
// @xyflow/react via KnowledgeGraph) load on demand when the user switches to
// that view — not on first paint. Each is rendered behind exactly one
// `viewMode` branch in the switch below (wrapped in <Suspense>).
const GalleryView = lazy(() => import('-/components/GalleryView'));
const TaskView = lazy(() => import('-/components/TaskView'));
const CalendarView = lazy(() => import('-/components/CalendarView'));
const FolderVizView = lazy(() => import('-/components/FolderVizView'));
const TagCloudView = lazy(() => import('-/components/TagCloudView'));
const KnowledgeGraphView = lazy(() => import('-/components/KnowledgeGraphView'));
const MapiqueView = lazy(() => import('-/components/MapiqueView'));

/** Suspense fallback shown while a lazy perspective view's chunk loads. */
const PerspectiveFallback = (
  <Box
    sx={{
      flex: 1,
      minHeight: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}
  >
    <CircularProgress />
  </Box>
);

/**
 * `viewMode` → concrete view mapping for the file area (P2 FileList split).
 *
 * This is a pure presentational switch: `FileList` still owns every piece of
 * state and every handler, and passes them down verbatim through the shared
 * `FileCellData` bag. Two invariants worth keeping:
 *  - `Row` / `GridCell` are passed directly (module-scope, stable refs) so
 *    react-window's internal memo is not rebuilt on every render;
 *  - the list/grid branches are wrapped in the SAME `<Suspense>` as the lazy
 *    perspectives, exactly like the pre-extraction JSX.
 */
export interface FileListViewProps {
  viewMode: ViewMode;
  /** Shared per-cell handler bag (list / grid / gallery / perspectives). */
  data: FileCellData;
  /** Live selection Set (mutated in place by FileList). */
  selectedPaths: Set<string>;
  /** Shared grid-cell zoom (px). */
  entrySize: number;
  /** List row height from the density preset (px). */
  rowHeight: number;
  /** Grid row height (`entrySize + GRID_CELL_FOOTER`, px). */
  gridRowHeight: number;
  gridColumns: number;
  gridColumnWidth: number;
  onGridResize: (width: number) => void;
  listRef: MutableRefObject<ListImperativeAPI | null>;
  gridRef: MutableRefObject<GridImperativeAPI | null>;
  /** Customizable workflow stages for the Task perspective. */
  stages: WorkflowStage[];
  onMoveToColumn: NonNullable<FileCellData['onMoveToColumn']>;
  /** Gallery tile click → the same selectRow gesture as list/grid rows. */
  onSelectGallery: (
    entry: DirEntry,
    mods: { shift: boolean; toggle: boolean }
  ) => void;
  onDeleteSelected: () => void;
  /** Path → coordinates map used by the Mapique perspective. */
  geoByName: Map<string, { lat: number; lng: number } | null>;
  mapProvider: MapProvider;
  mapTileUrl: string;
  loading: boolean;
  galleryShowTags: boolean;
  onGpsFound: (entry: DirEntry, lat: number, lng: number) => void;
  onSetGeo: (entry: DirEntry, lat: number, lng: number) => void;
  onClearGeo: (entry: DirEntry) => void;
  onAddTag: (entry: DirEntry, tag: string) => void;
  onRemoveTag: (entry: DirEntry, tag: string) => void;
}

export default function FileListView({
  viewMode,
  data,
  selectedPaths,
  entrySize,
  rowHeight,
  gridRowHeight,
  gridColumns,
  gridColumnWidth,
  onGridResize,
  listRef,
  gridRef,
  stages,
  onMoveToColumn,
  onSelectGallery,
  onDeleteSelected,
  geoByName,
  mapProvider,
  mapTileUrl,
  loading,
  galleryShowTags,
  onGpsFound,
  onSetGeo,
  onClearGeo,
  onAddTag,
  onRemoveTag,
}: FileListViewProps) {
  return (
    <Suspense fallback={PerspectiveFallback}>
      {viewMode === 'task' ? (
        // H.29: Task perspective is a thin container that hosts a
        // Kanban / Matrix sub-switch. Both child views are imported
        // here only as type references — TaskView owns the actual
        // mount + sub-switch UX, so the child components don't
        // appear directly in this render chain.
        <TaskView
          data={data}
          stages={stages}
          onMoveToColumn={onMoveToColumn}
        />
      ) : viewMode === 'calendar' ? (
        <CalendarView data={data} />
      ) : viewMode === 'folderviz' ? (
        <FolderVizView data={data} />
      ) : viewMode === 'tagcloud' ? (
        <TagCloudView data={data} />
      ) : viewMode === 'knowledge-graph' ? (
        <KnowledgeGraphView data={data} />
      ) : viewMode === 'mapique' ? (
        // P2-5: no `key` prop here on purpose. `MapiqueView` used to bump
        // itself through an effect keyed on `geoByName`/`tagsByName`, and
        // its comment pointed at a `key` on this site that never existed.
        // Props are the signal: `geoByName` / `tagsByName` come from
        // `TagMetaContextProvider` and get a fresh identity on every
        // sidecar save, so this subtree re-renders once, normally.
        <MapiqueView
          entries={data.entries}
          geoByName={geoByName}
          tagsByName={data.tagsByName}
          loading={loading}
          thumbCache={data.thumbCache}
          onGpsFound={onGpsFound}
          onOpen={data.onOpen}
          onDelete={onDeleteSelected}
          provider={mapProvider}
          tileUrl={mapTileUrl}
          readOnly={data.readOnly}
          onSetGeo={onSetGeo}
          onClearGeo={onClearGeo}
          onAddTag={onAddTag}
          onRemoveTag={onRemoveTag}
          tagColors={data.tagColors}
          groups={data.groups}
        />
      ) : viewMode === 'gallery' ? (
        <GalleryView
          entries={data.entries}
          thumbCache={data.thumbCache}
          entrySize={entrySize}
          selected={selectedPaths}
          onSelect={onSelectGallery}
          onOpen={data.onOpen}
          tagsByName={data.tagsByName}
          tagColors={data.tagColors}
          groups={data.groups}
          // §2 P0 拖拽打标 (2026-07-02): wire the same handleDropTag
          // command that list/grid rows use, plus the location's readOnly
          // so a drag-over on a read-only tile doesn't even show the
          // dashed outline. command-layer defense also lives in
          // `commands.handleDropTag` (see useListCommands.ts).
          onDropTag={data.onDropTag}
          onContextEntry={data.onContextEntry}
          readOnly={data.readOnly}
          showTags={galleryShowTags}
        />
      ) : viewMode === 'grid' ? (
        <VirtualGrid
          gridRef={gridRef}
          style={{ width: '100%', height: '100%' }}
          columnCount={gridColumns}
          columnWidth={gridColumnWidth}
          rowCount={Math.ceil(data.entries.length / gridColumns)}
          rowHeight={gridRowHeight}
          cellComponent={GridCell}
          onResize={({ width }) => {
            onGridResize(width);
          }}
          cellProps={{
            ...data,
            columnCount: gridColumns,
            entrySize,
            cellWidth: gridColumnWidth,
          }}
        />
      ) : (
        <Box data-testid="view-list" sx={{ flex: 1, minHeight: 0 }}>
          <VirtualList
            listRef={listRef}
            style={{ height: '100%' }}
            rowCount={data.entries.length}
            rowHeight={rowHeight}
            rowComponent={Row}
            rowProps={data}
          />
        </Box>
      )}
    </Suspense>
  );
}
