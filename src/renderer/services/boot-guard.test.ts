import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import globalJsdom from 'global-jsdom';

import {
  BOOT_WATCHDOG_MS,
  MAX_REPORTS_PER_MINUTE,
  createReportLimiter,
  errorDetail,
  installBootGuard,
  removeRecoveryOverlay,
  showRecoveryOverlay,
} from './boot-guard';

function overlay(): HTMLElement | null {
  return document.getElementById('whale-boot-recovery');
}

function dispatchError(message: string, error?: unknown): void {
  // Must be jsdom's Event class: the Node global Event is not accepted by
  // jsdom's dispatchEvent.
  const event = new window.Event('error') as Event & {
    message?: string;
    error?: unknown;
    filename?: string;
    lineno?: number;
  };
  event.message = message;
  event.error = error;
  window.dispatchEvent(event);
}

function dispatchRejection(reason: unknown): void {
  const event = new window.Event('unhandledrejection') as Event & {
    reason?: unknown;
  };
  event.reason = reason;
  window.dispatchEvent(event);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

before(() => {
  // global-jsdom@29 requires an explicit call to install window/document.
  globalJsdom();
});

beforeEach(() => {
  document.body.innerHTML = '';
});

after(() => {
  document.body.innerHTML = '';
});

describe('errorDetail', () => {
  it('prefers a stack over a bare message', () => {
    const detail = errorDetail(new Error('boom'));
    assert.match(detail, /Error: boom/);
    assert.match(detail, /boot-guard\.test\.ts/);
  });

  it('reads stack/message from plain event-like objects', () => {
    assert.equal(errorDetail({ message: 'from event' }), 'from event');
    assert.equal(
      errorDetail({ message: 'm', stack: 'S: at x' }),
      'S: at x'
    );
  });

  it('passes strings through and stringifies the rest', () => {
    assert.equal(errorDetail('plain'), 'plain');
    assert.equal(errorDetail(42), '42');
    assert.equal(errorDetail(null), 'null');
    assert.equal(errorDetail(undefined), 'undefined');
  });
});

describe('createReportLimiter', () => {
  it('accepts up to the cap inside one window, then refuses', () => {
    const now = 0;
    const allow = createReportLimiter(() => now, 2, 1_000);
    assert.equal(allow('a'), true);
    assert.equal(allow('b'), true);
    assert.equal(allow('c'), false);
  });

  it('refills once the window has passed', () => {
    let now = 0;
    const allow = createReportLimiter(() => now, 1, 1_000);
    assert.equal(allow('a'), true);
    assert.equal(allow('b'), false);
    now = 1_001;
    assert.equal(allow('c'), true);
  });

  it('exposes the production defaults', () => {
    assert.equal(MAX_REPORTS_PER_MINUTE, 20);
    assert.equal(BOOT_WATCHDOG_MS, 15_000);
  });
});

describe('recovery overlay', () => {
  it('renders title, detail and a working Reload button', () => {
    let reloads = 0;
    showRecoveryOverlay(document, {
      title: 'WhaleTag could not start',
      detail: 'Error: boom',
      onReload: () => {
        reloads += 1;
      },
    });

    const box = overlay();
    assert.ok(box);
    assert.match(box.textContent ?? '', /WhaleTag could not start/);
    assert.match(box.textContent ?? '', /Error: boom/);

    const button = box.querySelector('button');
    assert.ok(button);
    button.click();
    assert.equal(reloads, 1);
  });

  it('is idempotent and updates the content in place', () => {
    showRecoveryOverlay(document, {
      title: 'First',
      detail: 'one',
      onReload: () => undefined,
    });
    showRecoveryOverlay(document, {
      title: 'Second',
      detail: 'two',
      onReload: () => undefined,
    });

    assert.equal(document.querySelectorAll('#whale-boot-recovery').length, 1);
    const text = overlay()?.textContent ?? '';
    assert.match(text, /Second/);
    assert.match(text, /two/);
    assert.doesNotMatch(text, /First/);
  });

  it('can be removed', () => {
    showRecoveryOverlay(document, {
      title: 'x',
      detail: 'y',
      onReload: () => undefined,
    });
    removeRecoveryOverlay(document);
    assert.equal(overlay(), null);
  });
});

describe('installBootGuard', () => {
  it('shows the overlay and reports a global error before the app is ready', () => {
    const reports: string[] = [];
    const guard = installBootGuard({
      document,
      window,
      watchdogMs: 60_000,
      report: (detail) => reports.push(detail),
      onReload: () => undefined,
    });

    dispatchError('boom', new Error('boom'));

    assert.ok(overlay());
    assert.equal(reports.length, 1);
    assert.match(reports[0], /uncaught error: Error: boom/);
    guard.dispose();
  });

  it('reports a rejection and shows the overlay with its reason', () => {
    const reports: string[] = [];
    const guard = installBootGuard({
      document,
      window,
      watchdogMs: 60_000,
      report: (detail) => reports.push(detail),
      onReload: () => undefined,
    });

    dispatchRejection(new Error('nope'));

    assert.ok(overlay());
    assert.match(reports[0], /unhandled promise rejection: Error: nope/);
    guard.dispose();
  });

  it('clears the overlay on markReady and only reports later errors', () => {
    const reports: string[] = [];
    const guard = installBootGuard({
      document,
      window,
      watchdogMs: 60_000,
      report: (detail) => reports.push(detail),
      onReload: () => undefined,
    });

    dispatchError('early');
    assert.ok(overlay());

    guard.markReady();
    assert.equal(guard.isReady(), true);
    assert.equal(overlay(), null);

    dispatchError('late');
    assert.equal(overlay(), null);
    assert.equal(reports.length, 2);
    assert.match(reports[1], /late/);
    guard.dispose();
  });

  it('fires the watchdog when the app never becomes ready', async () => {
    const reports: string[] = [];
    const guard = installBootGuard({
      document,
      window,
      watchdogMs: 20,
      report: (detail) => reports.push(detail),
      onReload: () => undefined,
    });

    await sleep(80);

    assert.ok(overlay());
    assert.equal(reports.length, 1);
    assert.match(reports[0], /startup watchdog/);
    guard.dispose();
  });

  it('does not fire the watchdog after markReady, and disposes cleanly', async () => {
    const reports: string[] = [];
    const guard = installBootGuard({
      document,
      window,
      watchdogMs: 20,
      report: (detail) => reports.push(detail),
      onReload: () => undefined,
    });

    guard.markReady();
    await sleep(80);
    assert.equal(reports.length, 0);
    assert.equal(overlay(), null);

    guard.dispose();
    dispatchError('after dispose');
    assert.equal(reports.length, 0);
  });
});
