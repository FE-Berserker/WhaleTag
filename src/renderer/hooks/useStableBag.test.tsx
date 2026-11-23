import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@testing-library/react';

import { useStableBag } from './useStableBag';

let cleanupDom: (() => void) | undefined;

before(() => {
  cleanupDom = globalJsdom();
});

afterEach(() => cleanup());
after(() => cleanupDom?.());

/** Captures the reference `useStableBag` returned for a given render. */
function Probe({
  bag,
  seen,
}: {
  bag: Record<string, unknown>;
  seen: { current: Record<string, unknown> | null };
}) {
  seen.current = useStableBag(bag);
  return null;
}

/**
 * `useStableBag` replaces the hand-maintained dependency arrays of
 * `FileList`'s `commandsDeps` / `cellData`. Its contract is exactly what a
 * complete dependency array would give: a new bag whenever any field changes,
 * the previous object when none did.
 */
describe('useStableBag', () => {
  it('keeps the previous object when every field is unchanged', () => {
    const seen = { current: null as Record<string, unknown> | null };
    const stable = { onOpen: () => undefined };
    const first = { ...stable, count: 1 };
    const view = render(<Probe bag={first} seen={seen} />);
    const initial = seen.current;
    assert.equal(initial, first);

    view.rerender(<Probe bag={{ ...stable, count: 1 }} seen={seen} />);
    assert.equal(seen.current, initial, 'flat bag with equal fields stays identical');
  });

  it('returns the new object when a field changes', () => {
    const seen = { current: null as Record<string, unknown> | null };
    const handler = () => undefined;
    const view = render(<Probe bag={{ handler, count: 1 }} seen={seen} />);
    const initial = seen.current;

    view.rerender(<Probe bag={{ handler, count: 2 }} seen={seen} />);
    assert.notEqual(seen.current, initial);
    assert.equal((seen.current as Record<string, unknown>).count, 2);
  });

  it('returns the new object when a field is added or removed', () => {
    const seen = { current: null as Record<string, unknown> | null };
    const handler = () => undefined;
    const view = render(<Probe bag={{ handler }} seen={seen} />);
    const initial = seen.current;

    view.rerender(<Probe bag={{ handler, extra: undefined }} seen={seen} />);
    assert.notEqual(seen.current, initial, 'key-count change must not be skipped');

    const second = seen.current;
    view.rerender(<Probe bag={{ handler }} seen={seen} />);
    assert.notEqual(seen.current, second);
  });

  it('hands back the same object when the caller reuses one literal', () => {
    const seen = { current: null as Record<string, unknown> | null };
    const bag = { handler: () => undefined };
    const view = render(<Probe bag={bag} seen={seen} />);

    view.rerender(<Probe bag={bag} seen={seen} />);
    assert.equal(seen.current, bag);
  });

  it('compares with Object.is, so -0 counts as a change from 0', () => {
    const seen = { current: null as Record<string, unknown> | null };
    const view = render(<Probe bag={{ value: 0 }} seen={seen} />);
    const initial = seen.current;

    // A naive `===` comparison would treat 0 and -0 as the same value and keep
    // the stale bag; `Object.is` (what React itself uses for deps) does not.
    view.rerender(<Probe bag={{ value: -0 }} seen={seen} />);
    assert.notEqual(seen.current, initial);
  });
});
