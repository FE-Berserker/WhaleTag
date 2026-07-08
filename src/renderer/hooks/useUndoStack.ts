import { useCallback, useMemo, useRef, useState } from 'react';

import { popItem, pushItem } from './useUndoStack-impl';

export interface UndoStack<T> {
  /** True when there is at least one item available to undo. */
  canUndo: boolean;
  /** Push an item onto the stack (oldest drops when at capacity). */
  push: (item: T) => void;
  /**
   * Pop the most recent item and return it. Returns `null` when the stack is
   * empty. Reads via a ref so callers can use the returned value immediately
   * without waiting for the next render.
   */
  undo: () => T | null;
  /** Clear all undo history (e.g. on directory change). */
  clear: () => void;
}

const DEFAULT_CAPACITY = 20;

/**
 * P3-3: a tiny FIFO-with-cap undo stack used by the Mapique view to record
 * geo-coordinate mutations (set / clear) so the user can revert an accidental
 * map click or marker drag.
 *
 * The pure state machine lives in `./useUndoStack-impl.ts`; this hook just
 * wires it to React state. The returned object is memoised so it can be a
 * `useEffect` dependency without re-firing the effect on every render.
 */
export function useUndoStack<T>(
  capacity: number = DEFAULT_CAPACITY
): UndoStack<T> {
  const [past, setPast] = useState<T[]>([]);
  // Mirror the latest committed state so `undo()` can return synchronously
  // without waiting for React's batched update to flush.
  const pastRef = useRef<T[]>([]);
  pastRef.current = past;

  const push = useCallback(
    (item: T) => {
      setPast((prev) => pushItem(prev, item, capacity));
    },
    [capacity]
  );

  const undo = useCallback((): T | null => {
    const current = pastRef.current;
    if (current.length === 0) return null;
    const { item, past: next } = popItem(current);
    setPast(next);
    return item;
  }, []);

  const clear = useCallback(() => setPast([]), []);

  return useMemo(
    () => ({
      canUndo: past.length > 0,
      push,
      undo,
      clear,
    }),
    [past.length, push, undo, clear]
  );
}