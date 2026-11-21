import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bindWindowPan, type PanEventTarget } from './media-pan';

type PanType = 'mousemove' | 'mouseup';
type PanListener = (event: MouseEvent) => void;

function makeTarget() {
  const listeners: Record<PanType, Set<PanListener>> = {
    mousemove: new Set(),
    mouseup: new Set(),
  };
  const removals: PanType[] = [];
  const target: PanEventTarget = {
    addEventListener(type, listener) {
      listeners[type].add(listener);
    },
    removeEventListener(type, listener) {
      if (listeners[type].delete(listener)) removals.push(type);
    },
  };
  return {
    target,
    listeners,
    removals,
    emit(type: PanType) {
      for (const listener of [...listeners[type]]) {
        listener({ clientX: 10, clientY: 20 } as MouseEvent);
      }
    },
  };
}

describe('bindWindowPan', () => {
  it('forwards movement and removes both listeners through an idempotent cleanup', () => {
    const fake = makeTarget();
    const moves: number[] = [];
    let ups = 0;
    const cleanup = bindWindowPan(
      fake.target,
      (event) => moves.push(event.clientX),
      () => {
        ups += 1;
      }
    );

    fake.emit('mousemove');
    assert.deepEqual(moves, [10]);
    cleanup();
    cleanup();
    assert.equal(fake.listeners.mousemove.size, 0);
    assert.equal(fake.listeners.mouseup.size, 0);
    assert.deepEqual(fake.removals.sort(), ['mousemove', 'mouseup']);

    fake.emit('mousemove');
    fake.emit('mouseup');
    assert.deepEqual(moves, [10]);
    assert.equal(ups, 0);
  });

  it('cleans up before mouseup notification and tolerates later cleanup', () => {
    const fake = makeTarget();
    let ups = 0;
    let listenersAtUp = -1;
    const cleanup = bindWindowPan(fake.target, () => undefined, () => {
      ups += 1;
      listenersAtUp = fake.listeners.mousemove.size + fake.listeners.mouseup.size;
    });

    fake.emit('mouseup');
    assert.equal(ups, 1);
    assert.equal(listenersAtUp, 0);
    cleanup();
    fake.emit('mouseup');
    assert.equal(ups, 1);
    assert.deepEqual(fake.removals.sort(), ['mousemove', 'mouseup']);
  });

  it('an older disposer cannot remove a newer gesture listeners', () => {
    const fake = makeTarget();
    const firstCleanup = bindWindowPan(fake.target, () => undefined, () => undefined);
    const secondCleanup = bindWindowPan(fake.target, () => undefined, () => undefined);

    firstCleanup();
    assert.equal(fake.listeners.mousemove.size, 1);
    assert.equal(fake.listeners.mouseup.size, 1);
    secondCleanup();
    assert.equal(fake.listeners.mousemove.size, 0);
    assert.equal(fake.listeners.mouseup.size, 0);
  });
});
