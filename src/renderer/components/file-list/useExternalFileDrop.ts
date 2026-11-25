import { useCallback, useRef } from 'react';
import { useDrop } from 'react-dnd';
import { NativeTypes } from 'react-dnd-html5-backend';
import type { TFunction } from 'i18next';

import type { ViewMode } from '../../../shared/whale-meta';
import { todayKey, periodTagFromRange } from '../../domain/gantt';

/**
 * External-file drop target extracted from `FileList` (P2 FileList split).
 *
 * Two responsibilities that only make sense together:
 *  - `handleExternalDrop`: copy OS files into the current directory (main
 *    auto-renames on clash; never overwrites) and, in task perspective, stamp
 *    the today-period tag so the imported file lands on the Gantt timeline.
 *  - the `react-dnd` native FILE drop target + the `isFileOver` overlay flag
 *    the surrounding Box renders.
 *
 * react-dnd memoizes the drop spec by its dependency array and invokes
 * `drop` / `canDrop` from THAT closure. The array used to be
 * `[readOnly, currentDirectoryPath]` ("exactly the pre-extraction array"),
 * which silently froze `viewMode` / `importExternalFiles` / `showNotice` /
 * `t` at the render where those two last changed: after a list ↔ task switch
 * a drop went through a stale `viewMode`, so drops in task view were not
 * stamped with the today period — and list-view drops after a visit to task
 * view were. Every input is now read through a latest-ref, so the spec
 * closure is always correct regardless of its own lifetime.
 */
export interface UseExternalFileDropOptions {
  viewMode: ViewMode;
  currentDirectoryPath: string;
  /** `!!currentLocation?.isReadOnly` — never drops into a read-only location. */
  readOnly: boolean;
  importExternalFiles: (
    files: File[],
    options?: { tagToApply?: string | null }
  ) => Promise<{ copied: number; errors: string[] }>;
  showNotice: (
    text: string,
    severity?: 'success' | 'info' | 'warning' | 'error'
  ) => void;
  t: TFunction;
}

export interface ExternalFileDrop {
  /** True while OS files hover the area and the location accepts drops. */
  isFileOver: boolean;
  /** Callback ref for the drop surface (react-dnd `ConnectDropTarget`). */
  nativeDropRef: ReturnType<typeof useDrop>[1];
}

export function useExternalFileDrop({
  viewMode,
  currentDirectoryPath,
  readOnly,
  importExternalFiles,
  showNotice,
  t,
}: UseExternalFileDropOptions): ExternalFileDrop {
  // Latest-ref: react-dnd's spec closure reads everything from here at event
  // time, so it never observes a stale `viewMode` after a view switch.
  const latest = useRef({
    viewMode,
    currentDirectoryPath,
    readOnly,
    importExternalFiles,
    showNotice,
    t,
  });
  latest.current = {
    viewMode,
    currentDirectoryPath,
    readOnly,
    importExternalFiles,
    showNotice,
    t,
  };

  // Drop one or more entries onto a folder cell to move them inside it.
  // External files dragged in from outside the app (OS file manager): copy them
  // into the current directory. Never overwrites (main auto-renames on clash).
  //
  // In task perspective (Kanban / Matrix / Gantt), the per-column / per-
  // quadrant / per-tray drop targets ALSO accept native files (see
  // KanbanView / MatrixView / GanttView) and stamp the column's tag.
  // This outer `handleExternalDrop` is the **fallback** for drops that
  // don't land on a specific column / quadrant — e.g., the toolbar area,
  // the toggle row, the PropertiesTray gutter, or the empty space in
  // list / grid view. The today-period auto-tag is still applied for
  // task view so an imported file appears on the Gantt timeline.
  const handleExternalDrop = useCallback(async (files: File[]) => {
    const {
      viewMode: mode,
      currentDirectoryPath: dir,
      importExternalFiles: doImport,
      showNotice: notify,
      t: translate,
    } = latest.current;
    if (!files?.length || !dir) return;
    let tagToApply: string | null = null;
    if (mode === 'task') {
      const today = todayKey();
      tagToApply = periodTagFromRange({ startKey: today, endKey: today });
    }
    try {
      const { copied, errors } = await doImport(files, { tagToApply });
      if (copied > 0) {
        notify(translate('importedItems', { count: copied }), 'success');
      } else if (errors.length) notify(errors[0]);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Drop target for OS files dragged into the file area (NativeTypes.FILE).
  const [{ isFileOver }, nativeDropRef] = useDrop<
    { files: File[] },
    unknown,
    { isFileOver: boolean }
  >(
    () => ({
      accept: [NativeTypes.FILE],
      canDrop: () => !latest.current.readOnly,
      drop: (item) => {
        void handleExternalDrop(item.files);
      },
      collect: (monitor) => ({
        isFileOver: monitor.isOver() && monitor.canDrop(),
      }),
    }),
    // The spec reads everything through `latest`, so its memo lifetime no
    // longer affects correctness. Kept as the pre-extraction array purely to
    // keep the target registration from churning on unrelated renders.
    [readOnly, currentDirectoryPath]
  );

  return { isFileOver, nativeDropRef };
}
