/**
 * `useGanttKeyboardNavigation` — P0 #4 keyboard handler for the Gantt view.
 *
 * Owns:
 *   - `focusedPath` state (which bar currently has the keyboard focus).
 *   - `tabIndexFor(path)` — only the focused bar is tabbable; others
 *     are `tabIndex={-1}` so the user can't tab through every bar.
 *   - The onKeyDown handler attached to the scroller — processes
 *     `↑↓ ← →` (vertical / horizontal traversal), `Space` (open
 *     period dialog via the same path as a bar single-click),
 *     `T` (jump to today), and `Esc` (clear focus).
 *
 * Why a scroller-level onKeyDown (not per-bar): the focus lives on a
 * bar, but keydown fires on the focused element and bubbles up to the
 * scroller. Centralizing the handler means a single useEffect and no
 * listener thrash on focus changes. The handler is no-op when no bar
 * is focused, so accidental keypresses outside the Gantt are silent.
 *
 * Vertical / horizontal movement wrap around (last → first, first →
 * last). Spec said "切柱(垂直方向,跨 swim lane)" — the order follows
 * `displayRows`, so the lane grouping P0 #1 did is preserved.
 *
 * ±1 day shifts go through `onCommit` (same persistence path as a
 * drag commit). The arithmetic uses the shared `periodWithShift`
 * helper so the period tag goes through the same互斥 family rule
 * (`withSinglePeriodTag`) the drag handler does.
 */
import { useCallback, useMemo, useState } from 'react';

import { periodWithShift } from '../../../shared/gantt';
import type { GanttPeriod } from '../../../shared/gantt';

/** Set of all entry paths in render order — drives ↑↓ wrap-around.
 *  The consumer (GanttTimeline) passes `displayRows.map(r => r.entry.path)`. */
export interface UseGanttKeyboardNavigationArgs {
  paths: readonly string[];
  /** Resolves a path → current period. Used by ← → to compute the
   *  shifted period. Typically `(p) => scheduled.find(r => r.entry.path === p)?.period`. */
  getPeriod: (entryPath: string) => GanttPeriod | undefined;
  /** Wired to GanttView's `onCommit` so keyboard shifts persist the
   *  same way drag commits do. */
  onCommit: (entryPath: string, next: GanttPeriod) => void;
  /** Wired to GanttView's `handleClickPeriod` so Space opens the
   *  shared PeriodTagDialog (same path as a bar single-click). The
   *  PointerEvent is synthesized (clientX/clientY = 0) since the
   *  keyboard interaction has no cursor position. */
  onActivate: (entryPath: string) => void;
  /** Wired to GanttView's `scrollToToday`. The 'T' key shortcut. */
  onJumpToToday: () => void;
  /** True iff no bar interactions are allowed (location is read-only).
   *  When set, the handler returns early on every key so the user's
   *  arrows don't try to mutate. Focus itself can still move
   *  (a11y navigation) — just no commits / dialogs. */
  readOnly: boolean;
}

export interface UseGanttKeyboardNavigationResult {
  /** Path of the currently-focused bar, or null if none. */
  focusedPath: string | null;
  /** Programmatic focus setter — called by per-bar onFocus to bubble
   *  a DOM focus event up to the React state, AND by the keyboard
   *  handler after ↑↓ / ← → moves the focus. */
  setFocusedPath: (path: string | null) => void;
  /** Helper for each bar's `tabIndex` prop. The focused bar is
   *  tabbable; all others are `tabIndex={-1}` (skip-on-Tab). */
  tabIndexFor: (entryPath: string) => number;
  /** The onKeyDown handler. Attach to the scroller's outer Box. */
  onKeyDown: (e: React.KeyboardEvent) => void;
}

export function useGanttKeyboardNavigation(
  args: UseGanttKeyboardNavigationArgs
): UseGanttKeyboardNavigationResult {
  const { paths, getPeriod, onCommit, onActivate, onJumpToToday, readOnly } = args;
  const [focusedPath, setFocusedPath] = useState<string | null>(null);

  /** Move focus by `delta` indices in the (cyclic) `paths` array.
   *  Returns the new path or null if `paths` is empty. */
  const moveBy = useCallback(
    (delta: number): string | null => {
      if (paths.length === 0) return null;
      const cur = focusedPath ? paths.indexOf(focusedPath) : -1;
      // Wrap-around: from -1 (no focus) → 0 (first); from last → 0;
      // from first + delta=last → last; etc.
      const next =
        cur < 0
          ? delta > 0
            ? 0
            : paths.length - 1
          : (cur + delta + paths.length) % paths.length;
      return paths[next] ?? null;
    },
    [paths, focusedPath]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Don't fight the user's other interactions. Modifiers other than
      // what we use (no modifiers) → bail so browser shortcuts (Ctrl+T
      // for new tab, etc.) keep working.
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          const next = moveBy(1);
          if (next) setFocusedPath(next);
          return;
        }
        case 'ArrowUp': {
          e.preventDefault();
          const next = moveBy(-1);
          if (next) setFocusedPath(next);
          return;
        }
        case 'ArrowRight': {
          e.preventDefault();
          if (readOnly) return;
          if (!focusedPath) return;
          const period = getPeriod(focusedPath);
          if (!period) return;
          onCommit(focusedPath, periodWithShift(period, 1));
          return;
        }
        case 'ArrowLeft': {
          e.preventDefault();
          if (readOnly) return;
          if (!focusedPath) return;
          const period = getPeriod(focusedPath);
          if (!period) return;
          onCommit(focusedPath, periodWithShift(period, -1));
          return;
        }
        case ' ': // Space
        case 'Spacebar': {
          e.preventDefault();
          if (readOnly) return;
          if (!focusedPath) return;
          onActivate(focusedPath);
          return;
        }
        case 't':
        case 'T': {
          e.preventDefault();
          onJumpToToday();
          return;
        }
        case 'Escape': {
          e.preventDefault();
          setFocusedPath(null);
          return;
        }
        default:
          return;
      }
    },
    [focusedPath, moveBy, getPeriod, onCommit, onActivate, onJumpToToday, readOnly]
  );

  const tabIndexFor = useCallback(
    (entryPath: string): number => (entryPath === focusedPath ? 0 : -1),
    [focusedPath]
  );

  return useMemo(
    () => ({ focusedPath, setFocusedPath, tabIndexFor, onKeyDown }),
    [focusedPath, tabIndexFor, onKeyDown]
  );
}