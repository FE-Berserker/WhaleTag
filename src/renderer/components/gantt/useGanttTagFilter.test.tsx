/**
 * `useGanttTagFilter` tests — exercises the hook through a probe
 * component so the React state lifecycle is real (mount → setState →
 * re-render → effect re-runs). Matches the codebase's existing test
 * style: node:test + global-jsdom + @testing-library/react (no
 * `renderHook` from React 18's testing utilities, since no other file
 * in the repo uses it).
 *
 * What we lock down:
 *   1. Default: ALL knownValues are selected (no filtering on first
 *      mount). Tag-less rows pass in the neutral state, but become
 *      hidden the moment the user narrows the filter.
 *   2. `toggle(value)` flips membership + persists to localStorage.
 *   3. `setAll(values)` replaces wholesale + persists.
 *   4. Persistence round-trip: reload the hook (unmount + remount)
 *      with the same localStorage → selection restored from persisted
 *      prefs.
 *   5. Auto-include: a newly-known value (added to `knownValues`
 *      after mount) is auto-added to the selection on the next render
 *      — even if the persisted prefs pre-date it. Un-selected values
 *      stay un-selected across `knownValues` growth.
 *   6. `passes` predicate edge cases:
 *      - entry with no known-value tag → passes ONLY in neutral state
 *      - entry whose only known-value tag is NOT selected → fails
 *      - entry whose known-value tag IS selected → passes
 *      - entry with stale (removed) value → passes (ignored)
 *   7. Non-ASCII values (Chinese workflow stages, Japanese tags, etc.)
 *      match via strict equality — no accidental .toLowerCase() or
 *      .normalize() sneaks in.
 *
 * What we DON'T test:
 *   - The "all filtered out" Alert render in GanttView — that's a
 *     GanttView integration test, not a hook test.
 *   - localStorage quota failure path — `writePrefs` swallows it; the
 *     contract is "best effort, never throw", already covered by
 *     `perspective-prefs.test.ts`.
 */
import globalJsdom from 'global-jsdom';

import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, cleanup, render } from '@testing-library/react';
import { forwardRef, useEffect, useImperativeHandle } from 'react';

import { useGanttTagFilter } from './useGanttTagFilter';

const PREFS_KEY = 'whale-task-gantt-filter';

interface ProbeHandle {
  selected: Set<string>;
  toggle: (v: string) => void;
  setAll: (vs: Iterable<string>) => void;
  passes: (tags: readonly string[]) => boolean;
  latestKnownValues: readonly string[];
}

interface ProbeProps {
  key_: 'workflow' | 'quadrant';
  knownValues: readonly string[];
}

/** Tiny probe that exposes the hook's return value + a few action
 *  buttons onto a ref, so tests can read state and trigger toggles
 *  without coupling to DOM structure. Uses forwardRef + useImperative
 *  to expose the live hook state without re-rendering on every
 *  toggle (the test then reads `ref.current` synchronously after
 *  `act()`). */
const Probe = forwardRef<ProbeHandle, ProbeProps>(function Probe(
  { key_, knownValues },
  ref
) {
  const filter = useGanttTagFilter<string>(key_, knownValues);

  // Mirror the latest state into the imperative handle so tests can
  // read it after `act(() => filter.toggle(...))` synchronously.
  // useImperativeHandle with no deps re-creates every render —
  // fine for tests, keeps the read-site trivial.
  useImperativeHandle(
    ref,
    () => ({
      get selected() {
        return filter.selected;
      },
      toggle: filter.toggle,
      setAll: filter.setAll,
      passes: filter.passes,
      latestKnownValues: knownValues,
    }),
    [filter, knownValues]
  );

  // useEffect is here only so React mounts the component (forwardRef
  // alone doesn't trigger effects without an imperative ref consumer).
  useEffect(() => {}, []);

  return null;
});

// Helper: render the probe and return its current handle value.
// `handleRef` is a plain object (not a `useRef` hook result) because
// `mountProbe` is called outside any component — `useRef` is illegal
// here. The forwardRef'd `Probe` populates `.current` via
// `useImperativeHandle` during render.
function mountProbe(key_: 'workflow' | 'quadrant', knownValues: readonly string[]) {
  const handleRef: { current: ProbeHandle | null } = { current: null };
  const utils = render(
    <Probe key_={key_} knownValues={knownValues} ref={handleRef as any} />
  );
  // The useImperativeHandle runs synchronously during render in React
  // 18's testing environment; assert it populated before tests read.
  assert.ok(handleRef.current, 'probe did not mount');
  return { ref: handleRef, utils };
}

before(() => {
  globalJsdom();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// ─── Defaults ───────────────────────────────────────────────────────

describe('useGanttTagFilter defaults', () => {
  it('selects all known values on first mount (no persisted prefs)', () => {
    const { ref } = mountProbe('workflow', ['not-started', 'in-progress', 'completed']);
    assert.deepEqual(
      Array.from(ref.current.selected).sort(),
      ['completed', 'in-progress', 'not-started']
    );
  });

  it('passes any entry whose tag is in the selection', () => {
    const { ref } = mountProbe('workflow', ['not-started', 'in-progress']);
    assert.equal(ref.current.passes(['in-progress']), true);
  });

  it('passes entries with no known-value tag in the neutral filter state', () => {
    // Default state (all known values selected): tag-less rows pass.
    // The user just opened Gantt — they expect to see everything.
    const { ref } = mountProbe('workflow', ['in-progress']);
    // Entry has 'idea' but workflow doesn't know about 'idea' → pass
    // because the filter is neutral (size of selected = length of
    // knownValues).
    assert.equal(ref.current.passes(['idea', 'urgent-important']), true);
  });

  it('hides tag-less entries once the user narrows the filter', () => {
    // The moment the user un-selects ANY value, tag-less rows stop
    // matching the filter criteria and become hidden. Otherwise
    // "show me only in-progress" would also surface rows that aren't
    // in any stage — the opposite of what the user asked for.
    const { ref } = mountProbe('workflow', ['not-started', 'in-progress']);
    assert.equal(ref.current.passes(['idea']), true); // neutral: passes
    act(() => ref.current.toggle('not-started'));
    assert.equal(ref.current.passes(['idea']), false); // narrowed: hidden
  });

  it('tag-less rows pass again after the user resets selection', () => {
    // Reset = back to "all selected" = neutral again.
    const { ref } = mountProbe('workflow', ['a', 'b']);
    act(() => ref.current.toggle('a'));
    assert.equal(ref.current.passes(['idea']), false);
    act(() => ref.current.setAll(['a', 'b']));
    assert.equal(ref.current.passes(['idea']), true);
  });

  it('fails entries whose only known-value tag is NOT selected', () => {
    const { ref } = mountProbe('workflow', ['not-started', 'in-progress']);
    // No persisted prefs → both are selected. Add a tag the workflow
    // filter DOESN'T know about but that we then un-select via toggle.
    act(() => ref.current.toggle('not-started'));
    assert.equal(ref.current.passes(['not-started']), false);
  });

  it('ignores stale (removed) values — entry with orphan tag still passes', () => {
    const { ref } = mountProbe('workflow', ['in-progress']);
    // 'archived' was a workflow stage in some past version; it's no
    // longer in `knownValues`. The predicate must NOT match against
    // it (otherwise removing a stage could hide unrelated entries).
    assert.equal(ref.current.passes(['archived']), true);
  });
});

// ─── toggle ─────────────────────────────────────────────────────────

describe('useGanttTagFilter.toggle', () => {
  it('flips membership', () => {
    const { ref } = mountProbe('workflow', ['in-progress', 'completed']);
    assert.equal(ref.current.selected.has('in-progress'), true);
    act(() => ref.current.toggle('in-progress'));
    assert.equal(ref.current.selected.has('in-progress'), false);
    act(() => ref.current.toggle('in-progress'));
    assert.equal(ref.current.selected.has('in-progress'), true);
  });

  it('persists to localStorage under the family-specific field', () => {
    const { ref } = mountProbe('workflow', ['in-progress']);
    act(() => ref.current.toggle('in-progress'));
    const raw = localStorage.getItem(PREFS_KEY);
    assert.ok(raw, 'expected localStorage write');
    const parsed = JSON.parse(raw!);
    // Only the toggled dimension is stored; the other is `undefined`.
    assert.deepEqual(parsed.workflow, []);
    assert.equal(parsed.quadrant, undefined);
  });

  it('passes() reflects the new state immediately after toggle', () => {
    const { ref } = mountProbe('workflow', ['in-progress']);
    assert.equal(ref.current.passes(['in-progress']), true);
    act(() => ref.current.toggle('in-progress'));
    assert.equal(ref.current.passes(['in-progress']), false);
  });

  it('does not interfere with the OTHER family under the same key', () => {
    // Mount workflow, toggle something. Then mount quadrant under a
    // fresh probe → it should default to its own knownValues, NOT
    // inherit the workflow toggle.
    const { ref: w } = mountProbe('workflow', ['a', 'b']);
    act(() => w.current.toggle('a'));
    const { ref: q } = mountProbe('quadrant', ['x', 'y']);
    assert.deepEqual(Array.from(q.current.selected).sort(), ['x', 'y']);
  });
});

// ─── setAll ─────────────────────────────────────────────────────────

describe('useGanttTagFilter.setAll', () => {
  it('replaces the selection wholesale', () => {
    const { ref } = mountProbe('workflow', ['a', 'b', 'c']);
    act(() => ref.current.setAll(['b']));
    assert.deepEqual(Array.from(ref.current.selected), ['b']);
  });

  it('persists after setAll', () => {
    const { ref } = mountProbe('workflow', ['a', 'b']);
    act(() => ref.current.setAll(['a']));
    const parsed = JSON.parse(localStorage.getItem(PREFS_KEY)!);
    assert.deepEqual(parsed.workflow, ['a']);
  });
});

// ─── Persistence round-trip ────────────────────────────────────────

describe('useGanttTagFilter persistence', () => {
  it('reads persisted selection on remount', () => {
    // Mount, narrow to 'in-progress' only, then unmount.
    const { ref, utils } = mountProbe('workflow', ['not-started', 'in-progress', 'completed']);
    act(() => ref.current.setAll(['in-progress']));
    utils.unmount();
    // Remount — should restore the narrowed selection, NOT default
    // to "all known".
    const { ref: ref2 } = mountProbe('workflow', ['not-started', 'in-progress', 'completed']);
    assert.deepEqual(Array.from(ref2.current.selected), ['in-progress']);
  });

  it('drops garbage from localStorage and falls back to defaults', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ workflow: 'not an array' }));
    const { ref } = mountProbe('workflow', ['a', 'b']);
    assert.deepEqual(Array.from(ref.current.selected).sort(), ['a', 'b']);
  });

  it('drops non-string entries from localStorage', () => {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ workflow: ['a', 42, null, 'b'] })
    );
    const { ref } = mountProbe('workflow', ['a', 'b', 'c']);
    assert.deepEqual(Array.from(ref.current.selected).sort(), ['a', 'b']);
  });
});

// ─── Auto-include new knownValues ──────────────────────────────────

describe('useGanttTagFilter auto-include', () => {
  it('adds a newly-known value to the selection automatically', () => {
    // Mount with a narrow selection persisted (only 'in-progress').
    localStorage.setItem(PREFS_KEY, JSON.stringify({ workflow: ['in-progress'] }));
    const { ref, utils } = mountProbe('workflow', ['in-progress']);
    assert.deepEqual(Array.from(ref.current.selected), ['in-progress']);

    // Now the user adds a new workflow stage 'reviewing'. The parent
    // re-renders with the extended knownValues list. The hook must
    // auto-include 'reviewing' so the new entries aren't hidden by
    // default.
    utils.rerender(<Probe key_="workflow" knownValues={['in-progress', 'reviewing']} ref={ref} />);
    assert.deepEqual(Array.from(ref.current.selected).sort(), ['in-progress', 'reviewing']);
  });

  it('does NOT remove a value the user un-selected just because knownValues grew', () => {
    const { ref, utils } = mountProbe('workflow', ['a', 'b', 'c']);
    act(() => ref.current.toggle('b'));
    assert.deepEqual(Array.from(ref.current.selected).sort(), ['a', 'c']);
    utils.rerender(<Probe key_="workflow" knownValues={['a', 'b', 'c', 'd']} ref={ref} />);
    assert.deepEqual(Array.from(ref.current.selected).sort(), ['a', 'c', 'd']);
  });
});

// ─── Chinese / non-ASCII value handling ─────────────────────────────
// Workflow stages can be user-defined (any string), so the hook must
// match Chinese tokens identically. Set.has + JSON.stringify are both
// Unicode-safe; these tests lock that down so a future refactor
// doesn't accidentally introduce a case-fold or .toLowerCase() that
// would break 汉字 / ひらがな values.

describe('useGanttTagFilter non-ASCII values', () => {
  it('matches Chinese workflow tokens via strict equality', () => {
    const { ref } = mountProbe('workflow', ['进行中', '已完成', '未开始']);
    assert.equal(ref.current.passes(['进行中']), true);
    assert.equal(ref.current.passes(['已完成']), true);
    assert.equal(ref.current.passes(['未开始']), true);
  });

  it('toggle Chinese tokens writes the correct value to localStorage', () => {
    const { ref } = mountProbe('workflow', ['进行中', '已完成']);
    act(() => ref.current.toggle('进行中'));
    const parsed = JSON.parse(localStorage.getItem(PREFS_KEY)!);
    // Only the toggled dimension is stored; the array has the
    // *remaining* selected values.
    assert.deepEqual(parsed.workflow, ['已完成']);
  });

  it('persists Chinese values through a remount round-trip', () => {
    const { ref, utils } = mountProbe('workflow', ['进行中', '已完成', '未开始']);
    act(() => ref.current.setAll(['进行中', '已完成']));
    utils.unmount();
    const { ref: ref2 } = mountProbe('workflow', ['进行中', '已完成', '未开始']);
    assert.deepEqual(Array.from(ref2.current.selected).sort(), ['已完成', '进行中']);
  });

  it('narrowed filter hides Chinese tag-less rows (same rule as ASCII)', () => {
    const { ref } = mountProbe('workflow', ['进行中', '已完成']);
    // Neutral: tag-less row passes.
    assert.equal(ref.current.passes(['无标签']), true);
    // Narrow: tag-less row hidden.
    act(() => ref.current.toggle('进行中'));
    assert.equal(ref.current.passes(['无标签']), false);
  });

  it('does not conflate visually similar tokens (已 vs 未 / period)', () => {
    // Two different Chinese tokens that share characters but differ
    // by a single character (已 vs 未) or include punctuation. Strict
    // equality must NOT match them across — a sloppy .includes() or
    // partial-match would. Locks down the Set.has semantics.
    const { ref } = mountProbe('workflow', ['已完成', '完成。']);
    assert.equal(ref.current.passes(['已完成']), true);
    assert.equal(ref.current.passes(['完成。']), true);
    act(() => ref.current.toggle('已完成'));
    // Now 已完成 is not selected but 完成。 is.
    assert.equal(ref.current.passes(['已完成']), false);
    assert.equal(ref.current.passes(['完成。']), true);
  });
});
