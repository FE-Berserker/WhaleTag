/**
 * Period Tag dialog (Phase 5 / §8): when the user drops the `period:` chip
 * from the tag library onto a file, a folder, or a multi-selection, this
 * dialog opens to collect the start and end dates. The dragged target stays
 * faded (`opacity: 0.5`) while the dialog is open and snaps back if the
 * user cancels.
 *
 * The dialog is a stateful component, not a hook — the surrounding
 * `PeriodTagDialogProvider` (in this file) owns the open/close state and
 * exposes `openDialog({ defaultStart, defaultEnd, onConfirm })` /
 * `closeDialog()` to consumers via `usePeriodTagDialog()`.
 *
 * Date inputs: native HTML5 `<input type="date">` (no extra MUI X DatePicker
 * dep). Values are local `YYYY-MM-DD` strings; the dialog converts to
 * `YYYYMMDD-YYYYMMDD` before calling `onConfirm`.
 *
 * Validation: end >= start. Mismatched inputs disable the Confirm button
 * and surface a localized `periodTagErrorOrder` message.
 */

import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  TextField,
} from '@mui/material';
import type { TFunction } from 'i18next';

/**
 * No-op transition for the period-tag dialog. The default MUI Fade calls
 * `reflow()` on its ref'd node during the first mount, which crashes under
 * jsdom (the ref isn't attached yet → null scrollTop). This stand-in uses
 * `forwardRef` so MUI's `Modal` / `FocusTrap` can still attach a ref (the
 * `<div>` is a real DOM element; reflow is harmless here, and React's
 * "Function components cannot be given refs" warning is silenced).
 * Skips the visual fade in production as a side effect — the dialog is a
 * small targeted form that doesn't benefit from a slide-in.
 */
const NoopTransition = forwardRef<
  HTMLDivElement,
  { children?: ReactNode; in?: boolean }
>(function NoopTransition(props, ref) {
  return <div ref={ref}>{props.children}</div>;
});

/**
 * Same justification as `NoopTransition`, but for the Backdrop slot. The
 * default MUI Backdrop has its own Fade internally; replacing it with a
 * Fragment-backed version skips the reflow entirely. The semi-transparent
 * scrim is preserved via inline `sx` on the parent Box.
 */
function NoopBackdrop(props: { open?: boolean; onClick?: () => void }) {
  // Render nothing — the dialog's parent container already provides the
  // scrim via `sx={{ bgcolor: 'rgba(0,0,0,0.4)' }}` styling, so the user
  // still sees a dimmed background without the transition dance.
  return null;
}

/** `YYYY-MM-DD` — the HTML5 date input's native value format. */
type IsoDate = string;
/** `YYYYMMDD-YYYYMMDD` — the period tag's stored form (no dashes). */
type CompactPeriod = string;

/** Gutter from viewport edges — the dialog never sits flush against
 *  the window border, so a stray click on the OS-level window
 *  controls (close/minimize) isn't swallowed by the dialog's edge. */
const VIEWPORT_MARGIN = 8;
/** MUI's `xs` breakpoint caps the dialog content width at 444px.
 *  `fullWidth: true` makes it shrink to the container on smaller
 *  windows; `Math.min` here mirrors that so the right-edge clamp
 *  doesn't predict a wider dialog than MUI will actually render. */
const DIALOG_MAX_WIDTH = 444;
/** Rough upper bound on the rendered dialog height. Used as a
 *  fallback for the top-edge clamp when the actual height isn't
 *  measured yet; the Paper's `maxHeight: calc(100vh - top - 8px)`
 *  CSS handles the rest at render time. */
const DIALOG_MAX_HEIGHT = 360;

function compactFromIso(iso: IsoDate): string {
  return iso.replace(/-/g, '');
}

function isoFromCompact(compact: string): string {
  // compact is YYYYMMDD (8 chars) — re-insert dashes.
  if (compact.length !== 8) return compact;
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function todayIso(): IsoDate {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Clamp an anchor (cursor-anchored) coordinate so the dialog stays
 * inside the viewport with a `VIEWPORT_MARGIN` gutter on every edge.
 *
 * The original clamp only protected the top-left corner (`Math.max(8,
 * anchor.top)`), which left the dialog's right + bottom edges free to
 * extend past `window.innerWidth / innerHeight` on small windows —
 * the symptom was the Confirm / Cancel buttons dropping off the right
 * edge when the user clicked a Gantt bar near the window's right side.
 * Defense in depth: the Paper's `maxHeight` CSS calc still applies at
 * render time, so even if `DIALOG_MAX_HEIGHT` is wrong the dialog
 * won't overflow vertically.
 */
export function clampAnchorToViewport(
  anchor: { top: number; left: number },
  viewportWidth: number,
  viewportHeight: number
): { top: number; left: number } {
  // Clamp dialog width to what MUI will actually render — on tiny
  // windows `fullWidth` shrinks the Paper to the container, which is
  // smaller than DIALOG_MAX_WIDTH. Being conservative on the right-
  // edge clamp is the safe direction (a few extra px of right gutter
  // is harmless; an off-screen button is not).
  const dialogWidth = Math.min(
    DIALOG_MAX_WIDTH,
    Math.max(0, viewportWidth - 2 * VIEWPORT_MARGIN)
  );
  // Clamp height similarly — `maxHeight` CSS calc is the source of
  // truth at render time, but this clamp keeps the math in one place
  // and makes `top + dialogHeight ≤ viewport - margin` a hard
  // invariant.
  const dialogHeight = Math.min(
    DIALOG_MAX_HEIGHT,
    Math.max(0, viewportHeight - 2 * VIEWPORT_MARGIN)
  );
  const maxLeft = Math.max(
    VIEWPORT_MARGIN,
    viewportWidth - dialogWidth - VIEWPORT_MARGIN
  );
  const maxTop = Math.max(
    VIEWPORT_MARGIN,
    viewportHeight - dialogHeight - VIEWPORT_MARGIN
  );
  return {
    top: clamp(anchor.top, VIEWPORT_MARGIN, maxTop),
    left: clamp(anchor.left, VIEWPORT_MARGIN, maxLeft),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export interface PeriodTagDialogProps {
  open: boolean;
  defaultStart?: IsoDate;
  defaultEnd?: IsoDate;
  /**
   * Optional cursor-anchored position (viewport coords, px). When set,
   * the dialog's Paper is offset to (top, left) instead of MUI's default
   * centered layout. The dialog self-clamps so off-screen anchors still
   * produce a usable popup.
   */
  anchorPosition?: { top: number; left: number };
  onConfirm: (period: CompactPeriod, start: IsoDate, end: IsoDate) => void;
  onClose: () => void;
  t: TFunction;
}

/**
 * The dialog itself. Stateless — given a stable set of props (open +
 * default values) it renders the form. Internally manages local form state
 * (start / end inputs) so that the user can edit freely without round-tripping
 * to the parent on every keystroke; only the Confirm action reaches back.
 */
export function PeriodTagDialog({
  open,
  defaultStart,
  defaultEnd,
  anchorPosition,
  onConfirm,
  onClose,
  t,
}: PeriodTagDialogProps) {
  const [start, setStart] = useState<IsoDate>(defaultStart ?? todayIso());
  const [end, setEnd] = useState<IsoDate>(defaultEnd ?? defaultStart ?? todayIso());

  // Reset the local form state every time the dialog opens so a previous
  // session's values don't linger.
  useEffect(() => {
    if (open) {
      setStart(defaultStart ?? todayIso());
      setEnd(defaultEnd ?? defaultStart ?? todayIso());
    }
  }, [open, defaultStart, defaultEnd]);

  // Empty inputs OR end < start → invalid.
  const valid =
    start.length === 10 &&
    end.length === 10 &&
    // Compare as 8-digit compacts (avoids relying on Date parsing).
    compactFromIso(start) <= compactFromIso(end);

  const handleConfirm = () => {
    if (!valid) return;
    const period = `${compactFromIso(start)}-${compactFromIso(end)}`;
    onConfirm(period, start, end);
    // Always close the dialog after Apply. The parent's `onConfirm` may
    // (or may not) trigger further async work (e.g. edit-period flow does a
    // `save()`); the dialog closing here is independent of that. The parent's
    // onCancel / backdrop paths still call `onClose` separately.
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      // The period-tag dialog is a small targeted form — animating it in
      // adds delay without value. Both the content transition AND the
      // backdrop fade are bypassed via the no-op slot components below
      // (Fragment-based stand-ins that don't trigger MUI's `reflow()` on
      // a not-yet-attached ref under jsdom, and skip the visual fade in
      // production).
      slots={{ transition: NoopTransition, backdrop: NoopBackdrop }}
      // Cursor-anchored positioning. When `anchorPosition` is set, the
      // Paper is placed at the requested (top, left) and clamped to the
      // viewport via `clampAnchorToViewport` so off-screen anchors (e.g.
      // the user scrolled the Gantt and the click landed past the
      // visible edge, or the window is small enough that the dialog's
      // natural 444px width would overflow the right edge) still
      // produce a usable popup with Confirm/Cancel buttons in reach.
      // MUI's default centering is overridden by `position: absolute` —
      // without it the Paper would still snap back to viewport-center
      // regardless of these top/left values. The Paper also keeps its
      // own centering `translate(-50%, -50%)` default; we neutralize
      // that with `transform: none` so (top, left) means exactly
      // "top-left of the Paper sits at this point."
      //
      // `maxHeight` is the defense-in-depth vertical clamp: even if the
      // estimated `DIALOG_MAX_HEIGHT` is wrong, this calc keeps the
      // dialog within the visible area (vertical scroll inside a
      // dialog Paper is rarer than horizontal for a 2-input form, but
      // it's free correctness).
      slotProps={{
        paper: {
          sx: (() => {
            if (!anchorPosition) return undefined;
            const clamped = clampAnchorToViewport(
              anchorPosition,
              typeof window !== 'undefined' ? window.innerWidth : 1024,
              typeof window !== 'undefined' ? window.innerHeight : 768
            );
            return {
              position: 'absolute',
              top: clamped.top,
              left: clamped.left,
              right: 'auto',
              bottom: 'auto',
              transform: 'none',
              maxHeight: `calc(100vh - ${clamped.top}px - ${VIEWPORT_MARGIN}px)`,
            };
          })(),
        },
      }}
      data-testid="period-tag-dialog"
    >
      <DialogTitle>{t('periodTagDialogTitle')}</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          {/* Short helper sentence; i18n key reused from existing tag-edit copy
              if no dedicated key was added. Falls back to a static string when
              the key is missing in any locale. */}
          {t('periodTagDialogBody', { defaultValue: '' }) ||
            'Enter the start and end dates for this period tag.'}
        </DialogContentText>
        <Stack spacing={3} sx={{ mt: 1 }}>
          <TextField
            id="period-tag-start"
            type="date"
            label={t('periodTagStart')}
            value={start}
            onChange={(e) => setStart(e.target.value)}
            slotProps={{
              htmlInput: {
                'data-testid': 'period-tag-start',
              },
            }}
            size="small"
            fullWidth
          />
          <TextField
            id="period-tag-end"
            type="date"
            label={t('periodTagEnd')}
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            slotProps={{
              htmlInput: {
                'data-testid': 'period-tag-end',
              },
            }}
            size="small"
            fullWidth
            error={!valid && Boolean(start) && Boolean(end)}
            helperText={
              !valid && start && end ? t('periodTagErrorOrder') : ' '
            }
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} data-testid="period-tag-cancel">
          {t('periodTagCancel')}
        </Button>
        <Button
          onClick={handleConfirm}
          disabled={!valid}
          variant="contained"
          data-testid="period-tag-confirm"
        >
          {t('periodTagConfirm')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ─── Provider + hook ────────────────────────────────────────────────────

interface DialogState {
  defaultStart?: IsoDate;
  defaultEnd?: IsoDate;
  /**
   * Optional cursor-anchored position (viewport coords, px). When set,
   * the dialog's Paper is offset to (top, left) via absolute
   * positioning instead of MUI's default centered layout. Used by the
   * Gantt bar's single-click path — clicking a taskbar pops the dialog
   * near the click point instead of far away at the top of the
   * viewport. The dialog self-clamps to keep itself on-screen (see
   * the connected dialog's Paper `sx`).
   */
  anchorPosition?: { top: number; left: number };
  onConfirm: (period: CompactPeriod, start: IsoDate, end: IsoDate) => void;
}

interface PeriodTagDialogContextValue {
  openDialog: (state: DialogState) => void;
  closeDialog: () => void;
  isOpen: boolean;
}

const PeriodTagDialogContext = createContext<PeriodTagDialogContextValue | null>(
  null
);

/**
 * Provider that owns the dialog's open/close state. Mount once near the
 * app root (MainLayout). The dialog itself is rendered at the top of the
 * provider's tree so it stacks above any view-level overlay.
 */
export function PeriodTagDialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState | null>(null);

  const openDialog = useCallback((s: DialogState) => {
    setState(s);
  }, []);
  const closeDialog = useCallback(() => {
    setState(null);
  }, []);

  // Note: `t` is sourced from inside the dialog (it has its own useTranslation
  // via the consumer). The provider just owns open/close + the pending
  // onConfirm callback. TFunction is required only at the dialog render
  // site, so we don't thread it through the context value.
  const value: PeriodTagDialogContextValue = {
    openDialog,
    closeDialog,
    isOpen: state !== null,
  };

  return (
    <PeriodTagDialogContext.Provider value={value}>
      {children}
      {state ? (
        <ConnectedDialog state={state} onClose={closeDialog} />
      ) : null}
    </PeriodTagDialogContext.Provider>
  );
}

/** Renders the dialog wired to a `DialogState` from the provider. */
function ConnectedDialog({
  state,
  onClose,
}: {
  state: DialogState;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <PeriodTagDialog
      open
      defaultStart={state.defaultStart}
      defaultEnd={state.defaultEnd}
      anchorPosition={state.anchorPosition}
      onConfirm={state.onConfirm}
      onClose={onClose}
      t={t}
    />
  );
}

export function usePeriodTagDialog(): PeriodTagDialogContextValue {
  const ctx = useContext(PeriodTagDialogContext);
  if (!ctx) {
    throw new Error(
      'usePeriodTagDialog must be used within PeriodTagDialogProvider'
    );
  }
  return ctx;
}
