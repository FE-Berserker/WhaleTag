import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

import { notifyApp } from '-/services/app-notice';

let cleanupDom: (() => void) | undefined;
let AppNoticeHost: typeof import('./AppNoticeHost').default;

/** Text currently rendered inside the snackbar alert ('' when idle). */
function visibleMessage(): string {
  return (
    document.querySelector('.MuiAlert-message')?.textContent?.trim() ?? ''
  );
}

/** Clicks the visible alert's close button (MUI names it "Close"). */
function dismissVisible(): void {
  const close = document.querySelector<HTMLButtonElement>(
    '.MuiAlert-action button'
  );
  assert.ok(close, 'the visible alert should expose a dismiss button');
  fireEvent.click(close);
}

before(async () => {
  cleanupDom = globalJsdom();
  AppNoticeHost = (await import('./AppNoticeHost')).default;
});

afterEach(() => {
  cleanup();
});

after(() => {
  cleanupDom?.();
});

describe('AppNoticeHost', () => {
  it('shows one notice at a time and advances after dismissal', () => {
    const view = render(<AppNoticeHost />);
    act(() => {
      notifyApp('first failure');
      notifyApp('second failure');
    });

    // A single slot used to let the second notice overwrite the first before
    // the user could read it; the queue shows the head only.
    assert.equal(visibleMessage(), 'first failure');
    assert.equal(view.queryByText('second failure'), null);

    dismissVisible();
    assert.equal(visibleMessage(), 'second failure');
    assert.equal(view.queryByText('first failure'), null);
  });

  it('keeps the head plus only the newest pending notices', () => {
    const view = render(<AppNoticeHost />);
    act(() => {
      for (const message of ['a', 'b', 'c', 'd', 'e', 'f']) notifyApp(message);
    });

    // Head is a; pending b,c,d fill the queue, then e and f evict the oldest
    // pending entries — so the visible order is a, d, e, f and b/c never show.
    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      seen.push(visibleMessage());
      dismissVisible();
    }
    assert.deepEqual(seen, ['a', 'd', 'e', 'f']);
    assert.equal(view.queryByText('b'), null);
    assert.equal(view.queryByText('c'), null);
    // Queue drained: the alert collapses back to an empty shell, not a stale
    // message.
    assert.equal(visibleMessage(), '');
  });
});
