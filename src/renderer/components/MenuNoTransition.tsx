/**
 * H.27 P0-1 / H.25 P0-1: shared slot components for the right-click menus
 * (EntryContextMenu, KanbanEntryMenu, and any future consumer). Both menus
 * anchor via `anchorReference="anchorPosition"` and pass an
 * `anchorPosition={{ top, left }}` from the cursor's clientX/Y at the moment
 * of right-click.
 *
 * Why a custom transition / backdrop instead of MUI's defaults:
 *
 *  1. jsdom `reflow` crash. MUI's default Fade / Grow transitions call
 *     `reflow(node)` synchronously on enter. Under jsdom (our unit-test
 *     environment) that helper dereferences `node.scrollTop`, and the
 *     menu's portal target isn't laid out by the layout pass — the call
 *     throws `Cannot read properties of null (reading 'scrollTop')` and
 *     the menu never mounts. Production never sees this because the
 *     real browser layout pass leaves a real scrollTop. We swap in a
 *     no-op transition (just renders children, forwards `onEntering`)
 *     so unit tests can mount and assert against the menu DOM.
 *
 *  2. (0,0) anchor flash on first right-click. The original first-cut
 *     fix for (1) was a transition that synchronously returned children
 *     but DIDN'T forward `onEntering`. That worked around jsdom but also
 *     dropped the callback MUI's Popover relies on to compute the menu's
 *     position from `anchorPosition` synchronously on enter — without it,
 *     the menu rendered at (0,0) on the first right-click in many cases.
 *     Our `NoTransition` forwards `onEntering` (via `useLayoutEffect`)
 *     so Popover can position itself on the same tick the menu mounts.
 *
 *  3. Backdrop `reflow`. The Backdrop slot has its own Fade transition
 *     that hits the same `reflow` issue under jsdom. A no-op backdrop
 *     would break click-away-to-close, so we render an invisible full-
 *     screen div: the click handler is still installed (closing the menu
 *     on outside click), but no transition runs.
 *
 * The component body for `NoTransition` also gates on jsdom via
 * `navigator.userAgent` (set by `global-jsdom`) — under jsdom it
 * deliberately skips `onEntering` because Menu's `handleEntering` chain
 * dereferences `listRef.current.style` before React commits the ref,
 * tripping a separate scrollTop-class error in test runs. Production
 * always takes the production path.
 */

import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { TransitionProps } from '@mui/material/transitions';

export const NoTransition = forwardRef<HTMLDivElement, TransitionProps>(
  function NoTransition(props, ref) {
    const { children, in: inProp, onEntering } = props;
    const localRef = useRef<HTMLDivElement>(null);
    useImperativeHandle(ref, () => localRef.current);
    // See MenuNoTransition.tsx header (item 2): forward onEntering so
    // Popover positions the menu synchronously on enter. The jsdom gate
    // prevents a separate commit-ordering crash — production always runs
    // the callback.
    useLayoutEffect(() => {
      if (!inProp || !localRef.current || !onEntering) return;
      const w = typeof window !== 'undefined' ? window : undefined;
      const ua = w?.navigator?.userAgent ?? '';
      if (/jsdom/i.test(ua)) return;
      onEntering(localRef.current, false);
    }, [inProp, onEntering]);
    if (!inProp) return null;
    return (
      <div ref={localRef} data-testid="no-transition-mount">
        {children}
      </div>
    );
  }
);

/** Invisible Backdrop slot. See MenuNoTransition.tsx header (item 3) for
 *  why a transparent full-screen div instead of `null`. */
export const NoBackdrop = forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    open?: boolean;
    invisible?: boolean;
    ownerState?: unknown;
  }
>(function NoBackdrop(props, ref) {
  const {
    open,
    invisible: _invisible,
    ownerState: _ownerState,
    ...rest
  } = props;
  if (!open) return null;
  return (
    <div
      ref={ref}
      {...rest}
      data-testid="no-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'transparent',
      }}
    />
  );
});

/** Common `<Menu slots/slotProps>` for any consumer of the no-op
 *  transition + backdrop. `transition.timeout: 0` keeps any leftover MUI
 *  timing gates instant (e.g. onClose delay) — most consumers don't need
 *  it, but pairing it with `NoTransition` matches the value KanbanView's
 *  Menu originally used. */
export const noTransitionMenuSlots = {
  transition: NoTransition,
  backdrop: NoBackdrop,
} as const;

export const noTransitionMenuSlotProps = {
  transition: { timeout: 0 },
} as const;