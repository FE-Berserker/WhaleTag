import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, ToggleButton, ToggleButtonGroup } from '@mui/material';
import ViewKanbanIcon from '@mui/icons-material/ViewKanban';
import WindowIcon from '@mui/icons-material/Window';
import TimelineIcon from '@mui/icons-material/Timeline';

import type { DirEntry } from '../../shared/ipc-types';
import type { WorkflowStage } from '../domain/workflow';
import type { FileCellData } from '-/components/file-cell';
import KanbanView from '-/components/KanbanView';
import MatrixView from '-/components/MatrixView';
import GanttView from '-/components/GanttView';
import { readPrefs, writePrefs } from '../domain/perspective-prefs';

/**
 * H.29 + Tasks §3.3: The three inner layouts the Task perspective can show.
 * Persisted to localStorage (NOT Redux / NOT `.whale/wsm.json`) because the
 * choice is a user UX preference, not a per-folder data attribute — every
 * folder in Task perspective shares the same sub-view selector across the
 * app lifetime.
 */
type TaskSubView = 'kanban' | 'matrix' | 'gantt';

const PREFS_KEY = 'whale-task-subview';

interface TaskViewPrefs {
  subView?: TaskSubView;
}

/** Coerce an unknown persisted value into a valid sub-view literal. Mirrors
 *  the `sanitizeShownCategories` pattern in perspective-prefs.ts so a
 *  tampered / outdated localStorage entry can't crash the view. */
function sanitizeSubView(value: unknown): TaskSubView | null {
  return value === 'kanban' || value === 'matrix' || value === 'gantt'
    ? value
    : null;
}

interface TaskViewProps {
  /** Shared per-cell handler bag (same one list / grid / gallery use). */
  data: FileCellData;
  /** Customizable workflow stages — fed through to KanbanView's columns and
   *  MatrixView's "Move to stage" submenu. */
  stages: WorkflowStage[];
  /**
   * Move `sources` into the column / quadrant for `targetValue`
   * (null = the untagged column / tray), with mutually-exclusive
   * semantics against the supplied `groupTags` axis. KanbanView and
   * MatrixView each pass the right axis (workflow values vs. the four
   * quadrant tokens) — this prop stays a single sink.
   */
  onMoveToColumn: (
    sources: DirEntry[],
    targetValue: string | null,
    groupTags: string[]
  ) => void;
}

/**
 * Task perspective (H.29): a thin container that hosts a Kanban / Matrix
 * sub-switch. Renders ONE of <KanbanView> or <MatrixView> at a time; the
 * other is fully unmounted (the `key={subView}` forces a fresh mount on
 * every flip so DnD subscriptions and menu state reset cleanly — otherwise
 * the previously-rendered view's drop targets linger in the React tree).
 *
 * The sub-view state lives in localStorage so it survives app restarts
 * (mirrors the readPrefs / writePrefs pattern from TagCloud / FolderViz)
 * and is deliberately NOT in Redux — it's UX preference, not data.
 */
export default function TaskView({ data, stages, onMoveToColumn }: TaskViewProps) {
  const { t } = useTranslation();
  const [subView, setSubViewState] = useState<TaskSubView>(() => {
    const prefs = readPrefs<TaskViewPrefs>(PREFS_KEY);
    return sanitizeSubView(prefs?.subView) ?? 'kanban';
  });

  // Persist on every flip. writePrefs swallows quota / disabled-storage
  // errors (private mode) so a failed save can't crash the view.
  const handleSubViewChange = useCallback(
    (_e: unknown, next: TaskSubView | null) => {
      if (!next) return; // ToggleButtonGroup never produces null when exclusive
      setSubViewState(next);
      writePrefs<TaskViewPrefs>(PREFS_KEY, { subView: next });
    },
    []
  );

  // Belt-and-suspenders: re-read on mount in case another tab / component
  // wrote the prefs between the initial `useState` read and the first paint.
  // Cheap (one localStorage get) and only runs once.
  useEffect(() => {
    const prefs = readPrefs<TaskViewPrefs>(PREFS_KEY);
    const persisted = sanitizeSubView(prefs?.subView);
    if (persisted && persisted !== subView) {
      setSubViewState(persisted);
    }
    // intentional: run once on mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Box
      data-testid="task-view"
      data-sub-view={subView}
      sx={{
        height: '100%',
        width: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      {/* Sub-switch toolbar. Same `ToggleButtonGroup` idiom the file header
          uses for the top-level perspective picker, scaled down for an
          in-view control. Sized to the content so it doesn't crowd the
          main area. */}
      <Box
        sx={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1.5,
          py: 1,
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <ToggleButtonGroup
          size="small"
          exclusive
          value={subView}
          onChange={handleSubViewChange}
          aria-label={t('viewTask')}
        >
          <ToggleButton
            value="kanban"
            data-testid="task-toggle-kanban"
            aria-label={t('taskSubViewKanban')}
            sx={{ px: 1.5, py: 0.25, textTransform: 'none' }}
          >
            <ViewKanbanIcon fontSize="small" sx={{ mr: 0.5 }} />
            {t('taskSubViewKanban')}
          </ToggleButton>
          <ToggleButton
            value="matrix"
            data-testid="task-toggle-matrix"
            aria-label={t('taskSubViewMatrix')}
            sx={{ px: 1.5, py: 0.25, textTransform: 'none' }}
          >
            <WindowIcon fontSize="small" sx={{ mr: 0.5 }} />
            {t('taskSubViewMatrix')}
          </ToggleButton>
          {/* Tasks §3.3: third sub-view — Gantt timeline. Same toolbar
              height as the kanban/matrix toggles, same label/i18n plumbing. */}
          <ToggleButton
            value="gantt"
            data-testid="task-toggle-gantt"
            aria-label={t('taskSubViewGantt')}
            sx={{ px: 1.5, py: 0.25, textTransform: 'none' }}
          >
            <TimelineIcon fontSize="small" sx={{ mr: 0.5 }} />
            {t('taskSubViewGantt')}
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>

      {/* Active sub-view. The `key={subView}` forces a full remount on
          every flip — prevents two views from coexisting in the React
          tree (each registers DnD subscriptions, drop refs, and local
          menu state that would conflict otherwise). */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {subView === 'kanban' ? (
          <KanbanView
            key="task-kanban"
            data={data}
            stages={stages}
            onMoveToColumn={onMoveToColumn}
          />
        ) : subView === 'matrix' ? (
          <MatrixView
            key="task-matrix"
            data={data}
            onMoveToColumn={onMoveToColumn}
            stages={stages}
          />
        ) : (
          <GanttView
            key="task-gantt"
            data={data}
            stages={stages}
            onMoveToColumn={onMoveToColumn}
          />
        )}
      </Box>
    </Box>
  );
}