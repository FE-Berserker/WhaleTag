/**
 * Component-level tests for MatrixView. Mirrors KanbanView.test.tsx's style
 * (node:test + global-jsdom + @testing-library/react + the same provider
 * stack). Locks down:
 *   - 4-quadrant grid rendering + the UntaggedTray conditional
 *   - bucketEntries routing (per tag → correct quadrant)
 *   - quadrant background right-click → New Folder / New File menu
 *   - readOnly gating on both the menu items and the UntaggedTray lock icon
 *   - count chip matches the bucket size
 *
 * Drop simulation is intentionally NOT covered here: react-dnd's HTML5
 * backend doesn't fire real drag events in jsdom, and forcing it requires a
 * 100+ line harness. The drop *handler* logic (resolveEntry path, sources
 * resolution, onMoveToColumn payload) is already covered at the algorithm
 * level in `src/shared/kanban.test.ts`.
 */

import globalJsdom from 'global-jsdom';

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { Provider } from 'react-redux';
import { createStore } from 'redux';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import i18next from 'i18next';

import MatrixView from './MatrixView';
import type { FileCellData } from './file-cell';
import { CurrentLocationContext } from '../hooks/CurrentLocationContextProvider';
import { DirectoryContentContext, DirectoryUIContext } from '../hooks/DirectoryContentContextProvider';
import { DirectoryTreeRefreshContextProvider } from '../hooks/DirectoryTreeRefreshContextProvider';
import { IOActionsContextProvider } from '../hooks/IOActionsContextProvider';
import { PeriodTagDialogProvider } from './PeriodTagDialog';
import { QUADRANT_VALUES } from '../../shared/smart-tags';
import { UNTAGGED_COLUMN } from '../../shared/kanban';
import type { DirEntry } from '../../shared/ipc-types';

/** i18n stub: returns `key` (or `key|opts=…` when interpolation is present)
 *  so test assertions can grep the rendered text for known keys. */
function makeT(): FileCellData['t'] {
  return ((key: string, opts?: Record<string, unknown>): string => {
    if (!opts) return key;
    const parts = Object.keys(opts)
      .sort()
      .map((k) => `${k}=${String(opts[k])}`);
    return `${key}|${parts.join('&')}`;
  }) as FileCellData['t'];
}

/** Minimal DirEntry factory (matches KanbanView.test.tsx). */
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
  moveToColumn?: { called: number; last: { sources: DirEntry[]; target: string | null; groupTags: string[] } | null };
  createTagged?: { called: number; last: { kind: 'file' | 'folder'; tag: string } | null };
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
    tagColors: {},
    groups: [
      {
        id: 'g-quadrant',
        title: 'Quadrant',
        expanded: true,
        color: '#3b82f6',
        tags: [...QUADRANT_VALUES],
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
    onOpen: () => {},
    onClickTag: () => {},
    onTagContextMenu: () => {},
    onDropTag: () => {},
    onDropFiles: () => {},
    onContextEntry: () => {},
    onCreateTagged: (kind, tag) => {
      spies.createTagged = spies.createTagged ?? { called: 0, last: null };
      spies.createTagged.called += 1;
      spies.createTagged.last = { kind, tag };
    },
    onCopy: () => {},
    onMove: () => {},
    onRename: () => {},
    onDelete: () => {},
    onSetEntryDateTag: () => {},
    onRemoveEntryDateTag: () => {},
    onMoveToColumn: (sources, target, groupTags) => {
      spies.moveToColumn = spies.moveToColumn ?? { called: 0, last: null };
      spies.moveToColumn.called += 1;
      spies.moveToColumn.last = { sources, target, groupTags };
    },
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

const STUB_STORE = createStore(
  () => ({ settings: { officeThumbnailEnabled: false, sofficePath: null } })
);

function renderMatrix(data: FileCellData) {
  // Quadrant now uses useIOActionsContext() (native OS-file drop support).
  // Render with the production provider; the default stub
  // `importExternalFiles` resolves with zero copies.
  return render(
    <I18nextProvider i18n={i18next} defaultNS="common">
      <Provider store={STUB_STORE}>
        <DndProvider backend={HTML5Backend}>
          {/* EntryCard now uses usePeriodTagDialog() for `period:` drops,
              so the rendering tree needs the provider; in production this
              lives one level up in MainLayout. */}
          <PeriodTagDialogProvider>
            <CurrentLocationContext.Provider value={LOCATION_CTX_STUB}>
              <DirectoryContentContext.Provider value={DIR_CONTENT_STUB}>
            <DirectoryUIContext.Provider value={DIR_CONTENT_STUB}>
                <DirectoryTreeRefreshContextProvider>
                  <IOActionsContextProvider>
                    <MatrixView
                      data={data}
                      onMoveToColumn={
                        data.onMoveToColumn ?? ((sources, target, groupTags) => {
                          // ensure call site has the prop even if data didn't wire it
                          void sources;
                          void target;
                          void groupTags;
                        })
                      }
                      // H.28 P0-1: required after the per-card domain menu
                      // was added. The test doesn't drive the menu, so an
                      // empty stage list is fine — the menu's "Move to stage"
                      // submenu just renders an empty list + the "(no stage)"
                      // clear item.
                      stages={[]}
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
      disconnect() {};
    };
  }
  if (typeof window !== 'undefined' && !window.matchMedia) {
    (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (
      query: string
    ) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }
});

// ---------------------------------------------------------------------
// #1: 4 quadrants + conditional untagged tray
// ---------------------------------------------------------------------
describe('MatrixView #1: structure', () => {
  it('renders exactly 4 quadrants and an UntaggedTray when there are untagged files', () => {
    cleanup();
    const entries = [
      entry('a.txt'),
      entry('b.txt'),
      entry('c.txt'),
    ];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', [QUADRANT_VALUES[0]]], // urgent-important
      ['/root/b.txt', [QUADRANT_VALUES[2]]], // noturgent-important
      ['/root/c.txt', ['unrelated']], // → untagged
    ]);
    const data = makeData(entries, tags);
    const { container } = renderMatrix(data);

    const quadrants = container.querySelectorAll('[data-testid^="matrix-quadrant-"]');
    assert.equal(quadrants.length, 4);

    // The "untagged" tray header (text node) appears when untagged.length > 0.
    // Our makeT stub returns the key verbatim.
    assert.ok(
      (container.textContent ?? '').includes('untagged'),
      'untagged tray should render when untagged.length > 0'
    );
  });

  it('hides the UntaggedTray when no file lacks a quadrant tag', () => {
    cleanup();
    const entries = [entry('a.txt'), entry('b.txt')];
    const tags = new Map<string, string[]>([
      ['/root/a.txt', [QUADRANT_VALUES[0]]],
      ['/root/b.txt', [QUADRANT_VALUES[1]]],
    ]);
    const data = makeData(entries, tags);
    const { container } = renderMatrix(data);
    // No untagged files → the "untagged" tray header is not rendered.
    assert.ok(
      !(container.textContent ?? '').includes('untagged'),
      'untagged tray should be hidden when no untagged files'
    );
  });
});

// ---------------------------------------------------------------------
// #2: bucketing routes each file into the right quadrant
// ---------------------------------------------------------------------
describe('MatrixView #2: bucketing', () => {
  it('places a file with a quadrant tag into the matching quadrant count', () => {
    cleanup();
    const e1 = entry('a.txt');
    const e2 = entry('b.txt');
    const e3 = entry('c.txt');
    const e4 = entry('d.txt');
    const e5 = entry('e.txt'); // untagged
    const tags = new Map<string, string[]>([
      [`/root/${e1.name}`, [QUADRANT_VALUES[0]]],
      [`/root/${e2.name}`, [QUADRANT_VALUES[0]]], // 2 in quadrant 0
      [`/root/${e3.name}`, [QUADRANT_VALUES[1]]],
      [`/root/${e4.name}`, [QUADRANT_VALUES[3]]],
      [`/root/${e5.name}`, ['misc']],
    ]);
    const data = makeData([e1, e2, e3, e4, e5], tags);
    const { container } = renderMatrix(data);

    // Find each quadrant's count chip by its parent's testid.
    // Use .MuiChip-label (not .MuiChip-root) to avoid pseudo-element CSS
    // bleeding into textContent under MUI v5 emotion.
    for (const value of QUADRANT_VALUES) {
      const quadrantEl = container.querySelector(
        `[data-testid="matrix-quadrant-${value}"]`
      );
      assert.ok(quadrantEl, `quadrant ${value} not rendered`);
      const chipLabel = quadrantEl.querySelector('.MuiChip-label');
      assert.ok(chipLabel, `chip-label missing for ${value}`);
      const text = chipLabel.textContent ?? '';
      const expected =
        value === QUADRANT_VALUES[0] ? '2' :
        value === QUADRANT_VALUES[1] ? '1' :
        value === QUADRANT_VALUES[3] ? '1' :
        '0';
      assert.equal(text, expected, `quadrant ${value} count mismatch`);
    }
  });
});

// ---------------------------------------------------------------------
// #3: quadrant right-click → "New Folder" / "New File" menu
// ---------------------------------------------------------------------
describe('MatrixView #3: quadrant right-click menu', () => {
  it('opens a menu with New Folder / New File when a quadrant is right-clicked', () => {
    cleanup();
    const data = makeData([], new Map());
    renderMatrix(data);

    const quadrant = document.querySelector(
      `[data-testid="matrix-quadrant-${QUADRANT_VALUES[0]}"]`
    ) as HTMLElement;
    assert.ok(quadrant, 'first quadrant missing');

    fireEvent.contextMenu(quadrant, { clientX: 100, clientY: 100 });

    // MUI Menu renders into a Portal (document body), so use document scope.
    const text = document.body.textContent ?? '';
    assert.ok(text.includes('newFolder'), 'newFolder menu item missing');
    assert.ok(text.includes('newFile'), 'newFile menu item missing');
  });

  it('calls onCreateTagged("folder", value) when New Folder is clicked', () => {
    cleanup();
    const spies: Spies = {};
    const data = makeData([], new Map(), false, spies);
    renderMatrix(data);

    const quadrant = document.querySelector(
      `[data-testid="matrix-quadrant-${QUADRANT_VALUES[0]}"]`
    ) as HTMLElement;
    fireEvent.contextMenu(quadrant, { clientX: 50, clientY: 50 });

    // Find the "newFolder" menu item inside the portal-rendered Menu.
    const newFolderItem = [...document.querySelectorAll('li')].find((li) =>
      (li.textContent ?? '').includes('newFolder')
    ) as HTMLElement;
    assert.ok(newFolderItem, 'newFolder menu item not found');
    fireEvent.click(newFolderItem);

    assert.equal(spies.createTagged?.called, 1);
    assert.deepEqual(spies.createTagged?.last, {
      kind: 'folder',
      tag: QUADRANT_VALUES[0],
    });
  });

  it('disables the menu items when readOnly', () => {
    cleanup();
    const data = makeData([], new Map(), true /* readOnly */);
    renderMatrix(data);

    const quadrant = document.querySelector(
      `[data-testid="matrix-quadrant-${QUADRANT_VALUES[0]}"]`
    ) as HTMLElement;
    fireEvent.contextMenu(quadrant, { clientX: 1, clientY: 1 });

    const newFolderItem = [...document.querySelectorAll('li')].find((li) =>
      (li.textContent ?? '').includes('newFolder')
    ) as HTMLElement | undefined;
    assert.ok(newFolderItem, 'newFolder menu item not found');
    // MUI marks disabled list items with the `aria-disabled` attribute.
    assert.equal(
      newFolderItem.getAttribute('aria-disabled'),
      'true',
      'newFolder should be disabled when readOnly'
    );
  });
});

// ---------------------------------------------------------------------
// #4: UntaggedTray readOnly lock icon
// ---------------------------------------------------------------------
describe('MatrixView #4: untagged tray readOnly indicator', () => {
  it('shows the lock icon when readOnly and there are untagged files', () => {
    cleanup();
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['misc']], // untagged
    ]);
    const data = makeData([entry('a.txt')], tags, true /* readOnly */);
    const { container } = renderMatrix(data);

    const lock = container.querySelector(
      '[data-testid="matrix-untagged-readonly"]'
    );
    assert.ok(lock, 'readOnly lock icon should appear on the UntaggedTray');
  });

  it('hides the lock icon when not readOnly', () => {
    cleanup();
    const tags = new Map<string, string[]>([
      ['/root/a.txt', ['misc']],
    ]);
    const data = makeData([entry('a.txt')], tags, false);
    const { container } = renderMatrix(data);

    const lock = container.querySelector(
      '[data-testid="matrix-untagged-readonly"]'
    );
    assert.equal(lock, null, 'lock icon must not appear in writable mode');
  });
});

// ---------------------------------------------------------------------
// #5: header title uses the quadrant i18n key, not the raw token
// ---------------------------------------------------------------------
describe('MatrixView #5: localized header', () => {
  it('renders the smartTagQuadrantUrgentImportant i18n key in the Q1 header', () => {
    cleanup();
    const data = makeData([], new Map());
    const { container } = renderMatrix(data);

    const q1 = container.querySelector(
      `[data-testid="matrix-quadrant-${QUADRANT_VALUES[0]}"]`
    );
    assert.ok(q1, 'Q1 quadrant missing');
    // Our makeT stub echoes the key verbatim. If the header used the raw
    // token "urgent-important" instead of the i18n key, we'd see that
    // string here, not the smartTagQuadrantUrgentImportant key.
    const text = q1.textContent ?? '';
    assert.ok(
      text.includes('smartTagQuadrantUrgentImportant'),
      `Q1 header should reference the i18n key, got: ${text}`
    );
    assert.ok(
      !text.match(/\burgent-important\b/),
      `Q1 header should not leak the raw token, got: ${text}`
    );
  });
});

// silence unused-import warning: UNTAGGED_COLUMN is referenced only via
// the bucket algorithm which is unit-tested elsewhere; keeping the import
// here documents the dependency for future tests.
void UNTAGGED_COLUMN;
