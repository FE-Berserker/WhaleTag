import globalJsdom from 'global-jsdom';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { HostMessage } from '../../shared/extension-types';
import { useWhaleBridge } from './useWhaleBridge';

describe('useWhaleBridge save handler lifecycle', () => {
  let jsdomCleanup: (() => void) | null = null;

  before(() => {
    jsdomCleanup = globalJsdom() as unknown as () => void;
  });

  afterEach(() => {
    cleanup();
  });

  after(() => {
    jsdomCleanup?.();
  });

  it('unregisters only its own requestSave handler', () => {
    const hostListeners: Array<(msg: HostMessage) => void> = [];
    Object.defineProperty(window, 'whaleExt', {
      configurable: true,
      value: {
        locale: 'en',
        postMessage() {},
        onMessage(listener: (msg: HostMessage) => void) {
          hostListeners.push(listener);
          return () => {};
        },
      },
    });
    const { result } = renderHook(() => useWhaleBridge());
    let firstCalls = 0;
    let secondCalls = 0;
    const unregisterFirst = result.current.onRequestSave(() => {
      firstCalls += 1;
    });
    const unregisterSecond = result.current.onRequestSave(() => {
      secondCalls += 1;
    });
    const requestSave = () => {
      hostListeners.forEach((listener) =>
        listener({ type: 'requestSave', path: '/tmp/diagram.drawio' })
      );
    };

    unregisterFirst();
    act(requestSave);
    assert.equal(firstCalls, 0, 'stale cleanup must not remove the new handler');
    assert.equal(secondCalls, 1);

    unregisterSecond();
    unregisterSecond();
    act(requestSave);
    assert.equal(secondCalls, 1, 'unregistered handlers must not run');
  });
});
