/**
 * `useBarDrag` state-machine tests (Tasks §9.3 — required before P0 #4
 * keyboard navigation lands).
 *
 * What we lock down:
 *  1. idle → pending → idle (click path): pointerdown + immediate
 *     pointerup, no movement → onClick fires; onCommit does NOT.
 *  2. idle → pending → dragging → idle (commit path): pointerdown +
 *     pointermove that crosses `DRAG_PENDING_THRESHOLD_PX` + pointerup
 *     → onCommit fires with the right `periodWithShift` arithmetic
 *     applied; onClick does NOT.
 *  3. dragging + Escape: clears preview without committing.
 *  4. readOnly: pointerdown is a no-op (no state change, no callbacks).
 *  5. Non-left button / modifier keys: pointerdown is a no-op.
 *  6. Commit skips when the resolved period equals the start period
 *     (a "drag back to where we started" should not write).
 *
 * Test infrastructure mirrors `useGanttTagFilter.test.tsx` —
 * node:test + global-jsdom + @testing-library/react + a Probe
 * component that exposes the hook's return value via
 * `useImperativeHandle`. We render a real <div> with the
 * onPointerDown/onPointerUp handlers wired so React's synthetic
 * dispatcher populates `currentTarget`, and dispatch native
 * PointerEvents on it so the hook's `setPointerCapture` / window
 * listeners all see the right element.
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
  type CSSProperties,
} from 'react';

import { useBarDrag, type DragKind } from './useBarDrag';
import type { GanttPeriod } from '../../domain/gantt';

interface CommitRecord {
  path: string;
  next: GanttPeriod;
}

interface ClickRecord {
  path: string;
  clientX: number;
  clientY: number;
}

interface ProbeHandle {
  el: HTMLDivElement | null;
  commits: CommitRecord[];
  clicks: ClickRecord[];
  isDragging: boolean;
  previewStyle: CSSProperties | null;
}

interface ProbeProps {
  entryPath: string;
  period: GanttPeriod;
  readOnly: boolean;
  pxPerDay: number;
  scaleStartKey: string;
  scaleTotalDays: number;
  /** Lock the drag to a single zone; tests that need a multi-zone
   *  probe can override. Default body is what the bar's hit-zones
   *  delegate to most often. */
  zone?: DragKind;
}

/** Probe that wires useBarDrag onto a real <div> and exposes the
 *  underlying DOM node plus a callback log so tests can dispatch
 *  events and assert side-effects synchronously.
 *
 *  Subtle but important: the handle exposes `isDragging` /
 *  `previewStyle` via refs that are *synced on every render*, NOT
 *  via direct capture of the hook return value. Earlier versions of
 *  this test captured `drag.isDragging` in a useImperativeHandle
 *  closure, which meant once `ref.current` was assigned at mount,
 *  subsequent re-renders produced a fresh handle object that the
 *  test (which captures `handle = ref.current!` once) never saw.
 *  Tests would read STALE values. Reading through refs makes the
 *  handle stable while the values stay live. */
const Probe = forwardRef<ProbeHandle, ProbeProps>(function Probe(props, ref) {
  const {
    entryPath,
    period,
    readOnly,
    pxPerDay,
    scaleStartKey,
    scaleTotalDays,
    zone = 'body',
  } = props;
  const commitsRef = useRef<CommitRecord[]>([]);
  const clicksRef = useRef<ClickRecord[]>([]);
  const elRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef(false);
  const previewStyleRef = useRef<CSSProperties | null>(null);

  const drag = useBarDrag({
    entryPath,
    period,
    readOnly,
    pxPerDay,
    scaleStartKey,
    scaleTotalDays,
    onCommit: (path, next) => commitsRef.current.push({ path, next }),
    onClick: (path, e) =>
      clicksRef.current.push({
        path,
        clientX: (e as unknown as PointerEvent).clientX ?? 0,
        clientY: (e as unknown as PointerEvent).clientY ?? 0,
      }),
  });

  // Sync hook output into refs on every render. The handle reads
  // through these refs so it stays live even though the handle object
  // itself is created once.
  isDraggingRef.current = drag.isDragging;
  previewStyleRef.current = drag.previewStyle;

  useImperativeHandle(
    ref,
    () => ({
      get el() {
        return elRef.current;
      },
      get commits() {
        return commitsRef.current;
      },
      get clicks() {
        return clicksRef.current;
      },
      get isDragging() {
        return isDraggingRef.current;
      },
      get previewStyle() {
        return previewStyleRef.current;
      },
    }),
    [] // Stable handle — values flow through refs above.
  );

  // useEffect just keeps React from complaining about the imperative
  // handle being unused.
  useEffect(() => {}, []);

  return (
    <div
      ref={elRef}
      data-testid="probe-bar"
      data-entry-path={entryPath}
      style={{ width: 200, height: 28, userSelect: 'none', touchAction: 'none' }}
      onPointerDown={(e) => drag.onPointerDown(e, zone)}
      onPointerUp={(e) => drag.onPointerUp(e, zone)}
    />
  );
});

// ── Helpers ────────────────────────────────────────────────────────────

const PERIOD_A: GanttPeriod = { startKey: '2026-07-01', endKey: '2026-07-05' };
const SCALE_START = '2026-06-01';
const SCALE_TOTAL_DAYS = 90;
const PX_PER_DAY = 20;

/** Minimum pointermove distance that triggers the pending→dragging
 *  transition. Mirrors `DRAG_PENDING_THRESHOLD_PX` in renderer/domain/gantt.ts
 *  — keep this in sync if the threshold ever changes. */
const THRESHOLD_PX = 4;

function renderProbe(overrides: Partial<ProbeProps> = {}) {
  const ref = { current: null as ProbeHandle | null };
  const utils = render(
    <Probe
      ref={ref as unknown as React.Ref<ProbeHandle>}
      entryPath="/a.txt"
      period={PERIOD_A}
      readOnly={false}
      pxPerDay={PX_PER_DAY}
      scaleStartKey={SCALE_START}
      scaleTotalDays={SCALE_TOTAL_DAYS}
      {...overrides}
    />
  );
  const handle = ref.current!;
  assert.ok(handle.el, 'probe bar element must be present');
  return { handle, ...utils };
}

/** Dispatch a native pointermove that the hook's element-level listener
 *  (if attached) WILL pick up — same element as pointerdown. */
function dispatchPointerMove(el: Element, clientX: number, clientY = 10) {
  const ev = new PointerEvent('pointermove', {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    button: 0,
  });
  act(() => {
    el.dispatchEvent(ev);
  });
}

/** Window-level pointerup — the hook listens here once dragging. */
function dispatchWindowPointerUp(clientX = 0, clientY = 0) {
  const ev = new PointerEvent('pointerup', {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    button: 0,
  });
  act(() => {
    window.dispatchEvent(ev);
  });
}

function dispatchWindowKey(key: string) {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true });
  act(() => {
    window.dispatchEvent(ev);
  });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('useBarDrag state machine', () => {
  let cleanupJsdom: (() => void) | undefined;
  before(() => {
    cleanupJsdom = globalJsdom();
  });
  afterEach(() => {
    cleanup();
  });

  it('#1 click path: pointerdown + immediate pointerup fires onClick, NOT onCommit', () => {
    const { handle } = renderProbe();
    const el = handle.el!;
    act(() => {
      fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 10 });
    });
    act(() => {
      fireEvent.pointerUp(el, { button: 0, clientX: 100, clientY: 10 });
    });
    assert.equal(handle.clicks.length, 1, 'onClick should fire exactly once');
    assert.equal(handle.clicks[0].path, '/a.txt');
    assert.equal(handle.commits.length, 0, 'onCommit must NOT fire on click');
    assert.equal(handle.isDragging, false);
    assert.equal(handle.previewStyle, null);
  });

  it('#2 drag path: pointerdown + pointermove (>= threshold) + pointerup commits the shifted period', () => {
    const { handle } = renderProbe();
    const el = handle.el!;
    // Down at clientX=100, move +20px (= 1 day at PX_PER_DAY=20), release.
    act(() => {
      fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 10 });
    });
    dispatchPointerMove(el, 100 + THRESHOLD_PX + (PX_PER_DAY - THRESHOLD_PX));
    // After crossing the threshold the hook flips to dragging — preview
    // should reflect the shifted period.
    assert.equal(handle.isDragging, true, 'should be dragging after threshold cross');
    assert.notEqual(handle.previewStyle, null, 'previewStyle should be set');
    dispatchWindowPointerUp();
    assert.equal(handle.commits.length, 1, 'onCommit should fire once');
    assert.equal(handle.commits[0].path, '/a.txt');
    // +20px / 20px-per-day = +1 day → start 2026-07-01 → 2026-07-02,
    // end 2026-07-05 → 2026-07-06.
    assert.equal(handle.commits[0].next.startKey, '2026-07-02');
    assert.equal(handle.commits[0].next.endKey, '2026-07-06');
    assert.equal(handle.clicks.length, 0, 'click must NOT fire after a real drag');
    assert.equal(handle.isDragging, false);
  });

  it('#2b drag stays committed after preview is cleared (post-commit idle)', () => {
    const { handle } = renderProbe();
    const el = handle.el!;
    act(() => {
      fireEvent.pointerDown(el, { button: 0, clientX: 50, clientY: 10 });
    });
    dispatchPointerMove(el, 50 + 5 * PX_PER_DAY); // +5 days
    dispatchWindowPointerUp();
    assert.equal(handle.commits.length, 1);
    assert.equal(handle.isDragging, false);
    assert.equal(handle.previewStyle, null);
  });

  it('#3 Escape during drag clears preview and commits nothing', () => {
    const { handle } = renderProbe();
    const el = handle.el!;
    act(() => {
      fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 10 });
    });
    dispatchPointerMove(el, 100 + THRESHOLD_PX + 3 * PX_PER_DAY); // +3 days
    assert.equal(handle.isDragging, true);
    dispatchWindowKey('Escape');
    assert.equal(handle.commits.length, 0, 'Escape must cancel the drag');
    assert.equal(handle.isDragging, false);
    assert.equal(handle.previewStyle, null);
  });

  it('#4 readOnly blocks pointerdown entirely', () => {
    const { handle } = renderProbe({ readOnly: true });
    const el = handle.el!;
    act(() => {
      fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 10 });
    });
    dispatchPointerMove(el, 100 + 5 * PX_PER_DAY);
    act(() => {
      fireEvent.pointerUp(el, { button: 0, clientX: 100, clientY: 10 });
    });
    assert.equal(handle.clicks.length, 0);
    assert.equal(handle.commits.length, 0);
    assert.equal(handle.isDragging, false);
  });

  it('#5a non-left button is ignored on pointerdown', () => {
    const { handle } = renderProbe();
    const el = handle.el!;
    act(() => {
      fireEvent.pointerDown(el, { button: 2, clientX: 100, clientY: 10 }); // right-click
    });
    act(() => {
      fireEvent.pointerUp(el, { button: 2, clientX: 100, clientY: 10 });
    });
    assert.equal(handle.clicks.length, 0);
    assert.equal(handle.commits.length, 0);
  });

  it('#5b modifier keys (Ctrl/Meta/Shift) on pointerdown are ignored', () => {
    const { handle } = renderProbe();
    const el = handle.el!;
    act(() => {
      fireEvent.pointerDown(el, {
        button: 0,
        clientX: 100,
        clientY: 10,
        ctrlKey: true,
      });
    });
    act(() => {
      fireEvent.pointerUp(el, { button: 0, clientX: 100, clientY: 10 });
    });
    assert.equal(handle.clicks.length, 0);
    assert.equal(handle.commits.length, 0);
  });

  it('#6 commit skips when resolved period equals start period (sub-day drag)', () => {
    // The `periodsEqual` gate inside window-level `onUp` skips
    // `onCommit` when the final period equals the period at hook call
    // time. The simplest way to trigger it: move just past
    // DRAG_PENDING_THRESHOLD_PX but with a delta that rounds to 0
    // days at the current pxPerDay. With PX_PER_DAY=20 and threshold=4,
    // moving 5px crosses the threshold (5 > 4) but Math.round(5/20) = 0,
    // so the resolved period is unchanged.
    const { handle } = renderProbe();
    const el = handle.el!;
    act(() => {
      fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 10 });
    });
    dispatchPointerMove(el, 100 + THRESHOLD_PX + 1); // crosses threshold, 0-day shift
    assert.equal(handle.isDragging, true, 'should be dragging after threshold cross');
    dispatchWindowPointerUp();
    assert.equal(handle.commits.length, 0, 'no-commit when period unchanged');
    assert.equal(handle.isDragging, false);
  });
});