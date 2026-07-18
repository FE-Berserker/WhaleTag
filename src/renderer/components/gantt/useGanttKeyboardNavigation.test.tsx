/**
 * `useGanttKeyboardNavigation` tests — P0 #4.
 *
 * What we lock down (5 keys × 2 paths):
 *  1. ↑↓ — vertical traversal across `paths`, wrap-around at ends.
 *  2. ← → — ±1 day shift, routed through `onCommit` (NOT silent).
 *  3. Space — invokes `onActivate(path)` (PeriodTagDialog path).
 *  4. T — invokes `onJumpToToday`.
 *  5. Esc — clears focusedPath.
 *  Plus:
 *  - No focused bar → all keys except T are no-ops (T always works).
 *  - readOnly → commits / activates are no-ops; arrows still move
 *    focus so a11y navigation isn't blocked.
 *  - Ctrl/Meta/Alt modified arrows → no-op (don't fight browser shortcuts).
 *  - `tabIndexFor` returns 0 for focused, -1 for others.
 */
import globalJsdom from 'global-jsdom';

import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';

import { useGanttKeyboardNavigation } from './useGanttKeyboardNavigation';
import type { GanttPeriod } from '../../domain/gantt';

interface ProbeHandle {
  // Reads (live, via refs so post-render state is correct).
  focusedPath: string | null;
  tabIndexFor: (p: string) => number;
  // Call site for keydown handler.
  onKeyDown: (e: React.KeyboardEvent) => void;
  // Spy records for assertions.
  commits: { path: string; next: GanttPeriod }[];
  activates: string[];
  jumpToTodayCalls: number;
}

interface ProbeProps {
  paths: readonly string[];
  getPeriod: (entryPath: string) => GanttPeriod | undefined;
  readOnly?: boolean;
}

const Probe = forwardRef<ProbeHandle, ProbeProps>(function Probe(props, ref) {
  const { paths, getPeriod, readOnly = false } = props;
  const commitsRef = useRef<{ path: string; next: GanttPeriod }[]>([]);
  const activatesRef = useRef<string[]>([]);
  const jumpRef = useRef(0);

  const nav = useGanttKeyboardNavigation({
    paths,
    getPeriod,
    readOnly,
    onCommit: (entryPath, next) =>
      commitsRef.current.push({ path: entryPath, next }),
    onActivate: (entryPath) => activatesRef.current.push(entryPath),
    onJumpToToday: () => {
      jumpRef.current += 1;
    },
  });

  // Mirror to refs so the handle reads live values, not snapshots from
  // the render at which the test captured `handle` (same pattern
  // useBarDrag.test.tsx uses — see the comment block there).
  const focusedPathRef = useRef<string | null>(null);
  const onKeyDownRef = useRef<(e: React.KeyboardEvent) => void>(() => {});
  const tabIndexForRef = useRef<(p: string) => number>(() => -1);
  focusedPathRef.current = nav.focusedPath;
  onKeyDownRef.current = nav.onKeyDown;
  tabIndexForRef.current = nav.tabIndexFor;

  useImperativeHandle(
    ref,
    () => ({
      get focusedPath() {
        return focusedPathRef.current;
      },
      tabIndexFor: (p) => tabIndexForRef.current(p),
      onKeyDown: (e) => onKeyDownRef.current(e),
      get commits() {
        return commitsRef.current;
      },
      get activates() {
        return activatesRef.current;
      },
      get jumpToTodayCalls() {
        return jumpRef.current;
      },
    }),
    []
  );

  useEffect(() => {}, []);
  return null;
});

/** Helper: build a minimal React.KeyboardEvent-like object the hook
 *  can consume. Only the fields the hook reads (`key`, modifier flags,
 *  `preventDefault`) need to be populated. */
function keyEvent(
  key: string,
  opts: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}
): React.KeyboardEvent {
  const prevented = { defaultPrevented: false };
  return {
    key,
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: opts.metaKey ?? false,
    altKey: opts.altKey ?? false,
    preventDefault: () => {
      prevented.defaultPrevented = true;
    },
  } as unknown as React.KeyboardEvent;
}

const PATHS = ['/a.txt', '/b.txt', '/c.txt'];
const PERIOD_A: GanttPeriod = { startKey: '2026-07-01', endKey: '2026-07-05' };
const PERIOD_B: GanttPeriod = { startKey: '2026-07-03', endKey: '2026-07-08' };
const PERIOD_C: GanttPeriod = { startKey: '2026-07-10', endKey: '2026-07-12' };
const PERIODS_BY_PATH: Record<string, GanttPeriod> = {
  '/a.txt': PERIOD_A,
  '/b.txt': PERIOD_B,
  '/c.txt': PERIOD_C,
};

function getPeriod(path: string): GanttPeriod | undefined {
  return PERIODS_BY_PATH[path];
}

describe('useGanttKeyboardNavigation', () => {
  let cleanupJsdom: (() => void) | undefined;
  before(() => {
    cleanupJsdom = globalJsdom();
  });
  afterEach(() => {
    cleanup();
  });

  function setup(overrides: Partial<ProbeProps> = {}) {
    const ref = { current: null as ProbeHandle | null };
    render(
      <Probe
        ref={ref as unknown as React.Ref<ProbeHandle>}
        paths={overrides.paths ?? PATHS}
        getPeriod={overrides.getPeriod ?? getPeriod}
        readOnly={overrides.readOnly ?? false}
      />
    );
    return ref.current!;
  }

  // ─── Vertical traversal ─────────────────────────────────────────────

  it('#1 ArrowDown from no-focus focuses first path', () => {
    const h = setup();
    act(() => {
      h.onKeyDown(keyEvent('ArrowDown'));
    });
    assert.equal(h.focusedPath, '/a.txt');
  });

  it('#2 ArrowDown advances through paths and wraps at end', () => {
    const h = setup();
    // Each keypress needs its own act() so React re-renders between
    // calls and the hook's onKeyDown closure sees the latest
    // focusedPath. (Real keyboard events arrive one at a time.)
    act(() => h.onKeyDown(keyEvent('ArrowDown'))); // /a.txt
    act(() => h.onKeyDown(keyEvent('ArrowDown'))); // /b.txt
    act(() => h.onKeyDown(keyEvent('ArrowDown'))); // /c.txt
    act(() => h.onKeyDown(keyEvent('ArrowDown'))); // wrap → /a.txt
    assert.equal(h.focusedPath, '/a.txt');
  });

  it('#3 ArrowUp from first wraps to last', () => {
    const h = setup();
    act(() => {
      h.onKeyDown(keyEvent('ArrowUp')); // /c.txt (wrap)
    });
    assert.equal(h.focusedPath, '/c.txt');
  });

  // ─── Horizontal shift ──────────────────────────────────────────────

  it('#4 ArrowRight on focused bar commits periodWithShift(period, +1)', () => {
    const h = setup();
    act(() => {
      h.onKeyDown(keyEvent('ArrowDown')); // focus /a.txt
    });
    act(() => {
      h.onKeyDown(keyEvent('ArrowRight'));
    });
    assert.equal(h.commits.length, 1);
    assert.equal(h.commits[0].path, '/a.txt');
    assert.equal(h.commits[0].next.startKey, '2026-07-02');
    assert.equal(h.commits[0].next.endKey, '2026-07-06');
  });

  it('#5 ArrowLeft commits periodWithShift(period, -1)', () => {
    const h = setup();
    act(() => {
      h.onKeyDown(keyEvent('ArrowDown')); // /a.txt
    });
    act(() => {
      h.onKeyDown(keyEvent('ArrowLeft'));
    });
    assert.equal(h.commits.length, 1);
    assert.equal(h.commits[0].path, '/a.txt');
    assert.equal(h.commits[0].next.startKey, '2026-06-30');
    assert.equal(h.commits[0].next.endKey, '2026-07-04');
  });

  it('#6 ArrowRight on no-focused is a no-op (no commit)', () => {
    const h = setup();
    act(() => {
      h.onKeyDown(keyEvent('ArrowRight'));
    });
    assert.equal(h.commits.length, 0);
  });

  // ─── Activate / jumpToToday ────────────────────────────────────────

  it('#7 Space invokes onActivate(focusedPath)', () => {
    const h = setup();
    act(() => {
      h.onKeyDown(keyEvent('ArrowDown')); // focus /a.txt
    });
    act(() => {
      h.onKeyDown(keyEvent(' '));
    });
    assert.deepEqual(h.activates, ['/a.txt']);
  });

  it("#8 'T' invokes onJumpToToday regardless of focus", () => {
    const h = setup();
    act(() => {
      h.onKeyDown(keyEvent('T'));
    });
    assert.equal(h.jumpToTodayCalls, 1);
  });

  // ─── Escape ────────────────────────────────────────────────────────

  it('#9 Escape clears the focused path', () => {
    const h = setup();
    act(() => {
      h.onKeyDown(keyEvent('ArrowDown')); // /a.txt
    });
    assert.equal(h.focusedPath, '/a.txt');
    act(() => {
      h.onKeyDown(keyEvent('Escape'));
    });
    assert.equal(h.focusedPath, null);
  });

  // ─── readOnly / modifier guards ────────────────────────────────────

  it('#10 readOnly blocks commits / activates but allows focus moves', () => {
    const h = setup({ readOnly: true });
    act(() => {
      h.onKeyDown(keyEvent('ArrowDown')); // focus /a.txt
    });
    assert.equal(h.focusedPath, '/a.txt', 'focus should still move');
    act(() => {
      h.onKeyDown(keyEvent('ArrowRight'));
    });
    assert.equal(h.commits.length, 0, 'readOnly blocks commit');
    act(() => {
      h.onKeyDown(keyEvent(' '));
    });
    assert.equal(h.activates.length, 0, 'readOnly blocks activate');
  });

  it('#11 Ctrl+ArrowRight is a no-op (browser-shortcut safety)', () => {
    const h = setup();
    act(() => {
      h.onKeyDown(keyEvent('ArrowDown')); // focus
    });
    act(() => {
      h.onKeyDown(keyEvent('ArrowRight', { ctrlKey: true }));
    });
    assert.equal(h.commits.length, 0);
  });

  it('#12 Meta+ArrowRight is a no-op', () => {
    const h = setup();
    act(() => {
      h.onKeyDown(keyEvent('ArrowDown'));
    });
    act(() => {
      h.onKeyDown(keyEvent('ArrowRight', { metaKey: true }));
    });
    assert.equal(h.commits.length, 0);
  });

  // ─── tabIndexFor ───────────────────────────────────────────────────

  it('#13 tabIndexFor: 0 for focused, -1 for others', () => {
    const h = setup();
    act(() => h.onKeyDown(keyEvent('ArrowDown'))); // /a.txt
    act(() => h.onKeyDown(keyEvent('ArrowDown'))); // /b.txt
    assert.equal(h.focusedPath, '/b.txt');
    assert.equal(h.tabIndexFor('/b.txt'), 0);
    assert.equal(h.tabIndexFor('/a.txt'), -1);
    assert.equal(h.tabIndexFor('/c.txt'), -1);
  });

  // ─── Empty paths ───────────────────────────────────────────────────

  it('#14 empty paths: every key is a no-op (no crash)', () => {
    const h = setup({ paths: [] });
    act(() => {
      h.onKeyDown(keyEvent('ArrowDown'));
    });
    assert.equal(h.focusedPath, null);
    assert.equal(h.commits.length, 0);
  });
});