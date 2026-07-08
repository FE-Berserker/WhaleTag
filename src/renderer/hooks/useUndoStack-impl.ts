/**
 * Pure, framework-agnostic operations backing `useUndoStack`. Extracted so
 * the contract (LIFO, drop-oldest, no mutation) is testable without
 * rendering React components.
 *
 * The hook in `useUndoStack.ts` is a thin React wrapper that wires these
 * operations to `useState` / `useCallback` / `useMemo`.
 */

/** Append `item` to `past`, dropping the oldest entry when the stack is at
 *  `capacity`. Returns a new array (never mutates the input). */
export function pushItem<T>(past: T[], item: T, capacity: number): T[] {
  if (capacity <= 0) return [];
  if (past.length < capacity) return [...past, item];
  // past.length >= capacity: keep the most recent `capacity - 1` items,
  // append the new one, so the oldest drops.
  return [...past.slice(past.length - capacity + 1), item];
}

/** Pop and return the most recent item, or `null` if the stack is empty.
 *  Returns a new `past` array as the second tuple element. */
export function popItem<T>(past: T[]): { item: T | null; past: T[] } {
  if (past.length === 0) return { item: null, past };
  return { item: past[past.length - 1], past: past.slice(0, -1) };
}

/** Imperative stack — handy for testing without React. */
export interface Stack<T> {
  push: (item: T) => void;
  pop: () => T | null;
  canUndo: () => boolean;
  clear: () => void;
  size: () => number;
}

/** Build a stack with optional capacity. */
export function makeStack<T>(capacity: number = 20): Stack<T> {
  let past: T[] = [];
  return {
    push(item: T) {
      past = pushItem(past, item, capacity);
    },
    pop() {
      const { item, past: next } = popItem(past);
      past = next;
      return item;
    },
    canUndo() {
      return past.length > 0;
    },
    clear() {
      past = [];
    },
    size() {
      return past.length;
    },
  };
}