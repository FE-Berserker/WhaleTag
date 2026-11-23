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
 * The `useDrop` dependency array intentionally stays
 * `[readOnly, currentDirectoryPath]` — exactly the pre-extraction array. It
 * does NOT include `viewMode` / `showNotice` / `t`; preserving that means the
 * drop spec keeps the same closure lifetime it had inline. Do not "fix" this
 * without a behaviour change review.
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
  const handleExternalDrop = async (files: File[]) => {
    if (!files?.length || !currentDirectoryPath) return;
    let tagToApply: string | null = null;
    if (viewMode === 'task') {
      const today = todayKey();
      tagToApply = periodTagFromRange({ startKey: today, endKey: today });
    }
    try {
      const { copied, errors } = await importExternalFiles(files, {
        tagToApply,
      });
      if (copied > 0) {
        showNotice(t('importedItems', { count: copied }), 'success');
      } else if (errors.length) showNotice(errors[0]);
    } catch (e) {
      showNotice(e instanceof Error ? e.message : String(e));
    }
  };

  // Drop target for OS files dragged into the file area (NativeTypes.FILE).
  const [{ isFileOver }, nativeDropRef] = useDrop<
    { files: File[] },
    unknown,
    { isFileOver: boolean }
  >(
    () => ({
      accept: [NativeTypes.FILE],
      canDrop: () => !readOnly,
      drop: (item) => {
        void handleExternalDrop(item.files);
      },
      collect: (monitor) => ({
        isFileOver: monitor.isOver() && monitor.canDrop(),
      }),
    }),
    [readOnly, currentDirectoryPath]
  );

  return { isFileOver, nativeDropRef };
}
