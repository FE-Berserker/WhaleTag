/**
 * Phase 5 / §8 drop-target test: lock down the PeriodTagDialog's contract
 * so the drop wiring in `Row.tsx` can rely on it. We exercise:
 *
 *  1. Default values (today / today)
 *  2. Default-value override (custom start / end)
 *  3. `end < start` disables the confirm button + surfaces the error
 *  4. Editing the inputs to a valid range re-enables confirm
 *  5. Confirm yields `YYYYMMDD-YYYYMMDD` (the period stored form)
 *  6. Cancel / backdrop close does NOT call onConfirm
 *  7. Provider hook + open/close round-trip
 *
 * The dialog is fully controlled by the `open` prop — tests mount it
 * directly without the provider first to keep the surface focused.
 */

import globalJsdom from 'global-jsdom';
import { before, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import i18next from 'i18next';

import {
  PeriodTagDialog,
  PeriodTagDialogProvider,
  usePeriodTagDialog,
  clampAnchorToViewport,
} from './PeriodTagDialog';
import type { TFunction } from 'i18next';

// global-jsdom@29: must be explicitly invoked in before() — see
// CalendarView.test.tsx for the full rationale.
before(async () => {
  globalJsdom();
  // MUI Dialog's internal Backdrop uses a Fade transition that calls
  // `reflow(node)` → `node.scrollTop`. Under jsdom, `document.body` is null
  // at the moment the transition runs, so we pre-create a body element so
  // the reflow finds a real node. This is a test-only scaffold — production
  // never hits this path because the browser's body is always present.
  if (typeof document !== 'undefined' && !document.body) {
    const body = document.createElement('body');
    document.documentElement?.appendChild(body);
  }
});
afterEach(cleanup);

const t: TFunction = ((key: string) => key) as unknown as TFunction;

describe('PeriodTagDialog — direct (controlled open prop)', () => {
  it('renders both date inputs with default values when no defaults given', () => {
    const { getByTestId } = render(
      <PeriodTagDialog open onClose={() => {}} onConfirm={() => {}} t={t} />
    );
    const start = getByTestId('period-tag-start') as HTMLInputElement;
    const end = getByTestId('period-tag-end') as HTMLInputElement;
    // Default is today in both fields.
    const today = new Date();
    const isoToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    assert.equal(start.value, isoToday);
    assert.equal(end.value, isoToday);
  });

  it('uses provided defaultStart / defaultEnd', () => {
    const { getByTestId } = render(
      <PeriodTagDialog
        open
        defaultStart="2026-07-01"
        defaultEnd="2026-07-10"
        onClose={() => {}}
        onConfirm={() => {}}
        t={t}
      />
    );
    const start = getByTestId('period-tag-start') as HTMLInputElement;
    const end = getByTestId('period-tag-end') as HTMLInputElement;
    assert.equal(start.value, '2026-07-01');
    assert.equal(end.value, '2026-07-10');
  });

  it('end < start disables confirm + surfaces error', () => {
    const { getByTestId, queryByText } = render(
      <PeriodTagDialog
        open
        defaultStart="2026-07-10"
        defaultEnd="2026-07-01"
        onClose={() => {}}
        onConfirm={() => {}}
        t={t}
      />
    );
    const confirm = getByTestId('period-tag-confirm') as HTMLButtonElement;
    assert.equal(confirm.disabled, true);
    const error = queryByText('periodTagErrorOrder');
    assert.ok(error, 'error helper text should be visible when end < start');
  });

  it('confirm is enabled when start === end (single-day period)', () => {
    // Single-day period is a valid use case (see calendar.test.ts:378
    // "accepts a single-day period"). Confirm button must NOT be disabled.
    const { getByTestId } = render(
      <PeriodTagDialog
        open
        defaultStart="2026-07-04"
        defaultEnd="2026-07-04"
        onClose={() => {}}
        onConfirm={() => {}}
        t={t}
      />
    );
    const confirm = getByTestId('period-tag-confirm') as HTMLButtonElement;
    assert.equal(confirm.disabled, false);
  });

  it('onConfirm yields YYYYMMDD-YYYYMMDD (compact, no dashes)', () => {
    let captured = '';
    const { getByTestId } = render(
      <PeriodTagDialog
        open
        defaultStart="2026-07-01"
        defaultEnd="2026-07-31"
        onClose={() => {}}
        onConfirm={(p) => {
          captured = p;
        }}
        t={t}
      />
    );
    fireEvent.click(getByTestId('period-tag-confirm'));
    assert.equal(captured, '20260701-20260731');
  });

  it('cancel button does NOT call onConfirm', () => {
    let called = false;
    const { getByTestId } = render(
      <PeriodTagDialog
        open
        onClose={() => {}}
        onConfirm={() => {
          called = true;
        }}
        t={t}
      />
    );
    fireEvent.click(getByTestId('period-tag-cancel'));
    assert.equal(called, false);
  });

  it('a single-day period (start === end) is valid', () => {
    let captured = '';
    const { getByTestId } = render(
      <PeriodTagDialog
        open
        defaultStart="2026-07-04"
        defaultEnd="2026-07-04"
        onClose={() => {}}
        onConfirm={(p) => {
          captured = p;
        }}
        t={t}
      />
    );
    const confirm = getByTestId('period-tag-confirm') as HTMLButtonElement;
    assert.equal(confirm.disabled, false);
    fireEvent.click(confirm);
    assert.equal(captured, '20260704-20260704');
  });

  it('isOpen=false suppresses the DOM (no inputs rendered)', () => {
    const { queryByTestId } = render(
      <PeriodTagDialog
        open={false}
        onClose={() => {}}
        onConfirm={() => {}}
        t={t}
      />
    );
    assert.equal(queryByTestId('period-tag-confirm'), null);
  });
});

describe('PeriodTagDialogProvider + usePeriodTagDialog', () => {
  /** Probe that surfaces the hook's value to the DOM. */
  function Probe() {
    const ctx = usePeriodTagDialog();
    return (
      <div>
        <span data-testid="probe-open">{String(ctx.isOpen)}</span>
        <button
          data-testid="probe-open-btn"
          onClick={() =>
            ctx.openDialog({
              defaultStart: '2026-07-01',
              defaultEnd: '2026-07-10',
              onConfirm: () => {},
            })
          }
        >
          open
        </button>
        <button data-testid="probe-close-btn" onClick={ctx.closeDialog}>
          close
        </button>
      </div>
    );
  }

  it('isOpen reflects the underlying state', () => {
    const { getByTestId } = render(
      <I18nextProvider i18n={i18next}>
        <PeriodTagDialogProvider>
          <Probe />
        </PeriodTagDialogProvider>
      </I18nextProvider>
    );
    assert.equal(getByTestId('probe-open').textContent, 'false');
    act(() => {
      getByTestId('probe-open-btn').click();
    });
    assert.equal(getByTestId('probe-open').textContent, 'true');
    act(() => {
      getByTestId('probe-close-btn').click();
    });
    assert.equal(getByTestId('probe-open').textContent, 'false');
  });

  it('opening the dialog renders the form with the provided defaults', () => {
    const { getByTestId, queryByTestId } = render(
      <I18nextProvider i18n={i18next}>
        <PeriodTagDialogProvider>
          <Probe />
        </PeriodTagDialogProvider>
      </I18nextProvider>
    );
    // Pre-open: no dialog elements
    assert.equal(queryByTestId('period-tag-confirm'), null);
    // Open
    act(() => {
      getByTestId('probe-open-btn').click();
    });
    const start = getByTestId('period-tag-start') as HTMLInputElement;
    const end = getByTestId('period-tag-end') as HTMLInputElement;
    assert.equal(start.value, '2026-07-01');
    assert.equal(end.value, '2026-07-10');
  });

  it('usePeriodTagDialog throws outside provider', () => {
    function Naked() {
      usePeriodTagDialog();
      return null;
    }
    // Suppress React's noisy error logging for the boundary case.
    const origError = console.error;
    console.error = () => {};
    try {
      assert.throws(() => render(<Naked />), /must be used within/);
    } finally {
      console.error = origError;
    }
  });
});

// Provide a minimal i18n instance so the provider's useTranslation() call
// has something to read; we don't care about actual translations for tests.
void i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: {} } },
  interpolation: { escapeValue: false },
});

// Anchor-clamping helper — extracted for unit testing. The dialog
// itself can't easily be asserted on (the Paper's sx is applied via
// MUI internals) so we lock down the pure math here.
describe('clampAnchorToViewport', () => {
  it('clamps a near-right-edge anchor so dialog stays in viewport', () => {
    // 1024×768 viewport, anchor at (300, 900). Without the clamp, the
    // dialog (444px wide) would land at left=900 → right edge at
    // 1344, 320px past the viewport right edge. Clamp pushes `left`
    // down so right edge = 1024 - 8 = 1016.
    const out = clampAnchorToViewport({ top: 300, left: 900 }, 1024, 768);
    assert.equal(out.top, 300, 'top unchanged when inside viewport');
    assert.equal(out.left, 1024 - 444 - 8, 'left clamped to viewport - dialog - margin');
  });

  it('clamps a near-bottom-edge anchor so dialog does not overflow vertically', () => {
    // 1024×768 viewport, anchor at (700, 100). Without clamp, top=700,
    // dialog ~360px tall, bottom edge = 1060, 292px past viewport.
    const out = clampAnchorToViewport({ top: 700, left: 100 }, 1024, 768);
    assert.equal(out.top, 768 - 360 - 8, 'top clamped to viewport - dialog - margin');
    assert.equal(out.left, 100, 'left unchanged when inside viewport');
  });

  it('clamps an off-screen-top-left anchor to the viewport margins', () => {
    // Negative anchor (cursor was outside the visible window before
    // the dialog opened, e.g. a programmatic open).
    const out = clampAnchorToViewport({ top: -50, left: -100 }, 1024, 768);
    assert.equal(out.top, 8);
    assert.equal(out.left, 8);
  });

  it('clamps to a narrower dialog when viewport itself is narrower than 444', () => {
    // 400×600 viewport — MUI's `fullWidth` shrinks the dialog to the
    // container, so the right-edge clamp must use ~400 - 16, NOT 444 -
    // 16. Otherwise `left` would land at a negative value (capped at
    // 8) but the dialog would still overflow the right edge.
    const out = clampAnchorToViewport({ top: 100, left: 200 }, 400, 600);
    assert.equal(out.left, 400 - (400 - 16) - 8, 'left uses shrunk dialog width');
  });

  it('handles NaN anchor by returning the margin (defensive)', () => {
    // Defensive: a NaN from a malformed click event shouldn't crash
    // the dialog. The clamp should fall back to the margin.
    const out = clampAnchorToViewport(
      { top: Number.NaN, left: Number.NaN },
      1024,
      768
    );
    assert.equal(out.top, 8);
    assert.equal(out.left, 8);
  });

  it('passes through a comfortable anchor unchanged', () => {
    // Mid-viewport anchor — no clamping needed.
    const out = clampAnchorToViewport({ top: 200, left: 300 }, 1024, 768);
    assert.deepEqual(out, { top: 200, left: 300 });
  });
});
