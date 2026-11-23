/**
 * Co-located tests for the keyboard-navigation block extracted out of
 * `FileList.tsx` into `file-list/keyboard.ts` (P2 FileList split).
 *
 * The handler is a pure factory over its call-time deps, so the whole
 * key→action matrix can be driven without mounting React: each test builds a
 * spy bag, feeds a minimal keyboard event, and asserts which sink fired. The
 * only DOM dependency is `isInputLike`'s `HTMLElement` check, hence
 * `global-jsdom` in `before()` (same pattern as `useStableBag.test.tsx`).
 */
import globalJsdom from 'global-jsdom';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { KeyboardEvent, MutableRefObject } from 'react';

import type { DirEntry } from '../../../shared/ipc-types';
import type { ViewMode } from '../../../shared/whale-meta';
import { DEFAULT_KEYBINDINGS, type KeyAction } from '../../domain/keybindings';
import {
  createKeyDownHandler,
  isInputLike,
  type FileListKeyDownDeps,
} from './keyboard';

let cleanupDom: (() => void) | undefined;

before(() => {
  cleanupDom = globalJsdom();
});

after(() => cleanupDom?.());

function entry(name: string, path = `/root/${name}`): DirEntry {
  return {
    name,
    path,
    isFile: true,
    isDirectory: false,
    size: 0,
    modified: '1970-01-01T00:00:00.000Z',
    extension: name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '',
  };
}

interface Calls {
  select: [number, { shift: boolean; toggle: boolean }][];
  focus: (number | null)[];
  clear: number;
  open: string[];
  rename: string[];
  deleted: number;
  notice: [string, string | undefined][];
  back: number;
  view: ViewMode[];
}

function makeDeps(overrides: Partial<FileListKeyDownDeps> = {}): {
  deps: FileListKeyDownDeps;
  calls: Calls;
  selectedPathsRef: MutableRefObject<Set<string>>;
} {
  const calls: Calls = {
    select: [],
    focus: [],
    clear: 0,
    open: [],
    rename: [],
    deleted: 0,
    notice: [],
    back: 0,
    view: [],
  };
  const selectedPathsRef: MutableRefObject<Set<string>> = {
    current: new Set<string>(),
  };
  const deps: FileListKeyDownDeps = {
    keybindings: DEFAULT_KEYBINDINGS,
    visible: [entry('a.txt'), entry('b.txt'), entry('c.txt')],
    focusIndex: null,
    setFocusIndex: (index) => calls.focus.push(index),
    selectRow: (index, mods) => calls.select.push([index, mods]),
    clearSelection: () => {
      calls.clear += 1;
    },
    selectedPathsRef,
    onOpen: (e) => calls.open.push(e.path),
    onStartInlineRename: (e) => calls.rename.push(e.path),
    onDeleteSelected: () => {
      calls.deleted += 1;
    },
    showNotice: (text, severity) => calls.notice.push([text, severity]),
    noRowToRename: 'Nothing to rename',
    canGoBack: false,
    goBack: () => {
      calls.back += 1;
    },
    viewMode: 'list',
    setViewMode: (mode) => calls.view.push(mode),
  };
  return { deps: { ...deps, ...overrides }, calls, selectedPathsRef };
}

/** Minimal keyboard event: the handler only reads `key` / `shiftKey` / `target`. */
function fire(
  handler: ReturnType<typeof createKeyDownHandler>,
  key: string,
  {
    shiftKey = false,
    target = null,
  }: { shiftKey?: boolean; target?: EventTarget | null } = {}
): { prevented: boolean } {
  let prevented = false;
  const event = {
    key,
    shiftKey,
    target,
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as KeyboardEvent<HTMLDivElement>;
  handler(event);
  return { prevented };
}

describe('isInputLike', () => {
  it('treats text inputs, textareas and contenteditables as input-like', () => {
    const text = document.createElement('input');
    text.type = 'text';
    const textarea = document.createElement('textarea');
    const editable = document.createElement('div');
    Object.defineProperty(editable, 'isContentEditable', { value: true });

    assert.equal(isInputLike(text), true);
    assert.equal(isInputLike(textarea), true);
    assert.equal(isInputLike(editable), true);
  });

  it('does NOT treat checkboxes or plain elements as input-like', () => {
    // Regression guard: clicking a row's selection checkbox then pressing F2
    // must still reach the handler (the checkbox is the common focus target).
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const div = document.createElement('div');

    assert.equal(isInputLike(checkbox), false);
    assert.equal(isInputLike(div), false);
    assert.equal(isInputLike(null), false);
  });
});

describe('createKeyDownHandler — navigation', () => {
  it('ArrowDown moves from "nothing focused" to row 0 and prevents default', () => {
    const { deps, calls } = makeDeps();
    const { prevented } = fire(createKeyDownHandler(deps), 'ArrowDown');

    assert.equal(prevented, true);
    assert.deepEqual(calls.select, [[0, { shift: false, toggle: false }]]);
  });

  it('ArrowDown / ArrowUp step from the current focus and clamp at the ends', () => {
    const down = makeDeps({ focusIndex: 1 });
    fire(createKeyDownHandler(down.deps), 'ArrowDown');
    assert.deepEqual(down.calls.select, [[2, { shift: false, toggle: false }]]);

    const atLast = makeDeps({ focusIndex: 2 });
    fire(createKeyDownHandler(atLast.deps), 'ArrowDown');
    assert.deepEqual(atLast.calls.select, [], 'already on the last row');

    const up = makeDeps({ focusIndex: 2 });
    fire(createKeyDownHandler(up.deps), 'ArrowUp');
    assert.deepEqual(up.calls.select, [[1, { shift: false, toggle: false }]]);

    const atFirst = makeDeps({ focusIndex: 0 });
    fire(createKeyDownHandler(atFirst.deps), 'ArrowUp');
    assert.deepEqual(atFirst.calls.select, [], 'already on the first row');
  });

  it('Shift+Arrow extends the range instead of moving the cursor only', () => {
    const { deps, calls } = makeDeps({ focusIndex: 0 });
    fire(createKeyDownHandler(deps), 'ArrowDown', { shiftKey: true });

    assert.deepEqual(calls.select, [[1, { shift: true, toggle: false }]]);
  });

  it('Home / End jump to the first / last visible row', () => {
    const home = makeDeps({ focusIndex: 2 });
    fire(createKeyDownHandler(home.deps), 'Home');
    assert.deepEqual(home.calls.select, [[0, { shift: false, toggle: false }]]);

    const end = makeDeps({ focusIndex: null });
    fire(createKeyDownHandler(end.deps), 'End');
    assert.deepEqual(end.calls.select, [[2, { shift: false, toggle: false }]]);
  });

  it('Space toggle-selects the focused row and is normalized from " "', () => {
    const { deps, calls } = makeDeps({ focusIndex: 1 });
    fire(createKeyDownHandler(deps), ' ');

    assert.deepEqual(calls.select, [[1, { shift: false, toggle: true }]]);
  });

  it('Space on an unfocused list is a no-op (no negative index)', () => {
    const { deps, calls } = makeDeps();
    fire(createKeyDownHandler(deps), 'Space');

    assert.deepEqual(calls.select, []);
  });

  it('Escape clears the selection', () => {
    const { deps, calls } = makeDeps({ focusIndex: 1 });
    fire(createKeyDownHandler(deps), 'Escape');

    assert.equal(calls.clear, 1);
  });

  it('Enter opens the focused entry', () => {
    const { deps, calls } = makeDeps({ focusIndex: 1 });
    fire(createKeyDownHandler(deps), 'Enter');

    assert.deepEqual(calls.open, ['/root/b.txt']);
  });

  it('maps keys through the user-configured bindings', () => {
    const { deps, calls } = makeDeps({
      focusIndex: 1,
      keybindings: { ...DEFAULT_KEYBINDINGS, ArrowDown: 'jumpHome' } as Record<
        string,
        KeyAction
      >,
    });
    fire(createKeyDownHandler(deps), 'ArrowDown');

    assert.deepEqual(calls.select, [[0, { shift: false, toggle: false }]]);
  });
});

describe('createKeyDownHandler — Delete', () => {
  it('deletes even on an empty list (runs before the empty-list guard)', () => {
    const { deps, calls } = makeDeps({ visible: [] });
    const { prevented } = fire(createKeyDownHandler(deps), 'Delete');

    assert.equal(prevented, true);
    assert.equal(calls.deleted, 1);
  });
});

describe('createKeyDownHandler — F2 rename', () => {
  it('renames the focused row and keeps the cursor on it', () => {
    const { deps, calls } = makeDeps({ focusIndex: 2 });
    fire(createKeyDownHandler(deps), 'F2');

    assert.deepEqual(calls.rename, ['/root/c.txt']);
    assert.deepEqual(calls.focus, []);
  });

  it('falls back to the single selected entry when nothing is focused', () => {
    const { deps, calls, selectedPathsRef } = makeDeps();
    selectedPathsRef.current.add('/root/b.txt');
    fire(createKeyDownHandler(deps), 'F2');

    assert.deepEqual(calls.rename, ['/root/b.txt']);
    assert.deepEqual(calls.focus, [1], 'cursor lands on the renamed row');
  });

  it('falls back to the first visible row when nothing at all is focused', () => {
    const first = makeDeps();
    fire(createKeyDownHandler(first.deps), 'F2');
    assert.deepEqual(first.calls.rename, ['/root/a.txt']);
  });

  it('F2 on an empty list is a no-op (the empty-list guard runs first)', () => {
    // Matches the pre-extraction ordering: the `last < 0` return sits before
    // the action switch, so F2 cannot reach the rename case on an empty list —
    // the `noRowToRename` notice is unreachable from this path.
    const empty = makeDeps({ visible: [] });
    const { prevented } = fire(createKeyDownHandler(empty.deps), 'F2');
    assert.deepEqual(empty.calls.rename, []);
    assert.deepEqual(empty.calls.notice, []);
    assert.equal(prevented, false);
  });
});

describe('createKeyDownHandler — history / view switching', () => {
  it('ArrowLeft goes back only when there is history, and only then prevents default', () => {
    const blocked = makeDeps({ canGoBack: false });
    const blockedEvent = fire(createKeyDownHandler(blocked.deps), 'ArrowLeft');
    assert.equal(blocked.calls.back, 0);
    assert.equal(blockedEvent.prevented, false);

    const allowed = makeDeps({ canGoBack: true });
    const allowedEvent = fire(createKeyDownHandler(allowed.deps), 'ArrowLeft');
    assert.equal(allowed.calls.back, 1);
    assert.equal(allowedEvent.prevented, true);
  });

  it('Tab cycles the view only when explicitly bound (default leaves it native)', () => {
    const unbound = makeDeps();
    const native = fire(createKeyDownHandler(unbound.deps), 'Tab');
    assert.deepEqual(unbound.calls.view, []);
    assert.equal(native.prevented, false, 'native focus traversal must survive');

    const bound = makeDeps({
      viewMode: 'list',
      keybindings: { ...DEFAULT_KEYBINDINGS, Tab: 'switchView' },
    });
    const swallowed = fire(createKeyDownHandler(bound.deps), 'Tab');
    assert.deepEqual(bound.calls.view, ['grid']);
    assert.equal(swallowed.prevented, true);
  });
});

describe('createKeyDownHandler — input-like targets', () => {
  it('ignores every shortcut while the user is typing in a text field', () => {
    const input = document.createElement('input');
    input.type = 'text';
    const { deps, calls } = makeDeps({ focusIndex: 0, visible: [] });
    const { prevented } = fire(createKeyDownHandler(deps), 'Delete', {
      target: input,
    });

    assert.equal(prevented, false);
    assert.equal(calls.deleted, 0);
    assert.deepEqual(calls.select, []);
  });
});
