/**
 * P0 · 拖拽打标 (2026-07-02): component-level tests for GalleryView.
 * Locks down the smoke render (after extracting GalleryTile subcomponent),
 * the onClick / onDoubleClick wiring, and the prop surface required by the
 * `<GalleryView>` wiring in `FileList.tsx`. We don't drive the actual HTML5
 * drag pipeline (jsdom + react-dnd HTML5Backend is hard to drive, per
 * `MatrixView.test.tsx:11-15`'s note) — the drag-canDrop-drop logic in
 * `GalleryTile` is covered by `useListCommands.handleDropTag`'s own unit
 * tests + manual smoke. The component test here guards against future
 * regressions to the prop surface, the click → onSelect mods shape, and
 * the per-tile ref + dropRef ref-sharing pattern.
 */

// global-jsdom@29: must be explicitly invoked in before() — see
// CalendarView.test.tsx / KanbanView.test.tsx for the full rationale.
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

import GalleryView from './GalleryView';
import type { DirEntry } from '../../shared/ipc-types';
import { PeriodTagDialogProvider } from './PeriodTagDialog';

/** Minimal DirEntry factory. Defaults to a `.png` file (passes mediaPlaylist). */
function entry(name: string, path = `/root/${name}`): DirEntry {
  const dot = name.lastIndexOf('.');
  return {
    name,
    path,
    isFile: true,
    isDirectory: false,
    size: 0,
    modified: '1970-01-01T00:00:00.000Z',
    extension: dot >= 0 ? name.slice(dot + 1).toLowerCase() : '',
  };
}

/**
 * Spy holder: tracks per-callback invocations so tests can assert without
 * coupling to the react-dnd HTML5Backend.
 */
interface Spies {
  selectEntry?: { called: number; last: { entry: DirEntry; mods: { shift: boolean; toggle: boolean } } | null };
  openEntry?: { called: number; last: DirEntry | null };
  dropTag?: { called: number; last: { entry: DirEntry; tag: string; functionality?: string } | null };
}

function makeProps(entries: DirEntry[], selected: Set<string> = new Set(), spies: Spies = {}) {
  return {
    entries,
    thumbCache: new Map<string, string>(),
    entrySize: 160,
    selected,
    onSelect: (e: DirEntry, mods: { shift: boolean; toggle: boolean }) => {
      spies.selectEntry = spies.selectEntry ?? { called: 0, last: null };
      spies.selectEntry.called += 1;
      spies.selectEntry.last = { entry: e, mods };
    },
    onOpen: (e: DirEntry) => {
      spies.openEntry = spies.openEntry ?? { called: 0, last: null };
      spies.openEntry.called += 1;
      spies.openEntry.last = e;
    },
    // P0: drop-tag callback wired to FileList as `commands.handleDropTag`.
    // Not exercised through the actual drag pipeline here (see file header),
    // but the prop surface contract is what FileList depends on.
    onDropTag: (entry: DirEntry, tag: string, functionality?: string) => {
      spies.dropTag = spies.dropTag ?? { called: 0, last: null };
      spies.dropTag.called += 1;
      spies.dropTag.last = { entry, tag, functionality };
    },
    readOnly: false,
    tagsByName: new Map<string, string[]>(),
    tagColors: {},
    groups: [],
  };
}

function renderGallery(props: ReturnType<typeof makeProps>) {
  return render(
    <I18nextProvider i18n={i18next} defaultNS="common">
      <Provider store={STUB_STORE}>
        <DndProvider backend={HTML5Backend}>
          <PeriodTagDialogProvider>
            <GalleryView {...props} />
          </PeriodTagDialogProvider>
        </DndProvider>
      </Provider>
    </I18nextProvider>
  );
}

/**
 * Minimal redux stub for `ThumbIcon`'s `useSelector` (it reads
 * `officeThumbnailEnabled` / `sofficePath` from settings — no-op defaults
 * are fine because GalleryView doesn't gate on them).
 */
const STUB_STORE = createStore(() => ({
  settings: { officeThumbnailEnabled: false, sofficePath: null },
}));

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

  // jsdom 18+ does not provide IntersectionObserver; ThumbIcon uses it.
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
  // ResizeObserver polyfill (GalleryView uses it for the column-width effect).
  if (typeof globalThis.ResizeObserver === 'undefined') {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  // matchMedia polyfill (MUI sometimes reads it).
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
// Test #1: smoke render — empty entries → noMedia placeholder.
// mediaPlaylist filters to image/video only; a single `.png` is the
// minimum-viable fixture. .txt entries are dropped, so we only assert
// on a media entry below.
// ---------------------------------------------------------------------
describe('GalleryView #1: smoke render', () => {
  it('renders media entries as tiles inside the role="grid" container', () => {
    cleanup();
    const props = makeProps([
      entry('a.png'),
      entry('b.jpg'),
      entry('c.mp4'),
    ]);
    const { container } = renderGallery(props);

    const grid = container.querySelector('[role="grid"]');
    assert.ok(grid, 'container must expose role="grid"');
    // The label is rendered through t('gallery'), and our makeT stub returns
    // the bare key. This locks the i18n contract.
    assert.equal(grid.getAttribute('aria-label'), 'gallery');
    // Three media tiles (a.png, b.jpg, c.mp4 all pass mediaPlaylist).
    const tiles = container.querySelectorAll('[data-testid="gallery-tile"]');
    assert.equal(tiles.length, 3, 'one tile per media entry');
  });

  it('falls back to the noMedia placeholder when no media entries exist', () => {
    cleanup();
    const props = makeProps([
      // .txt is not media — mediaPlaylist drops it.
      entry('a.txt'),
    ]);
    const { container } = renderGallery(props);

    // The empty-state Typography renders `t('noMedia')` directly.
    assert.ok(
      (container.textContent ?? '').includes('noMedia'),
      'noMedia key should render in the empty state'
    );
    // And no tile list at all.
    assert.equal(container.querySelectorAll('[data-testid="gallery-tile"]').length, 0);
  });
});

// ---------------------------------------------------------------------
// Test #2: click on a tile fires onSelect with the right `mods` shape —
// the P1-1 multi-select contract FileList relies on.
// ---------------------------------------------------------------------
describe('GalleryView #2: click → onSelect mods shape', () => {
  it('plain click sends {shift:false, toggle:false}', () => {
    cleanup();
    const entries = [entry('a.png')];
    const spies: Spies = {};
    const props = makeProps(entries, new Set(), spies);
    const { container } = renderGallery(props);

    const tile = container.querySelector('[data-testid="gallery-tile"]') as HTMLElement;
    assert.ok(tile, 'tile should render');
    fireEvent.click(tile);

    assert.ok(spies.selectEntry, 'onSelect should be invoked');
    assert.equal(spies.selectEntry?.called, 1);
    assert.equal(spies.selectEntry?.last?.entry.path, '/root/a.png');
    assert.deepEqual(spies.selectEntry?.last?.mods, { shift: false, toggle: false });
  });

  it('Ctrl+click sends toggle:true', () => {
    cleanup();
    const entries = [entry('a.png')];
    const spies: Spies = {};
    const props = makeProps(entries, new Set(), spies);
    const { container } = renderGallery(props);

    const tile = container.querySelector('[data-testid="gallery-tile"]') as HTMLElement;
    fireEvent.click(tile, { ctrlKey: true });

    assert.ok(spies.selectEntry);
    assert.equal(spies.selectEntry?.last?.mods.toggle, true);
  });

  it('Shift+click sends shift:true', () => {
    cleanup();
    const entries = [entry('a.png')];
    const spies: Spies = {};
    const props = makeProps(entries, new Set(), spies);
    const { container } = renderGallery(props);

    const tile = container.querySelector('[data-testid="gallery-tile"]') as HTMLElement;
    fireEvent.click(tile, { shiftKey: true });

    assert.ok(spies.selectEntry);
    assert.equal(spies.selectEntry?.last?.mods.shift, true);
  });
});

// ---------------------------------------------------------------------
// Test #3: double-click fires onOpen (lightbox entry path).
// ---------------------------------------------------------------------
describe('GalleryView #3: double-click → onOpen', () => {
  it('invokes onOpen with the double-clicked entry', () => {
    cleanup();
    const entries = [entry('a.png'), entry('b.jpg')];
    const spies: Spies = {};
    const props = makeProps(entries, new Set(), spies);
    const { container } = renderGallery(props);

    const tiles = container.querySelectorAll('[data-testid="gallery-tile"]');
    assert.equal(tiles.length, 2);
    fireEvent.doubleClick(tiles[1]);

    assert.ok(spies.openEntry, 'onOpen should be invoked');
    assert.equal(spies.openEntry?.last?.path, '/root/b.jpg');
  });
});

// ---------------------------------------------------------------------
// Test #4: P0 · readOnly propagates without throwing. The `canDrop` predicate
// inside `GalleryTile` returns false on readOnly, so the prop acceptance
// itself is the contract; the react-dnd internal collection is hidden, but
// if readOnly flows wrong it'd throw a TypeError when re-attaching dropRef.
// ---------------------------------------------------------------------
describe('GalleryView #4: P0 readOnly wiring', () => {
  it('mounts without throwing when readOnly={true}', () => {
    cleanup();
    const props = makeProps([entry('a.png')]);
    props.readOnly = true;
    // Just verify no throw; deeper canDrop testing needs react-dnd-test-backend.
    const { container } = renderGallery(props);
    assert.ok(container.querySelector('[data-testid="gallery-tile"]'), 'tile renders in readOnly mode');
  });
});

// ---------------------------------------------------------------------
// Test #5: showTags toggle controls the tag overlay visibility.
// ---------------------------------------------------------------------
describe('GalleryView #5: showTags toggle', () => {
  it('shows the tag overlay when showTags is true (default)', () => {
    cleanup();
    const entries = [entry('a.png')];
    const tagsByName = new Map<string, string[]>([['/root/a.png', ['vacation']]]);
    const props = { ...makeProps(entries), tagsByName };
    const { container } = renderGallery(props);

    assert.ok(
      container.querySelector('[data-testid="tile-tag-overlay"]'),
      'overlay should render when showTags is true'
    );
  });

  it('hides the tag overlay when showTags is false', () => {
    cleanup();
    const entries = [entry('a.png')];
    const tagsByName = new Map<string, string[]>([['/root/a.png', ['vacation']]]);
    const props = { ...makeProps(entries), tagsByName, showTags: false };
    const { container } = renderGallery(props);

    assert.equal(
      container.querySelectorAll('[data-testid="tile-tag-overlay"]').length,
      0,
      'overlay should not render when showTags is false'
    );
  });
});
