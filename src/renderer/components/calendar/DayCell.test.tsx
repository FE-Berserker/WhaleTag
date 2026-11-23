/**
 * task-17 (P2 split): co-located tests for the extracted `DayCell` sub-component.
 *
 * DayCell is the original CalendarView day tile: grid-cell ARIA, entry rendering,
 * empty hint, left-click-to-create, and the right-click create menu. These tests
 * pin the behaviour that moved out of CalendarView.tsx so future edits to the
 * split can't silently regress it.
 *
 * Harness mirrors CalendarView.test.tsx: node:test + global-jsdom +
 * @testing-library/react; MUI is imported only after jsdom is up (Emotion
 * picks its non-forwardRef wrappers at module-load time).
 */

import globalJsdom from 'global-jsdom';

import { before, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { createStore } from 'redux';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';

import type { DirEntry } from '../../../shared/ipc-types';
import type { FileCellData } from '../file-cell';
import type { CalendarDay } from '../../domain/calendar';
import { CurrentLocationContext } from '../../hooks/CurrentLocationContextProvider';
import {
  DirectoryContentContext,
  DirectoryUIContext,
} from '../../hooks/DirectoryContentContextProvider';
import { DirectoryTreeRefreshContextProvider } from '../../hooks/DirectoryTreeRefreshContextProvider';

const STUB_STORE = createStore(() => ({
  settings: { officeThumbnailEnabled: false, sofficePath: null },
}));

/** Stub location context — only read by the IOActions provider stack below. */
const LOCATION_CTX_STUB = {
  currentLocation: null,
  currentDirectoryPath: '',
  openLocation: () => {},
  navigateTo: () => {},
  navigateToInLocation: () => {},
  goUp: async () => {},
  canGoBack: false,
  canGoForward: false,
  goBack: () => {},
  goForward: () => {},
};

/** Directory content stub — IOActions only dereferences these lazily. */
const DIR_CONTENT_STUB = {
  entries: [],
  dirs: [],
  loading: false,
  error: null,
  sort: { key: 'name' as const, dir: 'asc' as const },
  setSort: () => {},
  refresh: async () => {},
  viewMode: 'list' as const,
  entrySize: 160,
  setViewMode: () => {},
  setEntrySize: () => {},
  tagsByName: new Map<string, string[]>(),
  descByName: new Map<string, string>(),
  geoByName: new Map<string, { lat: number; lng: number } | null>(),
  recursiveTruncated: false,
};

let DayCell: typeof import('./DayCell').DayCell;
let IOActionsContextProvider: typeof import('../../hooks/IOActionsContextProvider').IOActionsContextProvider;

/** i18n stub: returns the key (or key|opts format), matching CalendarView.test. */
function makeT(): FileCellData['t'] {
  return ((key: string, opts?: Record<string, unknown>): string => {
    if (!opts) return key;
    const parts = Object.keys(opts)
      .sort()
      .map((k) => `${k}=${String(opts[k])}`);
    return `${key}|${parts.join('&')}`;
  }) as FileCellData['t'];
}

function entry(name: string, modified = '2026-01-15T10:00:00.000Z'): DirEntry {
  const dot = name.lastIndexOf('.');
  return {
    name,
    path: `/root/${name}`,
    isFile: true,
    isDirectory: false,
    size: 0,
    modified,
    extension: dot >= 0 ? name.slice(dot + 1).toLowerCase() : '',
  };
}

function makeData(entries: DirEntry[] = []): FileCellData {
  return {
    entries,
    tagsByName: new Map(),
    descByName: new Map(),
    activeTag: null,
    tagColors: {},
    groups: [],
    readOnly: false,
    t: makeT(),
    thumbCache: new Map(),
    isSelected: () => false,
    focusIndex: null,
    columnWidths: { name: 240, size: 64, modified: 96 },
    hiddenColumns: [],
    listZebra: false,
    listDateFormat: 'absolute',
    inlineRenameEntry: null,
    startInlineRename: () => {},
    cancelInlineRename: () => {},
    commitInlineRename: async () => {},
    onSelectRow: () => {},
    onOpen: () => {},
    onClickTag: () => {},
    onTagContextMenu: () => {},
    onDropTag: () => {},
    onDropFiles: () => {},
    onContextEntry: () => {},
    onCreateTagged: () => {},
    onCopy: () => {},
    onMove: () => {},
    onRename: () => {},
    onDelete: () => {},
  };
}

const DAY: CalendarDay = {
  date: new Date(2026, 0, 15),
  inCurrentMonth: true,
  key: '2026-01-15',
};

function renderCell(
  data: FileCellData,
  entries: DirEntry[] = [],
  props: Partial<{
    showEmptyHint: boolean;
    entryTimeLabel: (e: DirEntry) => string | null;
  }> = {}
) {
  return render(
    <Provider store={STUB_STORE}>
      <DndProvider backend={HTML5Backend}>
        <CurrentLocationContext.Provider value={LOCATION_CTX_STUB}>
          <DirectoryContentContext.Provider value={DIR_CONTENT_STUB}>
            <DirectoryUIContext.Provider value={DIR_CONTENT_STUB}>
              <DirectoryTreeRefreshContextProvider>
                <IOActionsContextProvider>
                  <DayCell
                    day={DAY}
                    entries={entries}
                    data={data}
                    showEmptyHint={props.showEmptyHint ?? false}
                    entryTimeLabel={props.entryTimeLabel}
                  />
                </IOActionsContextProvider>
              </DirectoryTreeRefreshContextProvider>
            </DirectoryUIContext.Provider>
          </DirectoryContentContext.Provider>
        </CurrentLocationContext.Provider>
      </DndProvider>
    </Provider>
  );
}

function cell(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[role="gridcell"]') as HTMLElement | null;
  assert.ok(el, 'expected a day cell');
  return el;
}

before(async () => {
  // global-jsdom@29 requires an explicit side-effect call; keep jsdom alive for
  // the whole test process.
  globalJsdom();
  // Load MUI-backed modules only after document exists.
  ({ DayCell } = await import('./DayCell'));
  ({ IOActionsContextProvider } = await import('../../hooks/IOActionsContextProvider'));
});

// The right-click tests open a MUI Menu (portal + transition). Unmount after
// every test so the last menu's transition timer doesn't keep the runner's
// event loop alive (node:test would otherwise hang after the suite).
afterEach(() => cleanup());

describe('DayCell (extracted, task-17)', () => {
  it('renders the grid-cell aria-label with date key and entry count', () => {
    cleanup();
    const { container } = renderCell(makeData([entry('a.txt')]), [entry('a.txt')]);
    assert.equal(
      cell(container).getAttribute('aria-label'),
      'calendarCellAria|count=1&date=2026-01-15'
    );
  });

  it('renders entry names, entry aria-label and the optional time label', () => {
    cleanup();
    const a = entry('a.txt');
    const { container } = renderCell(makeData([a]), [a], {
      entryTimeLabel: () => '10:30',
    });
    const text = container.textContent ?? '';
    assert.ok(text.includes('a.txt'), 'entry name is rendered');
    assert.ok(text.includes('10:30'), 'time label is rendered');
    const row = container.querySelector('[aria-label="calendarEntryAria|name=a.txt"]');
    assert.ok(row, 'entry row keeps its aria-label');
  });

  it('shows the empty hint only when showEmptyHint is set', () => {
    cleanup();
    const { container } = renderCell(makeData(), [], { showEmptyHint: true });
    assert.ok((container.textContent ?? '').includes('noEntriesForDay'));
    cleanup();
    const second = renderCell(makeData(), [], { showEmptyHint: false });
    assert.ok(!(second.container.textContent ?? '').includes('noEntriesForDay'));
  });

  it('left-clicking the empty cell area calls onCreateTagged(kind=file, day tag)', () => {
    cleanup();
    const holder: { kind: string | null; tag: string | null } = {
      kind: null,
      tag: null,
    };
    const data = makeData();
    data.onCreateTagged = (kind, tag) => {
      holder.kind = kind;
      holder.tag = tag;
    };
    const { container } = renderCell(data);
    fireEvent.click(cell(container));
    assert.equal(holder.kind, 'file');
    // resolveSmartTag('today', 2026-01-15) → the YYYYMMDD storage form.
    assert.equal(holder.tag, '20260115');
  });

  it('left-clicking does nothing in readOnly mode', () => {
    cleanup();
    let called = 0;
    const data = makeData();
    data.readOnly = true;
    data.onCreateTagged = () => {
      called += 1;
    };
    const { container } = renderCell(data);
    fireEvent.click(cell(container));
    assert.equal(called, 0);
  });

  it('right-click opens the create menu; choosing newFile creates with the day tag', async () => {
    cleanup();
    const holder: { kind: string | null; tag: string | null } = {
      kind: null,
      tag: null,
    };
    const data = makeData();
    data.onCreateTagged = (kind, tag) => {
      holder.kind = kind;
      holder.tag = tag;
    };
    const { container } = renderCell(data);
    fireEvent.contextMenu(cell(container));

    await waitFor(() => {
      assert.ok((document.body.textContent ?? '').includes('newFile'));
    });
    assert.ok((document.body.textContent ?? '').includes('newFolder'));

    const newFileItem = Array.from(
      document.querySelectorAll('[role="menuitem"]')
    ).find((el) => (el.textContent ?? '').includes('newFile')) as HTMLElement;
    assert.ok(newFileItem, 'newFile menu item must be present');
    fireEvent.click(newFileItem);
    assert.equal(holder.kind, 'file');
    assert.equal(holder.tag, '20260115');
  });

  it('right-click menu items are disabled in readOnly mode', async () => {
    cleanup();
    const data = makeData();
    data.readOnly = true;
    const { container } = renderCell(data);
    fireEvent.contextMenu(cell(container));
    await waitFor(() => {
      assert.ok(document.querySelectorAll('[role="menuitem"]').length >= 2);
    });
    const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
    assert.ok(items.every((el) => el.getAttribute('aria-disabled') === 'true'));
  });
});
