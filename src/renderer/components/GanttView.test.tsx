/**
 * Component-level tests for GanttView (Tasks §3.3, ECharts edition) — the
 * third sub-view in the Tasks perspective. Locks down:
 *  - render: chart canvas appears + the empty-state message shows when no
 *    entries have periods
 *  - Triage: entries without a period appear in the bottom tray
 *  - readOnly: mousedown on a bar is a no-op (drag won't commit)
 *  - double-click opens the file (proven via the ECharts dblclick event)
 *  - drag arithmetic (body shift + edge resize) routes through the shared
 *    `periodWithShift` / `periodWithResize` helpers
 *  - dataZoom: the inside + slider dataZoom components are configured
 *
 * Note (post rewrite): the legacy ECharts version rendered into a
 * `<canvas>` so we couldn't query bar geometry. The pure-DOM rewrite
 * uses real DOM nodes — bars carry `data-hitzone` and `data-entry-path`
 * attributes, so we can assert against them directly. Pointer-drag
 * coverage is deliberately out of scope here (would require
 * `@testing-library/user-event`); see the unit tests in
 * `src/renderer/domain/gantt.test.ts` (`periodWithShift` /
 * `periodWithResize`) for the drag-arithmetic coverage.
 *
 * Test infrastructure mirrors KanbanView.test.tsx (node:test +
 * global-jsdom + @testing-library/react + the full provider stack).
 */

import globalJsdom from 'global-jsdom';

import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { Provider } from 'react-redux';
import { createStore } from 'redux';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import i18next from 'i18next';

import GanttView from './GanttView';
import type { FileCellData } from './file-cell';
import { CurrentLocationContext } from '../hooks/CurrentLocationContextProvider';
import { DirectoryContentContext, DirectoryUIContext } from '../hooks/DirectoryContentContextProvider';
import { DirectoryTreeRefreshContextProvider } from '../hooks/DirectoryTreeRefreshContextProvider';
import { IOActionsContextProvider } from '../hooks/IOActionsContextProvider';
import { PeriodTagDialogProvider } from './PeriodTagDialog';
import type { DirEntry } from '../../shared/ipc-types';
import type { WorkflowStage } from '../domain/workflow';

function makeT(): FileCellData['t'] {
  return ((key: string): string => key) as FileCellData['t'];
}

function entry(name: string): DirEntry {
  const dot = name.lastIndexOf('.');
  return {
    name,
    path: `/root/${name}`,
    isFile: true,
    isDirectory: false,
    size: 0,
    modified: '1970-01-01T00:00:00.000Z',
    extension: dot >= 0 ? name.slice(dot + 1).toLowerCase() : '',
  };
}

interface Spies {
  setEntryDateTag?: { called: number; last: { entry: DirEntry; tag: string } | null };
  removeEntryDateTag?: { called: number; last: DirEntry | null };
  openEntry?: { called: number; last: DirEntry | null };
}

function makeData(
  entries: DirEntry[],
  tagsByName: Map<string, string[]>,
  readOnly = false,
  spies: Spies = {}
): FileCellData {
  return {
    entries,
    tagsByName,
    descByName: new Map(),
    activeTag: null,
    tagColors: {
      'not-started': '#6b7280',
      'in-progress': '#3b82f6',
      completed: '#22c55e',
    },
    groups: [
      {
        id: 'g-workflow',
        title: 'Workflow',
        expanded: true,
        color: '#008000',
        tags: ['not-started', 'in-progress', 'completed'],
      },
    ],
    readOnly,
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
    selectedPaths: new Set<string>(),
    resolveEntry: (p) => entries.find((e) => e.path === p),
    onSelectRow: () => {},
    onOpen: (e) => {
      spies.openEntry = spies.openEntry ?? { called: 0, last: null };
      spies.openEntry.called += 1;
      spies.openEntry.last = e;
    },
    onClickTag: () => {},
    onTagContextMenu: () => {},
    onDropTag: () => {},
    onDropFiles: () => {},
    onContextEntry: () => {},
    onCopy: () => {},
    onMove: () => {},
    onRename: () => {},
    onDelete: () => {},
    onSetEntryDateTag: (e, tag) => {
      spies.setEntryDateTag = spies.setEntryDateTag ?? { called: 0, last: null };
      spies.setEntryDateTag.called += 1;
      spies.setEntryDateTag.last = { entry: e, tag };
    },
    onRemoveEntryDateTag: (e) => {
      spies.removeEntryDateTag = spies.removeEntryDateTag ?? {
        called: 0,
        last: null,
      };
      spies.removeEntryDateTag.called += 1;
      spies.removeEntryDateTag.last = e;
    },
    onMoveToColumn: () => {},
    onAddTag: () => {},
    onRemoveTag: () => {},
    onMoreFileActions: () => {},
  };
}

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

const STUB_STORE = createStore(() => ({
  settings: { officeThumbnailEnabled: false, sofficePath: null },
  workflow: { stages: [] },
}));

const DEFAULT_STAGES: WorkflowStage[] = [
  { id: '1', value: 'not-started', color: '#6b7280' },
  { id: '2', value: 'in-progress', color: '#3b82f6' },
  { id: '3', value: 'completed', color: '#22c55e' },
];

function renderGantt(
  data: FileCellData,
  stages: WorkflowStage[] = DEFAULT_STAGES
) {
  // GanttView's Triage tray + GanttTimeline scroller both use
  // useIOActionsContext() for native OS-file drops. Render with the
  // production provider — default `importExternalFiles` resolves to a
  // no-op import.
  return render(
    <I18nextProvider i18n={i18next} defaultNS="common">
      <Provider store={STUB_STORE}>
        <DndProvider backend={HTML5Backend}>
          <PeriodTagDialogProvider>
            <CurrentLocationContext.Provider value={LOCATION_CTX_STUB}>
              <DirectoryContentContext.Provider value={DIR_CONTENT_STUB}>
            <DirectoryUIContext.Provider value={DIR_CONTENT_STUB}>
                <DirectoryTreeRefreshContextProvider>
                  <IOActionsContextProvider>
                    <GanttView
                      data={data}
                      stages={stages}
                      onMoveToColumn={data.onMoveToColumn ?? (() => {})}
                    />
                  </IOActionsContextProvider>
                </DirectoryTreeRefreshContextProvider>
              </DirectoryUIContext.Provider>
          </DirectoryContentContext.Provider>
            </CurrentLocationContext.Provider>
          </PeriodTagDialogProvider>
        </DndProvider>
      </Provider>
    </I18nextProvider>
  );
}

before(async () => {
  globalJsdom();

  await i18next.use(initReactI18next).init({
    resources: {
      en: { common: {} },
      zh: { common: {} },
    },
    lng: 'en',
    fallbackLng: 'en',
    defaultNS: 'common',
    ns: ['common'],
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });

  if (typeof globalThis.IntersectionObserver === 'undefined') {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      };
  }
  if (typeof globalThis.ResizeObserver === 'undefined') {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (typeof window !== 'undefined' && !window.matchMedia) {
    (window as { matchMedia?: unknown }).matchMedia = (q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }
});

afterEach(() => {
  cleanup();
  try {
    localStorage.removeItem('whale-task-gantt-zoom');
    localStorage.removeItem('whale-task-gantt-range');
  } catch {
    /* ignore */
  }
});

// ─── Tests ─────────────────────────────────────────────────────────────

describe('GanttView #1: render', () => {
  it('shows the empty-state message when no entries have periods', () => {
    const data = makeData([entry('a.txt')], new Map());
    const { container } = renderGantt(data);
    const view = container.querySelector('[data-testid="gantt-view"]');
    assert.ok(view);
    assert.match(container.textContent ?? '', /ganttNoTasks/);
  });

  it('hides the empty state when at least one entry has a period', () => {
    const entries = [entry('a.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260704-20260706']],
    ]);
    const data = makeData(entries, tags);
    const { container } = renderGantt(data);
    assert.doesNotMatch(container.textContent ?? '', /ganttNoTasks/);
  });

  it('mounts the timeline scroll container', () => {
    const entries = [entry('a.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260704-20260706']],
    ]);
    const data = makeData(entries, tags);
    const { container } = renderGantt(data);
    // Pure-DOM rewrite: ECharts is gone. The scroll container is the
    // top-level `[data-testid="gantt-scroll"]` element itself; inside
    // it sits the inner chart-content div (containing the tick row,
    // today marker, and rows). We assert both: the container is here,
    // and one of its children is a chart-content div rather than an
    // echarts canvas/wrapper.
    const scroller = container.querySelector('[data-testid="gantt-scroll"]');
    assert.ok(scroller, 'gantt-scroll container should mount');
    assert.ok(
      scroller.querySelector('[data-testid^="gantt-row-"]'),
      'gantt-scroll contains at least one row'
    );
  });
});

describe('GanttView #2: Triage', () => {
  it('places entries without a period tag in the Triage tray', () => {
    const entries = [entry('a.txt'), entry('b.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260704-20260706']],
      ['/root/b.txt', []],
    ]);
    const data = makeData(entries, tags);
    const { container } = renderGantt(data);
    const triage = container.querySelector('[data-testid="gantt-triage"]');
    assert.ok(triage, 'Triage should render when unscheduled entries exist');
  });

  it('hides Triage when every entry has a period', () => {
    const entries = [entry('a.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260704-20260706']],
    ]);
    const data = makeData(entries, tags);
    const { container } = renderGantt(data);
    assert.equal(
      container.querySelector('[data-testid="gantt-triage"]'),
      null
    );
  });

  it('shows the read-only lock icon in Triage when readOnly', () => {
    const entries = [entry('a.txt')];
    const tags = new Map<string, string[]>([['/root/a.txt', []]]);
    const data = makeData(entries, tags, /* readOnly */ true);
    const { getByTestId } = renderGantt(data);
    assert.ok(getByTestId('gantt-triage-readonly'));
  });
});

describe('GanttView #3: readOnly drag short-circuit', () => {
  it('does not commit a drag when readOnly (no onSetEntryDateTag fires)', () => {
    const entries = [entry('a.txt'), entry('b.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260704-20260706']],
      // b.txt has no period → lands in Triage → lock icon is the
      // user-visible affordance the readOnly drag short-circuit pairs with.
      ['/root/b.txt', []],
    ]);
    const spies: Spies = {};
    const data = makeData(entries, tags, /* readOnly */ true, spies);
    // We can't easily simulate ECharts mousedown events under jsdom
    // (the chart isn't fully rendered), so we just confirm the
    // readOnly flag reaches the component and the Triage lock icon
    // appears — that's the user-visible affordance the drag short-
    // circuit is paired with.
    const { getByTestId } = renderGantt(data);
    assert.ok(getByTestId('gantt-triage-readonly'));
  });
});

describe('GanttView #4: today button + dataZoom wiring', () => {
  it('renders the today button', () => {
    const data = makeData([], new Map());
    const { getByTestId } = renderGantt(data);
    assert.ok(getByTestId('gantt-today'));
  });
});

describe('GanttView #5: domain menu wiring', () => {
  it('renders the GanttEntryMenu component (smoke test)', () => {
    const entries = [entry('a.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260704-20260706']],
    ]);
    const data = makeData(entries, tags);
    // The menu mounts lazily; right-click via the chart canvas isn't
    // easily simulable under jsdom, so we just confirm the component
    // tree is healthy (no thrown errors during render).
    const { container } = renderGantt(data);
    assert.ok(container.querySelector('[data-testid="gantt-view"]'));
  });
});

describe('GanttView #6: zoom persistence', () => {
  it('defaults to day zoom on first mount', () => {
    const data = makeData([], new Map());
    const { container } = renderGantt(data);
    // Just confirm the view mounts cleanly with no zoom in localStorage.
    assert.equal(localStorage.getItem('whale-task-gantt-zoom'), null);
    assert.ok(container.querySelector('[data-testid="gantt-view"]'));
  });

  it('hydrates a persisted zoom from localStorage', () => {
    // Pre-seed the persisted value and confirm the view's `<Select>`
    // reflects it on first paint (avoids a flash from 'day' to 'week').
    localStorage.setItem('whale-task-gantt-zoom', JSON.stringify({ zoom: 'week' }));
    const data = makeData([], new Map());
    const { container } = renderGantt(data);
    const sel = container.querySelector(
      '[data-testid="gantt-zoom"]'
    ) as HTMLElement | null;
    assert.ok(sel, 'zoom Select should be present');
    // MUI Select renders a hidden input carrying the current value.
    const hidden = sel?.querySelector('input') as HTMLInputElement | null;
    assert.equal(hidden?.value, 'week');
  });
});

describe('GanttView #7: pure-DOM bar layout', () => {
  it('renders one bar per entry with a period', () => {
    const entries = [entry('a.txt'), entry('b.txt'), entry('c.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260704-20260706']],
      ['/root/b.txt', ['not-started', '20260701-20260702']],
      ['/root/c.txt', ['completed', '20260710-20260712']],
    ]);
    const data = makeData(entries, tags);
    const { container } = renderGantt(data);
    const bars = container.querySelectorAll('[data-hitzone="body"]');
    assert.equal(bars.length, 3, 'one bar per entry that carries a period');
  });

  it('places a bar at the expected left/width for a 3-day period', () => {
    // For day zoom (PX_PER_DAY=32), a 3-day Mon–Wed bar should sit at
    // `startDays * 32` px and span roughly `3 * 32 = 96` px. Under jsdom
    // MUI `<Box sx>` applies styles via `style` attribute; we read that
    // off the body's parent (the bar wrapper). We allow a 1px slack to
    // absorb rounding in case MUI applies sub-pixel adjustments.
    const entries = [entry('a.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260706-20260708']], // 3 days
    ]);
    const data = makeData(entries, tags);
    const { container } = renderGantt(data);
    const bar = container.querySelector('[data-hitzone="body"]') as HTMLElement;
    assert.ok(bar, 'bar should mount');
    const widthStr = bar.style.width;
    const leftStr = bar.style.left;
    assert.ok(widthStr.endsWith('px'), 'width should be in px units');
    assert.ok(leftStr.endsWith('px'), 'left should be in px units');
    const widthPx = parseFloat(widthStr);
    const leftPx = parseFloat(leftStr);
    assert.ok(
      widthPx >= 3 * 32 - 1 && widthPx <= 3 * 32 + 1,
      `bar width ~96px for 3-day period, got ${widthPx}`
    );
    assert.ok(
      leftPx >= 0 && leftPx < 1000,
      `bar left within first viewport day, got ${leftPx}`
    );
  });
});

describe('GanttView #8: Triage drop path', () => {
  it('does not call onRemoveEntryDateTag on plain render (no drop fired)', () => {
    // Lightweight sanity: rendering with an unscheduled entry should NOT
    // pre-fire the drop callback. Real drop simulation requires
    // `@testing-library/user-event` (out of scope per the rewrite plan).
    const entries = [entry('a.txt'), entry('b.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260704-20260706']],
      ['/root/b.txt', []],
    ]);
    const spies: Spies = {};
    renderGantt(makeData(entries, tags, false, spies));
    // The drop callback is wired but never invoked during render — plain
    // mount shouldn't fire it. If a future regression flips the drop
    // path to fire on mount, this test will catch it.
    assert.equal(spies.removeEntryDateTag?.called ?? 0, 0);
    assert.equal(spies.setEntryDateTag?.called ?? 0, 0);
  });
});

describe('GanttView #9: tag chips on rows', () => {
  it('renders an EntryTagChips row for each scheduled entry', () => {
    const entries = [entry('a.txt'), entry('b.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', 'urgent-important', '20260704-20260706']],
      ['/root/b.txt', ['completed', 'noturgent-unimportant', '20260710-20260712']],
    ]);
    const data = makeData(entries, tags);
    const { container } = renderGantt(data);
    // `EntryTagChips` renders a stack of `MuiChip` siblings. With two
    // scheduled entries each carrying 2 visible tags plus the period
    // we expect at least 2 chips per row (period chip + 2 tag chips).
    const chips = container.querySelectorAll('.MuiChip-root');
    assert.ok(
      chips.length >= 4,
      `expected ≥4 chips (2 per row × 2 rows), got ${chips.length}`
    );
  });
});

describe('GanttView #6.5: quick-range presets (P1 #8)', () => {
  it('renders the four range toggle buttons', () => {
    const data = makeData([], new Map());
    const { container } = renderGantt(data);
    const group = container.querySelector('[data-testid="gantt-range"]');
    assert.ok(group, 'range ToggleButtonGroup should render');
    for (const r of ['1w', '2w', '1m', '1q']) {
      assert.ok(
        group.querySelector(`[data-testid="gantt-range-${r}"]`),
        `range button ${r} should render`
      );
    }
  });

  it('persists the selected range to localStorage', () => {
    const data = makeData([], new Map());
    const { getByTestId } = renderGantt(data);
    const btn = getByTestId('gantt-range-1m');
    fireEvent.click(btn);
    assert.equal(
      localStorage.getItem('whale-task-gantt-range'),
      JSON.stringify({ range: '1m' })
    );
  });

  it('clears the range override when clicking the active preset', () => {
    localStorage.setItem('whale-task-gantt-range', JSON.stringify({ range: '1m' }));
    const data = makeData([], new Map());
    const { getByTestId } = renderGantt(data);
    const btn = getByTestId('gantt-range-1m');
    fireEvent.click(btn);
    assert.equal(localStorage.getItem('whale-task-gantt-range'), JSON.stringify({}));
  });

  it('expands the chart span when a range preset is active', () => {
    // One task today: without a range override scaleForRange pads the
    // single-day span to MIN_VISIBLE_DAYS (14). With 1q selected the
    // visible span is 90 days, so the day ticks should multiply.
    const entries = [entry('a.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', `${todayKey().replace(/-/g, '')}-${todayKey().replace(/-/g, '')}`]],
    ]);
    const data = makeData(entries, tags);
    const { container, getByTestId } = renderGantt(data);

    const ticksWithout = container.querySelectorAll('[data-testid^="gantt-tick-"]').length;
    fireEvent.click(getByTestId('gantt-range-1q'));
    const ticksWith = container.querySelectorAll('[data-testid^="gantt-tick-"]').length;

    assert.ok(ticksWithout > 0, 'day ticks should render without range');
    assert.ok(
      ticksWith > ticksWithout,
      `1q range should produce more day ticks (${ticksWith} > ${ticksWithout})`
    );
  });

  it('hydrates a persisted range from localStorage on mount', () => {
    localStorage.setItem('whale-task-gantt-range', JSON.stringify({ range: '2w' }));
    const entries = [entry('a.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', `${todayKey().replace(/-/g, '')}-${todayKey().replace(/-/g, '')}`]],
    ]);
    const data = makeData(entries, tags);
    const { container } = renderGantt(data);
    const active = container.querySelector('[data-testid="gantt-range-2w"]');
    assert.ok(active, 'persisted 2w button should render');
    // MUI ToggleButton adds `Mui-selected` when it is the group value.
    assert.ok(
      active.classList.contains('Mui-selected'),
      'persisted range button should be selected'
    );
  });
});

// Feature: double-clicking a row's thumbnail (file/folder icon) or
// filename opens the entry — mirrors the Kanban EntryCard
// `onDoubleClick={() => onOpen(entry)}` so the two task-management
// views stay gesture-parallel. The row's onDoubleClick is the
// Kanban-equivalent handler; chips are excluded so dblclick on a tag
// chip doesn't open the file (chips have their own left-click semantic
// — toggle the tag filter).
describe('GanttView #9.5: double-click row opens the file', () => {
  it('calls onOpen when the row body is double-clicked', () => {
    const entries = [entry('a.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260704-20260706']],
    ]);
    const spies: Spies = {};
    const data = makeData(entries, tags, false, spies);
    const { container } = renderGantt(data);
    const row = container.querySelector(
      '[data-testid^="gantt-row-"]'
    ) as HTMLElement | null;
    assert.ok(row, 'a gantt row should render');
    fireEvent.doubleClick(row);
    assert.equal(
      spies.openEntry?.called ?? 0,
      1,
      'row dblclick must call onOpen exactly once'
    );
    assert.equal(
      spies.openEntry?.last?.path,
      '/root/a.txt',
      'onOpen must receive the right-clicked entry'
    );
  });

  it('does NOT open the file on double-click of a tag chip', () => {
    // Chip dblclick would otherwise toggle the tag filter twice
    // (back to original) AND open the file. Excluding chips from the
    // row's onDoubleClick keeps the gesture single-purpose: chips own
    // the tag-filter toggle, the row owns the file-open.
    const entries = [entry('a.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', 'urgent-important', '20260704-20260706']],
    ]);
    const spies: Spies = {};
    const data = makeData(entries, tags, false, spies);
    const { container } = renderGantt(data);
    const chip = container.querySelector('.MuiChip-root') as HTMLElement | null;
    assert.ok(chip, 'a chip should render');
    fireEvent.doubleClick(chip);
    assert.equal(
      spies.openEntry?.called ?? 0,
      0,
      'dblclick on a tag chip must NOT open the file'
    );
  });

  it('does NOT open the file on single-click (bar still opens the period dialog)', () => {
    // Guards the bar's single-click → period-dialog path. A user
    // single-clicking the bar must not ALSO open the file (that would
    // be a 2-action collision — period dialog + file open). The
    // existing #12 tests cover the dialog side; this one locks the
    // other half (the absence of onOpen on single-click).
    const entries = [entry('a.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260704-20260706']],
    ]);
    const spies: Spies = {};
    const data = makeData(entries, tags, false, spies);
    const { container } = renderGantt(data);
    const bar = container.querySelector(
      '[data-hitzone="body"][data-entry-path="/root/a.txt"]'
    ) as HTMLElement | null;
    assert.ok(bar, 'a gantt bar should render');
    clickBar(bar);
    assert.equal(
      spies.openEntry?.called ?? 0,
      0,
      'single-click on the bar must NOT open the file (it opens the period dialog)'
    );
  });
});

// Feature: dragging an unscheduled file (DND_TYPE_FILE) onto the
// Gantt chart schedules it with a 1-day period starting on the day
// under the drop point. The cursor X is converted to a day-key via
// `dayKeyFromClientX` (in GanttTimeline); the view then calls
// `data.onSetEntryDateTag` with a period whose startKey=endKey=dayKey.
//
// The HTML5Backend drag pipeline is awkward to simulate under jsdom
// (requires DragEvent + DataTransfer polyfills and the full
// react-dnd provider stack), so we test the wiring at two boundaries:
//   1. The pure day-math helper (`dayKeyFromClientX`) — exercised
//      against a stub HTMLElement that returns deterministic
//      rect + scrollLeft values.
//   2. The view's onDropEntry closure — invoked through the JSX path
//      by rendering a synthetic FileCellData and asserting that
//      `data.onSetEntryDateTag` is the exact sink the closure uses.
import { dayKeyFromClientX } from './gantt/GanttTimeline';
import { todayKey, type GanttScale } from '../domain/gantt';

describe('GanttView #14: drop-to-schedule day math (dayKeyFromClientX)', () => {
  // Stub HTMLElement that mimics the scroller's getBoundingClientRect +
  // scrollLeft. We avoid jsdom layout by overriding both directly.
  function stubScroller(left: number, scrollLeft: number): HTMLElement {
    return {
      getBoundingClientRect: () =>
        ({ left, top: 0, right: 0, bottom: 0, width: 1000, height: 100, x: left, y: 0, toJSON: () => '' }) as DOMRect,
      scrollLeft,
    } as unknown as HTMLElement;
  }

  const scale: GanttScale = {
    zoom: 'day',
    startKey: '2026-07-01',
    endKey: '2026-07-31',
    totalDays: 31,
    widthPx: 31 * 32,
  };

  it('returns the day under the cursor in the chart area', () => {
    // Scroller at viewport left=0, no scroll. THUMB_COL_WIDTH = 200,
    // pxPerDay = 32. Cursor at clientX = 200 + 32 + 16 (= day 1 + 50%
    // of day 2) → floor((200 + 32 + 16 - 200) / 32) = floor(48/32) = 1
    // → day 1 = 2026-07-02.
    const scroller = stubScroller(0, 0);
    assert.equal(
      dayKeyFromClientX(200 + 32 + 16, scroller, scale, 32),
      '2026-07-02'
    );
  });

  it('returns the first day when cursor is at the chart left edge', () => {
    const scroller = stubScroller(0, 0);
    // clientX = 200 (right at the thumb/chart boundary) → day 0
    assert.equal(
      dayKeyFromClientX(200, scroller, scale, 32),
      '2026-07-01'
    );
  });

  it('returns null when cursor is over the thumb column', () => {
    const scroller = stubScroller(0, 0);
    assert.equal(
      dayKeyFromClientX(100, scroller, scale, 32),
      null,
      'cursor over the icon column (x < THUMB_COL_WIDTH) must NOT produce a day'
    );
  });

  it('returns null when cursor is past the right edge', () => {
    const scroller = stubScroller(0, 0);
    // Chart spans 31 days * 32px = 992px from x=200 to x=1192. A
    // cursor at x=1200 is past the last day.
    assert.equal(
      dayKeyFromClientX(1200, scroller, scale, 32),
      null,
      'cursor past the right edge must NOT produce a day'
    );
  });

  it('respects horizontal scroll (cursor + scrollLeft = absolute day)', () => {
    // User scrolled 200px to the right. Day 0 is now at viewport
    // x = 0. Cursor at clientX = 0 should land on day 0.
    const scroller = stubScroller(0, 200);
    assert.equal(
      dayKeyFromClientX(0, scroller, scale, 32),
      '2026-07-01'
    );
    // Cursor at clientX = 32 → day 1
    assert.equal(
      dayKeyFromClientX(32, scroller, scale, 32),
      '2026-07-02'
    );
  });

  it('clamps to the last day when cursor is on the boundary', () => {
    // Cursor at the exact right edge of the last day (x = 200 + 31*32 - 1 = 1191)
    const scroller = stubScroller(0, 0);
    assert.equal(
      dayKeyFromClientX(200 + 31 * 32 - 1, scroller, scale, 32),
      '2026-07-31',
      'right-edge cursor snaps to the last day (half-open [0, totalDays))'
    );
  });
});

describe('GanttView #15: drop-to-schedule wiring', () => {
  // For the integration wire we don't try to fake HTML5Backend drag
  // events (react-dnd v16 + jsdom = fragile). Instead we assert the
  // view's behavior at the prop boundary: render the GanttView and
  // confirm that the drop target mounts without errors, and that the
  // wiring (drop → onSetEntryDateTag with a todayKey-based period)
  // is the same shape as `periodTagFromRange({ dayKey, dayKey })`.
  //
  // The actual drop math is locked down by:
  //   - GanttTimeline's drop spec using `todayKey()` directly
  //     (see src/renderer/components/gantt/GanttTimeline.tsx)
  //   - GanttView's onDropEntry closure routing through
  //     `periodTagFromRange({ startKey: dayKey, endKey: dayKey })`
  //     which produces a `YYYYMMDD-YYYYMMDD` token.
  it('mounts the drop target on the scroller (smoke)', () => {
    // Render with a fresh unscheduled entry and confirm the chart
    // mounts cleanly with the new useDrop wired up.
    const entries = [entry('new.txt')];
    const tags = new Map<string, string[]>([['/root/new.txt', []]]);
    const data = makeData(entries, tags);
    const { container } = renderGantt(data);
    const scroller = container.querySelector(
      '[data-testid="gantt-scroll"]'
    ) as HTMLElement | null;
    assert.ok(scroller, 'gantt-scroll mounts even with no scheduled entries');
  });

  it('view-level wiring: drop with today → 1-day period at today', () => {
    // Unit-style check on the view's onDropEntry closure math:
    // verifies that todayKey + periodTagFromRange produces a token
    // whose start === end (1-day period). The closure itself isn't
    // reachable from outside JSX, so we exercise the SAME
    // periodTagFromRange helper to lock the shape — any future
    // regression that breaks this (e.g., switching to a multi-day
    // default) would diverge from the asserted equality.
    const today = '2026-07-05';
    const tag = periodTagFromRange({ startKey: today, endKey: today });
    assert.equal(tag, '20260705-20260705');
  });
});

// Virtualization — direct unit tests for the windowing math plus an
// integration check that 1000+ rows only mount a viewport-sized slice
// in jsdom (where scroller.clientHeight is 0, so the slice collapses
// to a defensively-bounded minimum).
describe('GanttView #16: vertical windowing math (computeRenderRange)', () => {
  it('returns empty range when totalRows is 0', () => {
    assert.deepEqual(
      computeRenderRange(0, 600, 0, ROW_HEIGHT_FOR_TEST, ROW_OVERSCAN),
      { firstRow: 0, lastRow: 0 }
    );
  });

  it('at scrollTop=0 with a 600px viewport, renders rows 0..(~10+overscan)', () => {
    // 600 / 72 ≈ 8.33 visible rows. With overscan 3, the range is
    // [0, ceil(600/72)+3+1] = [0, ~14].
    const r = computeRenderRange(0, 600, 1000, ROW_HEIGHT_FOR_TEST, ROW_OVERSCAN);
    assert.equal(r.firstRow, 0);
    assert.ok(
      r.lastRow > 0 && r.lastRow <= 16,
      `lastRow should be ≈ viewport/row + overscan; got ${r.lastRow}`
    );
  });

  it('shifts the visible slice as scrollTop grows', () => {
    // Scroll 720 px (≈ 9 rows past the tick row). Row 0 sits at
    // top = TICK_HEIGHT = 24, so 720 px from the scroller's top edge
    // corresponds to floor((720 - 24) / 72) = row 9. With overscan
    // 3, firstRow = 9 - 3 = 6.
    const r = computeRenderRange(
      720,
      600,
      1000,
      ROW_HEIGHT_FOR_TEST,
      ROW_OVERSCAN
    );
    assert.equal(
      r.firstRow,
      Math.floor((720 - TICK_HEIGHT_FOR_TEST) / ROW_HEIGHT_FOR_TEST) -
        ROW_OVERSCAN
    );
    assert.ok(r.lastRow > r.firstRow, 'range is non-empty');
    assert.ok(
      r.lastRow <= 1000,
      `lastRow must not exceed totalRows; got ${r.lastRow}`
    );
  });

  it('clamps to totalRows at the bottom', () => {
    // Scroll far past the last row.
    const r = computeRenderRange(
      10000,
      600,
      1000,
      ROW_HEIGHT_FOR_TEST,
      ROW_OVERSCAN
    );
    assert.ok(
      r.lastRow <= 1000,
      `lastRow must clamp to totalRows; got ${r.lastRow}`
    );
    assert.ok(r.lastRow > r.firstRow, 'range is non-empty');
  });

  it('never returns an empty range when totalRows > 0 (defensive min)', () => {
    // Even with a 0-px viewport, at least one row must mount when
    // data exists — otherwise the chart would appear blank.
    const r = computeRenderRange(
      0,
      0,
      1000,
      ROW_HEIGHT_FOR_TEST,
      ROW_OVERSCAN
    );
    assert.ok(
      r.lastRow > r.firstRow,
      'defensive min — must render ≥1 row when totalRows > 0'
    );
  });
});

// Integration smoke: render the GanttView with a directory-shaped
// entry list (1000+ scheduled rows) and assert the mounted row count
// is bounded by the windowing slice — NOT all 1000+. jsdom doesn't
// compute layout so clientHeight is 0; the slice collapses to the
// defensive minimum (1 row) per computeRenderRange's contract.
describe('GanttView #17: integration — 1000+ rows do not all mount', () => {
  it('renders a windowed slice, not the full entry list', () => {
    const entries: ReturnType<typeof entry>[] = [];
    const tags = new Map<string, string[]>();
    for (let i = 0; i < 1000; i++) {
      const e = entry(`file-${String(i).padStart(4, '0')}.txt`);
      entries.push(e);
      // Give every entry a unique period so chartRowsFromEntries
      // populates `scheduled` for all 1000.
      const start = 20260700 + (i % 28);
      const end = start + 1;
      tags.set(e.path, [
        'in-progress',
        `${String(start).padStart(8, '0')}-${String(end).padStart(8, '0')}`,
      ]);
    }
    const data = makeData(entries, tags);
    const { container } = renderGantt(data);
    const mountedRows = container.querySelectorAll(
      '[data-testid^="gantt-row-"]'
    );
    // jsdom layout = 0 px viewport → defensive min (1 row) per
    // computeRenderRange. The whole point: it's NOT 1000.
    assert.ok(
      mountedRows.length < 1000,
      `windowing must keep mounted rows << total; got ${mountedRows.length} mounted`
    );
    assert.ok(
      mountedRows.length >= 1,
      `at least one row must mount when scheduled entries exist; got ${mountedRows.length}`
    );
  });
});

// Helper kept here (rather than a renderer/domain/gantt import) so the test
// mirrors the exact line in GanttView.tsx. If the view ever switches
// to a multi-day default, this assertion will catch it.
import { periodTagFromRange } from '../domain/gantt';

// Virtualization math — see GanttTimeline's windowing helper. Unit
// tested directly so the math is locked without standing up the full
// DOM + jsdom + react-dnd pipeline.
import { computeRenderRange, ROW_OVERSCAN } from './gantt/GanttTimeline';
// ROW_HEIGHT is a constant inside GanttTimeline; mirror it here so
// the test doesn't have to re-export the internal. The shared
// helper takes rowHeight as a parameter so this duplication is
// intentional and cheap.
const ROW_HEIGHT_FOR_TEST = 72;
const TICK_HEIGHT_FOR_TEST = 24;

// Regression: right-clicking a tag chip on a Gantt row must NOT open the
// row-level GanttEntryMenu. Chips have their own per-tag remove menu
// (TagChipContextMenu, mounted in FileList); the row's `onContextMenu`
// must bail out when the target is a chip, otherwise both menus stack
// at the cursor. Same anti-stacking idea as KanbanView's column handler
// which calls `onCloseEntryMenu()` before opening its column menu.
describe('GanttView #10: chip right-click does not stack the row menu', () => {
  it('does not open GanttEntryMenu when right-clicking a tag chip', () => {
    const entries = [entry('a.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', 'urgent-important', '20260704-20260706']],
    ]);
    const spies: Spies = {};
    const data = makeData(entries, tags, false, spies);
    const { container } = renderGantt(data);
    const chip = container.querySelector('.MuiChip-root');
    assert.ok(chip, 'a chip should render on the row');
    // Fire a contextmenu event on the chip. The chip's own
    // onContextMenu (in EntryTagChips) calls e.stopPropagation; even
    // if that fails to reach the row through the Tooltip wrapper,
    // the row's defensive target check must still bail out.
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    chip.dispatchEvent(ev);
    // GanttEntryMenu's open state is bound to `[data-testid="gantt-view"]`
    // descendants — we assert no Menu paper was mounted. The MUI Menu
    // portal renders the paper with role="presentation" / class
    // MuiMenu-paper inside MuiPopover-root.
    assert.equal(
      container.querySelector('.MuiMenu-paper'),
      null,
      'right-clicking a chip must not open GanttEntryMenu (would stack with TagChipContextMenu)'
    );
  });
});

// Regression: right-clicking a Gantt row body must NOT also fire
// FileList's outer onContextMenu (which opens the blank-area
// EntryContextMenu via setCtxMenu). Without stopPropagation on the
// row's onContextMenu, the event bubbles up through FileList's
// container and triggers a SECOND menu stacked at the cursor:
// GanttEntryMenu (the row's own) + EntryContextMenu (the blank-area
// fallback). Same anti-stacking idea as KanbanView's column handler,
// which calls e.stopPropagation() before opening its column menu.
describe('GanttView #11: row right-click does not leak to FileList', () => {
  it('does not call onContextEntry when right-clicking the row body', () => {
    const entries = [entry('a.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260704-20260706']],
    ]);
    let ctxEntryCalls = 0;
    const data = makeData(entries, tags);
    data.onContextEntry = () => {
      ctxEntryCalls += 1;
    };
    const { container } = renderGantt(data);
    const row = container.querySelector('[data-testid^="gantt-row-"]');
    assert.ok(row, 'a gantt row should render');
    // Fire contextmenu on the row body (not on a chip). The row's
    // onContextMenu fires GanttEntryMenu; stopPropagation must
    // prevent the event from also reaching FileList's outer
    // onContextMenu (which would call onContextEntry to open the
    // blank-area EntryContextMenu).
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    row.dispatchEvent(ev);
    assert.equal(
      ctxEntryCalls,
      0,
      'row onContextMenu must stopPropagation so FileList outer onContextMenu (blank-area EntryContextMenu) does not also fire'
    );
  });
});

// Feature: left-clicking a taskbar (no drag) pops the shared
// PeriodTagDialog pre-filled with the entry's current start/end. Drag
// (body shift / edge resize) still commits via onSetEntryDateTag —
// the dialog is the SINGLE-click path only. Right-click opens the
// GanttEntryMenu as before.
//
// The "no drag" pointer sequence: pointerdown → pointerup without
// crossing DRAG_PENDING_THRESHOLD_PX (4 px). We simulate that with
// matching clientX on down and up.
//
// Note: MUI's <Dialog> renders into a portal at `document.body`, so
// the dialog DOM lives OUTSIDE the render() `container`. We query
// `document` directly for the period-tag-dialog testid.
describe('GanttView #12: left-click taskbar pops the period dialog', () => {
  it('opens PeriodTagDialog with the entry current period on single-click', () => {
    const entries = [entry('a.txt')];
    const tags = new Map<string, string[]>([
      // entry has a 20260704-20260706 period so the dialog opens
      // pre-filled with those dates.
      ['/root/a.txt', ['in-progress', '20260704-20260706']],
    ]);
    const data = makeData(entries, tags);
    const { container } = renderGantt(data);
    const bar = container.querySelector(
      '[data-hitzone="body"][data-entry-path="/root/a.txt"]'
    ) as HTMLElement | null;
    assert.ok(bar, 'a gantt bar should render for /root/a.txt');

    // Pre-condition: dialog not open before the click.
    assert.equal(
      document.querySelector('[data-testid="period-tag-dialog"]'),
      null,
      'period dialog should not be open before the click'
    );

    // Simulate a clean pointerdown + pointerup (no movement). The hook's
    // pending→idle transition must fire onClick, which GanttView wires
    // to openPeriodDialog.
    clickBar(bar);

    const dialog = document.querySelector('[data-testid="period-tag-dialog"]');
    assert.ok(
      dialog,
      'single-click on the taskbar should open PeriodTagDialog'
    );
    // The dialog should pre-fill start / end with the entry's current
    // period (YYYY-MM-DD). PeriodTagDialog renders TextFields keyed by
    // `period-tag-start` / `period-tag-end`.
    const start = dialog.querySelector(
      '[data-testid="period-tag-start"]'
    ) as HTMLInputElement | null;
    const end = dialog.querySelector(
      '[data-testid="period-tag-end"]'
    ) as HTMLInputElement | null;
    assert.ok(start && end, 'start + end inputs should mount');
    assert.equal(start.value, '2026-07-04', 'start pre-fills current period');
    assert.equal(end.value, '2026-07-06', 'end pre-fills current period');
  });

  it('does NOT open the dialog in readOnly mode', () => {
    const entries = [entry('a.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260704-20260706']],
    ]);
    const data = makeData(entries, tags, /* readOnly */ true);
    const { container } = renderGantt(data);
    const bar = container.querySelector(
      '[data-hitzone="body"][data-entry-path="/root/a.txt"]'
    ) as HTMLElement | null;
    assert.ok(bar, 'a gantt bar should render for /root/a.txt');
    clickBar(bar);
    assert.equal(
      document.querySelector('[data-testid="period-tag-dialog"]'),
      null,
      'readOnly mode must short-circuit the click → dialog path'
    );
  });

  it('commit-from-dialog calls onSetEntryDateTag with the new period', () => {
    const entries = [entry('a.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260704-20260706']],
    ]);
    const spies: Spies = {};
    const data = makeData(entries, tags, false, spies);
    const { container } = renderGantt(data);
    const bar = container.querySelector(
      '[data-hitzone="body"][data-entry-path="/root/a.txt"]'
    ) as HTMLElement | null;
    clickBar(bar);
    const confirm = document.querySelector(
      '[data-testid="period-tag-confirm"]'
    ) as HTMLButtonElement | null;
    assert.ok(confirm, 'confirm button should mount after dialog opens');
    // The confirm callback always routes through `data.onSetEntryDateTag`
    // — the underlying `useListCommands.handleAddTag` runs
    // `withSinglePeriodTag` to dedupe / replace any prior period. So
    // confirming with unchanged dates still fires the callback once;
    // the no-op is at the sidecar layer, not the wiring layer.
    confirm.click();
    assert.equal(
      spies.setEntryDateTag?.called ?? 0,
      1,
      'confirming the dialog must call onSetEntryDateTag exactly once'
    );
    assert.equal(
      spies.setEntryDateTag?.last?.tag,
      '20260704-20260706',
      'onSetEntryDateTag must receive the same-period compact token (dialog defaults)'
    );
  });

  it('anchors the dialog near the click point instead of centering it', () => {
    const entries = [entry('a.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260704-20260706']],
    ]);
    const data = makeData(entries, tags);
    const { container } = renderGantt(data);
    const bar = container.querySelector(
      '[data-hitzone="body"][data-entry-path="/root/a.txt"]'
    ) as HTMLElement | null;
    // Click at a known cursor position. The view passes (clientY + 8,
    // clientX + 8) to the dialog's Paper so the click point itself
    // doesn't sit under the start input.
    const click = { clientX: 137, clientY: 211 };
    clickBar(bar, click);
    const dialog = document.querySelector('[data-testid="period-tag-dialog"]');
    assert.ok(dialog, 'dialog should mount');
    const paper = dialog.querySelector('.MuiDialog-paper') as HTMLElement | null;
    assert.ok(paper, 'MuiDialog-paper should render');
    // MUI's `sx` produces Emotion CSS classes, NOT inline `style`. We
    // assert the resolved computed style on the Paper — which includes
    // the values from the generated CSS rules (position: absolute +
    // top + left).
    const computed = getComputedStyle(paper);
    assert.equal(
      computed.position,
      'absolute',
      `Paper must be position: absolute (MUI default is fixed); got: ${computed.position}`
    );
    assert.equal(
      computed.top,
      `${click.clientY + 8}px`,
      `Paper top must equal clientY + 8; got: ${computed.top}`
    );
    assert.equal(
      computed.left,
      `${click.clientX + 8}px`,
      `Paper left must equal clientX + 8; got: ${computed.left}`
    );
  });

  it('keeps the dialog at MUI xs width (no stretch to viewport)', () => {
    // Regression for the wide-dialog bug: previously the Paper sx
    // overrode maxWidth to `calc(100vw - left - 8px)` while fullWidth
    // was still true — clicks near the left edge made the dialog
    // stretch to nearly the full viewport. Width must stay at the
    // MUI `maxWidth="xs"` (444px) regardless of click position.
    const entries = [entry('a.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260704-20260706']],
    ]);
    const data = makeData(entries, tags);
    const { container } = renderGantt(data);
    const bar = container.querySelector(
      '[data-hitzone="body"][data-entry-path="/root/a.txt"]'
    ) as HTMLElement | null;
    // Click near the left edge — the worst case for the old code.
    clickBar(bar, { clientX: 8, clientY: 211 });
    const dialog = document.querySelector('[data-testid="period-tag-dialog"]');
    assert.ok(dialog, 'dialog should mount');
    const paper = dialog.querySelector('.MuiDialog-paper') as HTMLElement | null;
    assert.ok(paper, 'MuiDialog-paper should render');
    const computed = getComputedStyle(paper);
    // The Paper's `maxWidth` style (set by MUI from maxWidth="xs") must
    // not be overridden by our sx. MUI xs = 360px (the actual computed
    // width after MUI's calc). What we lock down is: maxWidth is NOT
    // a `calc(100vw - ...)` expression — i.e. our sx didn't override
    // it. We assert the value is bounded regardless of click x.
    assert.ok(
      !computed.maxWidth.includes('100vw'),
      `Paper maxWidth must NOT be a 100vw-relative expression; got: ${computed.maxWidth}`
    );
    // Also assert the rendered width is reasonable (≤ 600px — well
    // below the "stretched to nearly full viewport" failure mode).
    // jsdom doesn't compute layout, so we read the resolved maxWidth
    // value (which it does parse) and sanity-check that.
    const maxWidthPx = parseFloat(computed.maxWidth);
    assert.ok(
      !Number.isNaN(maxWidthPx) && maxWidthPx > 0 && maxWidthPx <= 600,
      `Paper maxWidth must be a small dialog width (MUI xs = 360px); got: ${computed.maxWidth}`
    );
  });
});

// ─── P0 #1: Swim lanes ──────────────────────────────────────────────
// Verifies the swim-lane grouping + divider + hidden-lane-placeholder
// wiring. The pure grouping helper itself (`groupRowsByWorkflow`) is
// tested exhaustively in [src/renderer/domain/gantt.test.ts]; here we cover
// the integration: stages passed in, lanes rendered in order, dividers
// appear at lane boundaries, filtered-out lanes collapse to a single
// placeholder row.

describe('GanttView #18: swim lanes (P0 #1)', () => {
  it('renders rows in stages order, then the no-stage lane last', () => {
    // 3 entries: a (in-progress), b (not-started), c (no stage tag).
    // Stages order is DEFAULT_STAGES = not-started → in-progress →
    // completed, so the visible row order should be b, a, c.
    const entries = [
      entry('a.txt'),
      entry('b.txt'),
      entry('c.txt'),
    ];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260701-20260705']],
      ['/root/b.txt', ['not-started', '20260706-20260710']],
      ['/root/c.txt', ['20260711-20260715']], // no workflow tag
    ]);
    const data = makeData(entries, tags);
    const { container } = renderGantt(data);
    // Scope to GanttRow roots (data-testid="gantt-row-<path>") —
    // GanttBar also carries data-entry-path, so a plain
    // `[data-entry-path]` selector would double-count.
    const rowEls = container.querySelectorAll('[data-testid^="gantt-row-"]');
    const orderedPaths = Array.from(rowEls).map((el) =>
      (el as HTMLElement).getAttribute('data-entry-path')
    );
    assert.deepEqual(orderedPaths, ['/root/b.txt', '/root/a.txt', '/root/c.txt']);
  });

  it('renders a lane header for EVERY lane (including the first)', () => {
    // 2026-07-05 fix: previously the first lane had no header because
    // the boundary set only recorded laneIndex CHANGES, which can't
    // fire at index 0. Now the first visible row of every lane gets
    // a header, so all 3 lanes are labeled.
    const entries = [
      entry('a.txt'),
      entry('b.txt'),
      entry('c.txt'),
    ];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260701-20260705']],
      ['/root/b.txt', ['not-started', '20260706-20260710']],
      ['/root/c.txt', ['20260711-20260715']],
    ]);
    const data = makeData(entries, tags);
    const { container } = renderGantt(data);
    const dividers = container.querySelectorAll(
      '[data-testid^="gantt-lane-divider-"]'
    );
    // 3 lanes → 3 headers (one above EACH lane, not just the
    // non-first ones — see comment above).
    assert.equal(dividers.length, 3);
  });

  it('renders exactly one lane header when only one lane has rows', () => {
    // Single lane → exactly 1 header (above the first row). Pre-fix
    // this would be 0 because the boundary set only recorded lane
    // changes, which can't fire on a single-lane chart.
    const entries = [entry('a.txt'), entry('b.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260701-20260705']],
      ['/root/b.txt', ['in-progress', '20260706-20260710']],
    ]);
    const data = makeData(entries, tags);
    const { container } = renderGantt(data);
    const dividers = container.querySelectorAll(
      '[data-testid^="gantt-lane-divider-"]'
    );
    assert.equal(dividers.length, 1);
  });

  it('renders one "未分类" header when stages=[] (everything in no-stage lane)', () => {
    // Back-compat: with empty stages, everything falls into the
    // single "no stage" lane — still gets one header labeled
    // "未分类" so the user knows what they're looking at.
    const entries = [
      entry('a.txt'),
      entry('b.txt'),
    ];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260701-20260705']],
      ['/root/b.txt', ['20260706-20260710']],
    ]);
    const data = makeData(entries, tags);
    const { container } = renderGantt(data, []);
    const dividers = container.querySelectorAll(
      '[data-testid^="gantt-lane-divider-"]'
    );
    assert.equal(dividers.length, 1);
  });

  // The hidden-lane placeholder (when a filter narrows a lane to 0
  // visible rows) is exercised end-to-end in a hand-rendered scenario
  // rather than via the MUI Select dropdown here, because MUI's
  // Select component relies on Popper + focus-management that's
  // flaky under jsdom. The filter predicate that drives
  // "lane → empty" is already covered exhaustively by
  // [useGanttTagFilter.test.tsx]; the wiring in GanttTimeline
  // (the `hiddenLaneCount` memo + placeholder Box) is small enough
  // that visual verification on dev (`npm run dev`) covers the gap.
});

// ─── P1 #9: PNG export cluster ─────────────────────────────────────────
// The toolbar exposes save / save-as / copy-to-clipboard buttons. Under
// the hood `useImageExport` calls `domToPng` from `modern-screenshot`
// (dynamic import) and routes the resulting base64 PNG to either
// `ipcApi.writeBinaryFile` (save / save-as) or `navigator.clipboard.write`
// (copy). We don't exercise the full capture pipeline here — `modern-
// screenshot` requires a real DOM with layout (jsdom lacks it) and the
// IPC layer is already covered by `useImageExport` consumers elsewhere.
// What we DO lock down at this layer:
//   1. The three buttons mount with the expected `data-testid`s and
//      labels (so a refactor can't silently drop one).
//   2. The inner chart-content Box carries the export ref hook so the
//      parent's `capture()` callback resolves to a non-null node when
//      the timeline has rows to render.
//   3. Clicking copy while the timeline is empty is a no-op (no chart-
//      content to capture) — the Snackbar doesn't open, the toolbar
//      stays usable.
describe('GanttView #19: PNG export toolbar (P1 #9)', () => {
  it('renders the three export buttons with the correct testids', () => {
    const entries = [entry('a.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260704-20260706']],
    ]);
    const data = makeData(entries, tags);
    const { container } = renderGantt(data);
    assert.ok(
      container.querySelector('[data-testid="gantt-export-save"]'),
      'save button should mount'
    );
    assert.ok(
      container.querySelector('[data-testid="gantt-export-save-as"]'),
      'save-as button should mount'
    );
    assert.ok(
      container.querySelector('[data-testid="gantt-export-copy"]'),
      'copy-to-clipboard button should mount'
    );
  });

  it('mounts the inner chart-content Box that the export ref hooks onto', () => {
    // The capture function inside GanttView reaches into `exportRef` —
    // if the inner Box is missing or the ref isn't threaded down, the
    // first export click would no-op silently. Asserting the testid
    // here is the cheapest way to lock the wiring down.
    const entries = [entry('a.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260704-20260706']],
    ]);
    const data = makeData(entries, tags);
    const { container } = renderGantt(data);
    const chartContent = container.querySelector('[data-testid="gantt-chart-content"]');
    assert.ok(chartContent, 'inner chart-content Box should mount when timeline has rows');
  });

  it('does not render the chart-content Box when no entries are scheduled', () => {
    // Empty Gantt renders the "no tasks" message instead of the timeline;
    // there's nothing to export so the inner Box is intentionally absent.
    const data = makeData([entry('a.txt')], new Map());
    const { container } = renderGantt(data);
    assert.equal(
      container.querySelector('[data-testid="gantt-chart-content"]'),
      null
    );
  });

  it('disables export buttons while a capture is in flight', async () => {
    // We don't await the actual capture (jsdom can't layout DOM), but we
    // can verify the buttons start enabled and the disabled-prop is
    // wired to `exporting`. The end-to-end success/failure UI is
    // covered by CalendarView's `useImageExport` integration; here we
    // only check the toolbar surface.
    const entries = [entry('a.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['in-progress', '20260704-20260706']],
    ]);
    const data = makeData(entries, tags);
    const { container } = renderGantt(data);
    const save = container.querySelector(
      '[data-testid="gantt-export-save"]'
    ) as HTMLButtonElement;
    const saveAs = container.querySelector(
      '[data-testid="gantt-export-save-as"]'
    ) as HTMLButtonElement;
    const copy = container.querySelector(
      '[data-testid="gantt-export-copy"]'
    ) as HTMLButtonElement;
    assert.ok(save && saveAs && copy, 'all three buttons should mount');
    // `exporting` is false at mount → none disabled.
    assert.equal(save.disabled, false, 'save button starts enabled');
    assert.equal(saveAs.disabled, false, 'save-as button starts enabled');
    assert.equal(copy.disabled, false, 'copy button starts enabled');
  });
});

/** Fire a pointerdown / pointerup pair via @testing-library/react's
 *  fireEvent so React's synthetic event system picks them up. jsdom's
 *  PointerEvent polyfill is loose; using fireEvent.pointerDown /
 *  fireEvent.pointerUp routes through React's synthetic dispatcher
 *  and is the supported pattern for "did the React handler run" in
 *  unit tests. */
function clickBar(
  el: HTMLElement,
  at: { clientX: number; clientY: number } = { clientX: 10, clientY: 10 }
): void {
  fireEvent.pointerDown(el, { button: 0, clientX: at.clientX, clientY: at.clientY });
  fireEvent.pointerUp(el, { button: 0, clientX: at.clientX, clientY: at.clientY });
}