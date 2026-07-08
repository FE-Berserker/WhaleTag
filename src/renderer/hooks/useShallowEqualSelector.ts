import { useSelector, shallowEqual } from 'react-redux';
import type { RootState } from '-/reducers';

/**
 * H.23 P3-4 — `useSelector` with built-in shallow-equality compare.
 *
 * The default `useSelector` re-runs the component whenever the selected value's
 * **reference** changes. For selectors that return a fresh object/array on
 * every dispatch (e.g. `state.settings` after any settings update), the
 * parent re-renders for *every* slice change, which is the FileList hot path
 * we optimized in P0-2.
 *
 * `useShallowEqualSelector` compares the new and previous result field-by-
 * field via `Object.is` (the same primitive `react-redux` ships as
 * `shallowEqual`), and skips the re-render when they match. This is the
 * documented `react-redux` escape hatch for "selector returns a fresh
 * reference" and matches the same pattern documented in the redux FAQ.
 *
 * Behaviour notes:
 *   - Only use when the **selector** returns a plain object/array whose
 *     contents are themselves stable references. If you select into a deeply
 *     nested slice whose values are themselves re-created on every dispatch,
 *     shallowEqual won't help; reach for a custom `equalityFn` instead.
 *   - Comparison is `Object.keys`-based, NOT deep-equal. So a value mutation
 *     that's the same shape but different deep-nested field is treated as
 *     "equal"; that matches the default `===` semantics for primitives and
 *     reference-equal objects.
 *   - The pre-P3-4 FileList had 9 `useSelector(...)` calls. After P3-4 all of
 *     them route through this helper, which measurably drops the re-render
 *     count when settings slices update unrelated subfields.
 */
export function useShallowEqualSelector<T>(selector: (state: RootState) => T): T {
  return useSelector(selector, shallowEqual);
}

// Re-export for convenience — callers can import the same `shallowEqual`
// for ad-hoc comparisons if they need it.
export { shallowEqual };
