import { useRef } from 'react';

/**
 * Reference-stable "deps bag" without a hand-maintained dependency array.
 *
 * Both `FileList` bags (`commandsDeps` for `useListCommands` and `cellData` for
 * the list rows / grid cells) used to be `useMemo(() => ({ ... }), [ ...39 hand
 * listed values... ])`. A hand-written array drifts: add a field to the object
 * and forget the array entry and the memo keeps a stale closure. `commandsDeps`
 * even carried an `eslint-disable-next-line react-hooks/exhaustive-deps` to
 * hide the drift.
 *
 * This hook derives the comparison from the object itself: build the bag on
 * every render (cheap — it is a flat object of already-memoized values), then
 * return the PREVIOUS object when every field is `Object.is`-identical. The
 * result is exactly what a complete, correct dependency array would produce,
 * but completeness is structural instead of manual:
 *
 * - the call site is typed `useStableBag<ListCommandsDeps>({ ... })`, so a
 *   missing required field is a TypeScript error (no silent stale bag);
 * - there is no array to keep in sync, so adding a field can never be silently
 *   dropped from the comparison.
 *
 * Callers must not put freshly-created closures in the bag: a new arrow every
 * render would always compare unequal and defeat the cache. Memoize the
 * handler (`useCallback`) and pass it in.
 *
 * Compared to `useMemo`, the only extra work per render is allocating the flat
 * object plus one `Object.keys` walk — far cheaper than the re-render a broken
 * identity causes downstream (react-window rows shallow-compare this bag).
 */
export function useStableBag<T extends object>(value: T): T {
  const ref = useRef<T | null>(null);
  const prev = ref.current;
  if (prev === null) {
    ref.current = value;
    return value;
  }
  // Same object handed back (e.g. a hoisted literal): nothing to compare.
  if (prev === value) return prev;

  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(value);
  let unchanged = prevKeys.length === nextKeys.length;
  if (unchanged) {
    for (const key of nextKeys) {
      if (
        !Object.is(
          (prev as Record<string, unknown>)[key],
          (value as Record<string, unknown>)[key]
        )
      ) {
        unchanged = false;
        break;
      }
    }
  }
  if (unchanged) return prev;

  ref.current = value;
  return value;
}
