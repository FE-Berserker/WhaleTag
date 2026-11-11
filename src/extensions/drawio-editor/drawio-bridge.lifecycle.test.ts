import globalJsdom from 'global-jsdom';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, renderHook } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { useDrawioBridge } from './drawio-bridge';

const noop = () => {};

describe('useDrawioBridge lifecycle', () => {
  let jsdomCleanup: (() => void) | null = null;
  let originalSetTimeout: typeof window.setTimeout;
  let originalClearTimeout: typeof window.clearTimeout;
  let originalAddEventListener: typeof window.addEventListener;
  let originalRemoveEventListener: typeof window.removeEventListener;

  before(() => {
    jsdomCleanup = globalJsdom() as unknown as () => void;
    originalSetTimeout = window.setTimeout;
    originalClearTimeout = window.clearTimeout;
    originalAddEventListener = window.addEventListener;
    originalRemoveEventListener = window.removeEventListener;
  });

  afterEach(() => {
    cleanup();
    window.setTimeout = originalSetTimeout;
    window.clearTimeout = originalClearTimeout;
    window.addEventListener = originalAddEventListener;
    window.removeEventListener = originalRemoveEventListener;
    document.body.replaceChildren();
  });

  after(() => {
    jsdomCleanup?.();
  });

  function trackRequestTimers() {
    const scheduled: number[] = [];
    const cleared: number[] = [];
    window.setTimeout = ((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      const id = originalSetTimeout.call(window, handler, timeout, ...args);
      if (timeout === 5000) scheduled.push(id);
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => {
      if (id !== undefined) cleared.push(id);
      originalClearTimeout.call(window, id);
    }) as typeof window.clearTimeout;
    return { scheduled, cleared };
  }

  it('removes the exact message listener on unmount', () => {
    const added: EventListenerOrEventListenerObject[] = [];
    const removed: EventListenerOrEventListenerObject[] = [];
    window.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions
    ) => {
      if (type === 'message' && listener) added.push(listener);
      originalAddEventListener.call(window, type, listener, options);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions
    ) => {
      if (type === 'message' && listener) removed.push(listener);
      originalRemoveEventListener.call(window, type, listener, options);
    }) as typeof window.removeEventListener;

    const { unmount } = renderHook(() => useDrawioBridge(noop, noop));
    assert.equal(added.length, 1);
    unmount();
    assert.deepEqual(removed, added);
  });

  it('clears every request timer when drawio returns XML', async () => {
    const timers = trackRequestTimers();
    let changes = 0;
    const { result, rerender } = renderHook(
      ({ onChange }) => useDrawioBridge(onChange, noop),
      { initialProps: { onChange: () => { changes += 1; } } }
    );
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    (result.current.iframeRef as MutableRefObject<HTMLIFrameElement | null>).current =
      iframe;

    const first = result.current.bridge.getXml();
    const second = result.current.bridge.getXml();
    assert.equal(timers.scheduled.length, 2);

    // Updating callback identity rebinds the listener but must not tear down
    // the bridge or reject its in-flight requests.
    rerender({ onChange: () => { changes += 1; } });
    assert.deepEqual(timers.cleared, []);
    window.dispatchEvent(new window.MessageEvent('message', {
      source: iframe.contentWindow,
      data: JSON.stringify({ event: 'export', xml: '<mxfile/>' }),
    }));

    assert.deepEqual(await Promise.all([first, second]), [
      '<mxfile/>',
      '<mxfile/>',
    ]);
    assert.equal(changes, 1);
    assert.deepEqual(timers.cleared, timers.scheduled);
  });

  it('rejects pending requests and clears their timers on unmount', async () => {
    const timers = trackRequestTimers();
    const { result, unmount } = renderHook(() =>
      useDrawioBridge(noop, noop)
    );
    const first = result.current.bridge.getXml();
    const second = result.current.bridge.getXml();
    const rejection = assert.rejects(
      Promise.all([first, second]),
      /draw\.io bridge destroyed/
    );

    unmount();
    await rejection;
    assert.deepEqual(timers.cleared, timers.scheduled);
    await assert.rejects(
      result.current.bridge.getXml(),
      /draw\.io bridge destroyed/
    );
    assert.equal(timers.scheduled.length, 2, 'no new timer after teardown');
  });
});
