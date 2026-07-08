/**
 * `useBarDrag` — the Gantt bar pointer-drag state machine.
 *
 * Lives in its own module so it can be reasoned about (and unit-tested)
 * without pulling in MUI / ECharts / DOM layout. The component layer
 * (`GanttBar`) does the hit-zone resolution and the commit delegation;
 * this hook owns the three states and the pointermove/pointerup/keydown
 * listeners.
 *
 * Why refs for the machine (and only one `useState` for the React-visible
 * `previewStyle`): the ECharts-era implementation rebuilt the whole
 * `option` on every `pointermove` via `notMerge: true`, which melted at
 * higher bar counts. The pure-DOM version only needs the moving bar to
 * re-render, and only when its visual style changes — which is exactly
 * what `previewStyle` carries. Drag-internal state stays in refs.
 *
 * State machine:
 *   idle ──pointerdown──▶ pending ──Δ>=pendingThreshold──▶ dragging
 *     ▲                                                       │
 *     └────────pointerup (no commit) / Escape─────────────────┘
 *     └────────pointerup (commit)─────────────────────────────▶ idle
 *
 *   pointerup while `pending` (i.e. moved < pendingThreshold) is treated
 *   as a click — the hook calls `onClick(entryPath)` so the view can
 *   pop the PeriodTagDialog (or whatever per-click action it wants).
 *   Drag-related work is unaffected: any move past pendingThreshold
 *   transitions to `dragging` and on release commits the period via
 *   `onCommit` instead.
 *
 * The hook MUST NOT mutate any value-identity-changing state per move.
 * `entries` / `period` are accepted as args, copied once on down into
 * `lastPeriodRef`, and re-applied on every move via
 * `periodWithShift` / `periodWithResize` (pure functions).
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

import {
  DRAG_PENDING_THRESHOLD_PX,
  MIN_BAR_WIDTH,
  periodWithResize,
  periodWithShift,
  periodsEqual,
  type GanttPeriod,
} from '../../../shared/gantt';

// Why this is a bug fix worth calling out:
// The original hook stored the three-state machine in a ref and tried to
// attach the element-level `pointermove` listener via a `useEffect` whose
// deps were `[preview, pxPerDay, scaleStartKey, scaleTotalDays,
// styleForPeriod]`. Refs don't trigger re-renders, so the effect ran
// once on mount (with state='idle') and bailed — the listener was never
// installed. The pending→dragging transition never fired; every "drag"
// was treated as a click. §9.3 of the roadmap mandated a state-machine
// test file precisely to surface this; writing the tests confirmed it.
// The fix mirrors how pointerup was already handled (wired as a React
// handler, per the comment block in `onPointerUp`): use `useState` for
// the mode so React re-runs the effect on transition, plus a parallel
// `modeRef` so event callbacks (which read at click time) can access
// the latest value without a stale-closure hazard.

export type DragKind = 'body' | 'left' | 'right';

interface UseBarDragArgs {
  entryPath: string;
  period: GanttPeriod;
  readOnly: boolean;
  /** Pixel-per-day at the active zoom. Owned by the timeline, passed in
   *  so the hook stays coordinate-system-agnostic. */
  pxPerDay: number;
  /** Inclusive left edge of the visible time window. */
  scaleStartKey: string;
  /** Total day count of the visible time window (inclusive). */
  scaleTotalDays: number;
  /** Bubbles to `GanttView.data.onSetEntryDateTag` once the drag commits
   *  and the resolved period differs from the start period. */
  onCommit: (path: string, next: GanttPeriod) => void;
  /** Called when the user pressed and released without crossing the
   *  pending threshold (pure click). The view wires this to whatever
   *  per-click action it wants — currently `openPeriodDialog(entry)`
   *  so the user can edit the period without going through the
   *  right-click menu. The `PointerEvent` is forwarded so the view
   *  can position context-aware UI (e.g. anchor the period dialog
   *  near the click point) instead of the MUI default (centered). */
  onClick: (entryPath: string, e: React.PointerEvent) => void;
}

interface UseBarDragResult {
  onPointerDown: (e: React.PointerEvent, zone: DragKind) => void;
  /** React-side pointerup handler. Attached to the bar element so the
   *  click (no-drag) path runs synchronously inside React's event system
   *  — the alternative would be a useEffect-attached native listener that
   *  only re-runs when `preview` / `onClick` / `entryPath` change, and
   *  on a non-drag click none of those deps change, so the listener
   *  never gets installed. Wiring pointerup as a React handler sidesteps
   *  that gap. */
  onPointerUp: (e: React.PointerEvent, zone: DragKind) => void;
  isDragging: boolean;
  /** When non-null, the visual override for the bar's `left` / `width`
   *  derived from the in-flight `lastPeriod`. Null while idle or
   *  pending. */
  previewStyle: CSSProperties | null;
}

type Mode = 'idle' | 'pending' | 'dragging';

export function useBarDrag(args: UseBarDragArgs): UseBarDragResult {
  const {
    period,
    readOnly,
    pxPerDay,
    scaleStartKey,
    scaleTotalDays,
    entryPath,
    onCommit,
    onClick,
  } = args;

  const stateRef = useRef<Mode>('idle');
  const [mode, setMode] = useState<Mode>('idle');
  // Mirror `mode` into a ref so event callbacks (which read state at
  // click-time, not render-time) can access the latest without stale
  // closures. See the file header for why the original refs-only design
  // silently broke the pending→dragging transition.
  stateRef.current = mode;
  const kindRef = useRef<DragKind | null>(null);
  const lastPeriodRef = useRef<GanttPeriod>(period);
  const downXRef = useRef<number>(0);
  const capturedRef = useRef<{ el: HTMLElement; pointerId: number } | null>(
    null
  );

  const [preview, setPreview] = useState<{
    period: GanttPeriod;
    style: CSSProperties;
  } | null>(null);

  const isDragging = preview !== null;

  /** Compute the bar geometry (`{left, width}` in chart-px) from a period
   *  candidate. Pure read-only helper — reused by the initial preview
   *  push and every move. */
  const styleForPeriod = useCallback(
    (p: GanttPeriod): CSSProperties => {
      const startDays = daysSince(scaleStartKey, p.startKey);
      const endDays = daysSince(scaleStartKey, p.endKey);
      const x = startDays * pxPerDay;
      const width = Math.max((endDays - startDays + 1) * pxPerDay, MIN_BAR_WIDTH);
      return { left: x, width };
    },
    [scaleStartKey, pxPerDay]
  );

  /** Reset to idle, releasing pointer capture if any. Unused in the
   *  present flow but kept exported for symmetry with potential future
   *  keyboard / programmatic cancellation paths. */
  const _reset = useCallback(() => {
    stateRef.current = 'idle';
    kindRef.current = null;
    const c = capturedRef.current;
    if (c) {
      try {
        c.el.releasePointerCapture(c.pointerId);
      } catch {
        /* element may have unmounted mid-drag */
      }
      capturedRef.current = null;
    }
    setPreview(null);
  }, []);

  // ─── Element-level pointerdown (the public entry point) ────────────
  const onPointerDown = useCallback(
    (e: React.PointerEvent, zone: DragKind) => {
      if (readOnly) return;
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      const el = e.currentTarget as HTMLElement;
      // Pointer capture is a hint, not a requirement — it's only
      // needed to keep events flowing to the captured element when the
      // pointer drifts outside its bounds. jsdom + synthetic events
      // often can't honor it (no real pointerId), so wrap the call in
      // try/catch and ALWAYS set `capturedRef.current` afterwards:
      // the element-level listener attached by the pending-mode effect
      // gates on `capturedRef.current`, so a missed assignment here
      // would silently kill the drag.
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore — pointer events still fire on the element via
           bubbling even without explicit capture */
      }
      capturedRef.current = { el, pointerId: e.pointerId };
      stateRef.current = 'pending';
      setMode('pending');
      kindRef.current = zone;
      downXRef.current = e.clientX;
      lastPeriodRef.current = period;
    },
    [readOnly, period]
  );

  // ─── Element-level pointerup (synchronous, React-side) ────────────────
  // The pending→idle click transition. Wired as a React handler on the
  // bar so it runs deterministically regardless of useEffect scheduling —
  // a native addEventListener('pointerup') would only attach after a
  // useEffect re-run, which never happens on a non-drag click (none of
  // the effect deps change between pointerdown and a clean pointerup).
  const onPointerUp = useCallback(
    (e: React.PointerEvent, zone: DragKind) => {
      if (readOnly) return;
      if (e.button !== 0) return;
      // Only the zone that captured the pointerdown fires the click;
      // mouse can drift across hit-zones between down and up. Using
      // `kindRef` (the zone captured at down) keeps the click attribution
      // stable.
      void zone;
      if (stateRef.current !== 'pending') return;
      stateRef.current = 'idle';
      setMode('idle');
      kindRef.current = null;
      const cap = capturedRef.current;
      if (cap) {
        try {
          cap.el.releasePointerCapture(cap.pointerId);
        } catch {
          /* element may have unmounted */
        }
        capturedRef.current = null;
      }
      // Pure click (no drag): the view wires this to its onClick handler
      // (currently opens the PeriodTagDialog for editing the entry's
      // period). `entryPath` is captured from the hook's args so the
      // caller doesn't need to thread it through the closure. The
      // PointerEvent is forwarded so the consumer can read clientX/Y
      // for cursor-anchored UI positioning.
      onClick(entryPath, e);
    },
    [readOnly, onClick, entryPath]
  );

  // ─── Element-level pointermove: pending → dragging transition ───────
  // Re-keyed on `mode` (NOT `preview`) so the listener actually
  // attaches when state transitions idle→pending via pointerdown.
  // The original `[preview, ...]` deps were the bug — preview only
  // changes AFTER this listener fires, so the listener was never
  // installed (see file header for the writeup).
  useEffect(() => {
    if (mode !== 'pending') return undefined;
    const c = capturedRef.current;
    if (!c) return undefined;
    const onMove = (ev: PointerEvent) => {
      if (stateRef.current !== 'pending') return;
      const dx = ev.clientX - downXRef.current;
      if (Math.abs(dx) < DRAG_PENDING_THRESHOLD_PX) return;
      stateRef.current = 'dragging';
      setMode('dragging');
      const kind = kindRef.current!;
      const initial = kind === 'body'
        ? periodWithShift(lastPeriodRef.current, Math.round(dx / pxPerDay))
        : computeEdgeResize(
            lastPeriodRef.current,
            kind,
            dx,
            pxPerDay,
            scaleStartKey,
            scaleTotalDays
          );
      lastPeriodRef.current = initial;
      setPreview({ period: initial, style: styleForPeriod(initial) });
    };
    c.el.addEventListener('pointermove', onMove);
    return () => c.el.removeEventListener('pointermove', onMove);
  }, [mode, pxPerDay, scaleStartKey, scaleTotalDays, styleForPeriod]);

  // The element-level pointerup for the click (no-drag) path used to
  // live here as a `useEffect`-attached native listener. That listener
  // never installed on a pure click because the effect's deps
  // (`preview` / `onClick` / `entryPath`) don't change between
  // pointerdown and a clean pointerup — so the click branch was dead
  // code. The replacement is the `onPointerUp` React handler above
  // (returned in `UseBarDragResult`), wired on the bar element so
  // pointerup runs synchronously inside React's event system.

  // ─── Window-level listeners while `dragging` ────────────────────────
  useEffect(() => {
    if (!isDragging) return undefined;
    const kind = kindRef.current!;
    const periodAtStart = lastPeriodRef.current;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - downXRef.current;
      const next =
        kind === 'body'
          ? periodWithShift(periodAtStart, Math.round(dx / pxPerDay))
          : computeEdgeResize(
              periodAtStart,
              kind,
              dx,
              pxPerDay,
              scaleStartKey,
              scaleTotalDays
            );
      lastPeriodRef.current = next;
      setPreview({ period: next, style: styleForPeriod(next) });
    };

    const onUp = () => {
      const final = lastPeriodRef.current;
      const wasDrag = stateRef.current === 'dragging';
      // Release capture + reset before commit, so React commits a
      // post-commit `isDragging=false` view synchronously.
      const cap = capturedRef.current;
      if (cap) {
        try { cap.el.releasePointerCapture(cap.pointerId); } catch { /* */ }
        capturedRef.current = null;
      }
      stateRef.current = 'idle';
      setMode('idle');
      kindRef.current = null;
      setPreview(null);
      if (wasDrag && !periodsEqual(final, period)) {
        onCommit(entryPath, final);
      }
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        lastPeriodRef.current = period;
        const cap = capturedRef.current;
        if (cap) {
          try { cap.el.releasePointerCapture(cap.pointerId); } catch { /* */ }
          capturedRef.current = null;
        }
        stateRef.current = 'idle';
        setMode('idle');
        kindRef.current = null;
        setPreview(null);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('pointercancel', onUp, { once: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey);
    };
    // periodAtStart is a snapshot for this drag — captured in closure.
    // Including `period` here would re-register listeners on every commit
    // remount, which is wasteful. The `isDragging` gate handles it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDragging, kindRef, period, entryPath, pxPerDay, scaleStartKey, scaleTotalDays, onCommit, styleForPeriod]);

  return {
    onPointerDown,
    onPointerUp,
    isDragging,
    previewStyle: preview?.style ?? null,
  };
}

// ─── Local pure helpers (also exported for unit tests) ────────────────

/**
 * Whole-day offset from `anchor` to `target`. DST-safe via UTC math;
 * mirrors `daysBetween` in `shared/gantt.ts` but uses `target - anchor`
 * ordering (matches "days since the scale started").
 */
function daysSince(anchor: string, target: string): number {
  const a = new Date(`${anchor}T00:00:00Z`).getTime();
  const t = new Date(`${target}T00:00:00Z`).getTime();
  return Math.round((t - a) / 86_400_000);
}

/** Inverse of `daysSince` — clamp to the inclusive [0, scaleTotalDays). */
function dayKeyFromOffset(
  anchor: string,
  scaleTotalDays: number,
  offset: number
): string {
  const dayOffset = Math.max(0, Math.min(scaleTotalDays - 1, offset));
  const d = new Date(`${anchor}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Convert a body-relative drag delta into an edge-resized `GanttPeriod`.
 *  Pure math; no DOM reads. The math works by:
 *    - left edge: bar's start sits at `(daysSince(start, period.start)) * pxPerDay`
 *      px from the scale origin; dragging dx px moves that anchor to
 *      `(period.start + dx/pxPerDay)` days from the scale origin.
 *    - right edge: same idea anchored on `period.end` (+1 to put the day
 *      boundary on the right side of the bar).
 *  Clamping is delegated to `periodWithResize`, which also guarantees
 *  no inversion.
 */
function computeEdgeResize(
  base: GanttPeriod,
  kind: DragKind,
  dx: number,
  pxPerDay: number,
  scaleStartKey: string,
  scaleTotalDays: number
): GanttPeriod {
  const baseDayOffset =
    kind === 'left'
      ? daysSince(scaleStartKey, base.startKey)
      : daysSince(scaleStartKey, base.endKey) + 1;
  const deltaDays = Math.round(dx / pxPerDay);
  const targetOffset = baseDayOffset + deltaDays;
  const candidateKey = dayKeyFromOffset(
    scaleStartKey,
    scaleTotalDays,
    targetOffset
  );
  return periodWithResize(base, kind === 'left' ? 'left' : 'right', candidateKey);
}

// Re-export for unit tests.
export { daysSince, dayKeyFromOffset, computeEdgeResize };
