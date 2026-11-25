/**
 * Co-located tests for the selection/keyboard-focus block extracted from
 * `FileList.tsx` into `file-list/useFileListSelection.ts` (P2 FileList split).
 *
 * The hook owns a mutated-in-place Set plus a revision tick, so these tests
 * assert the user-visible contract instead of internals: which paths end up
 * selected after a gesture, what the tri-state select-all reports, and that a
 * directory change drops the previous folder's selection. Uses the
 * `useStableBag.test.tsx` Probe pattern (no `renderHook` needed).
 */
import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, cleanup, render } from '@testing-library/react';

import type { DirEntry } from '../../../shared/ipc-types';
import {
  useFileListSelection,
  type FileListSelection,
} from './useFileListSelection';

let cleanupDom: (() => void) | undefined;

before(() => {
  cleanupDom = globalJsdom();
});
afterEach(() => cleanup());
after(() => cleanupDom?.());

function entry(name: string): DirEntry {
  return {
    name,
    path: `/root/${name}`,
    isFile: true,
    isDirectory: false,
    size: 0,
    modified: '1970-01-01T00:00:00.000Z',
    extension: '',
  };
}

const A = entry('a.txt');
const B = entry('b.txt');
const C = entry('c.txt');

interface ProbeProps {
  visible: DirEntry[];
  directory?: string;
  ensureTrayVisible?: () => void;
  seen: { current: FileListSelection | null };
}

function Probe({
  visible,
  directory = '/root',
  ensureTrayVisible = () => undefined,
  seen,
}: ProbeProps) {
  seen.current = useFileListSelection({
    visible,
    currentDirectoryPath: directory,
    ensureTrayVisible,
  });
  return null;
}

function mount(visible: DirEntry[] = [A, B, C]) {
  const seen = { current: null as FileListSelection | null };
  const view = render(<Probe visible={visible} seen={seen} />);
  const selection = () => {
    if (!seen.current) throw new Error('hook not rendered');
    return seen.current;
  };
  return { view, seen, selection };
}

function selectedNames(selection: () => FileListSelection): string[] {
  return selection().selectedEntries.map((e) => e.name);
}

describe('useFileListSelection — gestures', () => {
  it('plain click single-selects the row and reveals the tray', () => {
    let trayRequests = 0;
    const seen = { current: null as FileListSelection | null };
    render(
      <Probe
        visible={[A, B, C]}
        seen={seen}
        ensureTrayVisible={() => {
          trayRequests += 1;
        }}
      />
    );
    act(() => seen.current!.selectRow(1, { shift: false, toggle: false }));

    assert.deepEqual(selectedNames(() => seen.current!), ['b.txt']);
    assert.equal(trayRequests, 1);
    assert.equal(seen.current!.focusIndex, 1, 'click moves the keyboard cursor');
    assert.equal(seen.current!.selectAllState, 'indeterminate');
  });

  it('ctrl/cmd click toggles a row on and off', () => {
    const { seen, selection } = mount();
    act(() => selection().selectRow(1, { shift: false, toggle: false }));
    act(() => selection().selectRow(2, { shift: false, toggle: true }));
    assert.deepEqual(selectedNames(selection), ['b.txt', 'c.txt']);

    act(() => selection().selectRow(2, { shift: false, toggle: true }));
    assert.deepEqual(selectedNames(selection), ['b.txt']);
    assert.equal(seen.current!.selectAllState, 'indeterminate');
  });

  it('shift-click extends the inclusive range from the anchor', () => {
    const { selection } = mount();
    act(() => selection().selectRow(2, { shift: false, toggle: false }));
    act(() => selection().selectRow(0, { shift: true, toggle: false }));

    assert.deepEqual(selectedNames(selection), ['a.txt', 'b.txt', 'c.txt']);
    assert.equal(selection().selectAllState, 'checked');

    // A follow-up shift-click re-extends from the same anchor (row 2).
    act(() => selection().selectRow(1, { shift: true, toggle: false }));
    assert.deepEqual(selectedNames(selection), ['a.txt', 'b.txt', 'c.txt']);
  });

  it('ignores out-of-range indices', () => {
    const { selection } = mount();
    act(() => selection().selectRow(99, { shift: false, toggle: false }));

    assert.deepEqual(selectedNames(selection), []);
    assert.equal(selection().focusIndex, null);
  });

  it('Escape-style clearSelection empties the set and the anchor', () => {
    const { selection } = mount();
    act(() => selection().selectRow(0, { shift: false, toggle: false }));
    act(() => selection().clearSelection());

    assert.deepEqual(selectedNames(selection), []);
    assert.equal(selection().selectAllState, 'unchecked');
    // The anchor was dropped, so a later shift-click cannot resurrect a range.
    act(() => selection().selectRow(1, { shift: true, toggle: false }));
    assert.deepEqual(selectedNames(selection), ['b.txt']);
  });

  it('shift-range follows the anchor PATH across a filter change (the anchor moves index)', () => {
    const { view, seen, selection } = mount();
    act(() => selection().selectRow(2, { shift: false, toggle: false })); // C at index 2
    assert.deepEqual(selectedNames(selection), ['c.txt']);

    // B is filtered out: C now sits at index 1. A shift-click on A (index 0)
    // must extend from C's NEW position, not from stale index 2 (B).
    view.rerender(<Probe visible={[A, C]} seen={seen} />);
    act(() => seen.current!.selectRow(0, { shift: true, toggle: false }));

    assert.deepEqual(selectedNames(() => seen.current!), ['a.txt', 'c.txt']);
  });

  it('shift-click with a stale anchor (no longer visible) degrades to a plain click', () => {
    const { view, seen, selection } = mount();
    act(() => selection().selectRow(2, { shift: false, toggle: false })); // C

    // C itself is filtered out — the stored index 2 is past the end of the
    // new list. Previously the range loop threw (visible[2] undefined) before
    // bumpSelection, leaving a half-applied selection in the Set.
    view.rerender(<Probe visible={[A, B]} seen={seen} />);
    assert.doesNotThrow(() => {
      act(() => seen.current!.selectRow(1, { shift: true, toggle: false }));
    });

    assert.deepEqual(selectedNames(() => seen.current!), ['b.txt']);
    assert.equal(seen.current!.selectedPathsRef.current.has(C.path), false);
    assert.equal(seen.current!.focusIndex, 1);
  });
});

describe('useFileListSelection — select all', () => {
  it('fills every visible row, then clears on the second toggle', () => {
    const { selection } = mount();
    act(() => selection().toggleSelectAll());
    assert.deepEqual(selectedNames(selection), ['a.txt', 'b.txt', 'c.txt']);
    assert.equal(selection().selectAllState, 'checked');

    act(() => selection().toggleSelectAll());
    assert.deepEqual(selectedNames(selection), []);
    assert.equal(selection().selectAllState, 'unchecked');
  });

  it('keeps out-of-filter selections when filling the visible set', () => {
    const { view, seen, selection } = mount([A, B]);
    act(() => selection().selectRow(0, { shift: false, toggle: false }));

    // Filter C out of the list; the reference path stays selected.
    view.rerender(<Probe visible={[B]} seen={seen} />);
    act(() => seen.current!.toggleSelectAll());

    assert.deepEqual(selectedNames(() => seen.current!), ['b.txt']);
    assert.equal(seen.current!.selectedPathsRef.current.has(C.path), false);
    assert.equal(seen.current!.selectedPathsRef.current.has(A.path), true);
    assert.equal(
      seen.current!.selectAllState,
      'checked',
      'select-all state only counts the visible list'
    );
  });
});

describe('useFileListSelection — lifecycle', () => {
  it('drops the selection when the directory changes', () => {
    const { view, seen, selection } = mount();
    act(() => selection().selectRow(1, { shift: false, toggle: false }));
    assert.deepEqual(selectedNames(selection), ['b.txt']);

    view.rerender(<Probe visible={[A, B, C]} directory="/other" seen={seen} />);
    assert.deepEqual(selectedNames(() => seen.current!), []);
  });

  it('setSelected aliases an unchanged Set and replaces a new one', () => {
    const { selection } = mount();
    const initial = selection().selectedPathsRef.current;

    act(() => selection().setSelected((prev) => prev));
    assert.equal(
      selection().selectedPathsRef.current,
      initial,
      'no-op updater must not allocate a new Set'
    );

    act(() =>
      selection().setSelected((prev) => {
        const next = new Set(prev);
        next.add(B.path);
        return next;
      })
    );
    assert.notEqual(selection().selectedPathsRef.current, initial);
    assert.deepEqual(selectedNames(selection), ['b.txt']);
  });
});
