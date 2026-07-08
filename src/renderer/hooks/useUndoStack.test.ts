/**
 * P3-3: lock down the undo-stack contract used by Mapique's geo mutations
 * (set / clear). The hook is small but its LIFO + drop-oldest semantics are
 * the foundation the rest of the feature relies on.
 *
 * We test the underlying state machine by extracting the operations into
 * pure helpers in the implementation file, then exercising them directly.
 * This avoids any DOM/jsdom dependency for an otherwise pure data
 * structure and keeps the test fast and free of test-runner memory
 * surprises.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pushItem, popItem, makeStack } from './useUndoStack-impl';

describe('undo stack primitives', () => {
  it('pushItem appends', () => {
    assert.deepEqual(pushItem([], 1, 20), [1]);
    assert.deepEqual(pushItem([1], 2, 20), [1, 2]);
  });

  it('pushItem drops oldest past capacity', () => {
    assert.deepEqual(pushItem([1, 2, 3], 4, 3), [2, 3, 4]);
    assert.deepEqual(pushItem([1, 2, 3], 4, 2), [3, 4]);
  });

  it('popItem returns the top of stack or null when empty', () => {
    assert.equal(popItem([]).item, null);
    assert.equal(popItem([1, 2, 3]).item, 3);
  });

  it('popItem does not mutate the input', () => {
    const input = [1, 2, 3];
    const before = input.slice();
    popItem(input);
    assert.deepEqual(input, before);
  });

  it('makeStack starts empty with canUndo false', () => {
    const s = makeStack();
    assert.equal(s.canUndo(), false);
    assert.equal(s.pop(), null);
  });

  it('makeStack push + pop + canUndo contract', () => {
    const s = makeStack();
    s.push(1);
    s.push(2);
    assert.equal(s.canUndo(), true);
    assert.equal(s.pop(), 2);
    assert.equal(s.pop(), 1);
    assert.equal(s.canUndo(), false);
    assert.equal(s.pop(), null);
  });

  it('makeStack respects the capacity argument (drops oldest)', () => {
    const s = makeStack(3);
    s.push(1);
    s.push(2);
    s.push(3);
    s.push(4);
    // Only the last 3 survive: [2, 3, 4].
    assert.equal(s.pop(), 4);
    assert.equal(s.pop(), 3);
    assert.equal(s.pop(), 2);
    assert.equal(s.pop(), null);
  });

  it('makeStack.clear empties the stack', () => {
    const s = makeStack();
    s.push(1);
    s.push(2);
    s.clear();
    assert.equal(s.canUndo(), false);
    assert.equal(s.pop(), null);
  });

  it('handles 100 pushes with capacity 20 — keeps the most recent 20', () => {
    const s = makeStack<number>(20);
    for (let i = 0; i < 100; i += 1) s.push(i);
    const out: number[] = [];
    let v: number | null;
    while ((v = s.pop()) !== null) out.push(v);
    assert.deepEqual(out, [
      99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86, 85, 84, 83, 82, 81,
      80,
    ]);
  });

  it('returns objects by reference (does not clone)', () => {
    const s = makeStack<object>(5);
    const item = { entry: 'x', lat: 1, lng: 2 };
    s.push(item);
    assert.strictEqual(s.pop(), item);
  });
});