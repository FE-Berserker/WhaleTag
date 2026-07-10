/**
 * H.26 P2-1: component-level tests for MapiqueView. Locks down P0/P1 gains
 * (tray filter, domain context menus, keyboard navigation, copy coordinates)
 * so future refactors don't regress them.
 *
 * Test infrastructure: node:test + global-jsdom + @testing-library/react.
 * Leaflet / react-leaflet / react-leaflet-cluster are stubbed via require.cache
 * because they expect a real browser layout environment.
 */

import globalJsdom from 'global-jsdom';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { Provider } from 'react-redux';
import { createStore } from 'redux';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import i18next from 'i18next';
import * as React from 'react';

import { CurrentLocationContext } from '../hooks/CurrentLocationContextProvider';
import { DirectoryContentContext, DirectoryUIContext } from '../hooks/DirectoryContentContextProvider';
import type { DirEntry } from '../../shared/ipc-types';
import type { MapiqueViewProps } from './MapiqueView';

const STUB_STORE = createStore(() => ({
  settings: { officeThumbnailEnabled: false, sofficePath: null },
}));

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

let MapiqueView: typeof import('./MapiqueView').default;

function entry(name: string, extra: Partial<DirEntry> = {}): DirEntry {
  const dot = name.lastIndexOf('.');
  return {
    name,
    path: `/root/${name}`,
    isFile: true,
    isDirectory: false,
    size: 0,
    modified: '1970-01-01T00:00:00.000Z',
    extension: dot >= 0 ? name.slice(dot + 1).toLowerCase() : '',
    ...extra,
  };
}

function makeProps(
  entries: DirEntry[],
  overrides: Partial<MapiqueViewProps> = {}
): MapiqueViewProps {
  return {
    entries,
    geoByName: new Map(),
    tagsByName: new Map(),
    thumbCache: new Map(),
    onGpsFound: () => {},
    onOpen: () => {},
    onSetGeo: () => {},
    onClearGeo: () => {},
    onAddTag: () => {},
    onRemoveTag: () => {},
    provider: 'osm',
    readOnly: false,
    loading: false,
    tagColors: {},
    groups: [],
    ...overrides,
  };
}

function renderMapique(props: MapiqueViewProps) {
  return render(
    <I18nextProvider i18n={i18next} defaultNS="common">
      <Provider store={STUB_STORE}>
        <DndProvider backend={HTML5Backend}>
          <CurrentLocationContext.Provider value={LOCATION_CTX_STUB}>
            <DirectoryContentContext.Provider value={DIR_CONTENT_STUB}>
            <DirectoryUIContext.Provider value={DIR_CONTENT_STUB}>
              <MapiqueView {...props} />
            </DirectoryUIContext.Provider>
          </DirectoryContentContext.Provider>
          </CurrentLocationContext.Provider>
        </DndProvider>
      </Provider>
    </I18nextProvider>
  );
}

before(async () => {
  globalJsdom();

  await i18next.use(initReactI18next).init({
    resources: { en: { common: {} }, zh: { common: {} } },
    lng: 'en',
    fallbackLng: 'en',
    defaultNS: 'common',
    ns: ['common'],
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });

  if (typeof globalThis.IntersectionObserver === 'undefined') {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
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

  // jsdom does not implement the clipboard API; provide a stub for copy tests.
  if (typeof navigator !== 'undefined' && !navigator.clipboard) {
    (navigator as { clipboard: { writeText: (text: string) => Promise<void> } }).clipboard = {
      writeText: async () => {},
    };
  }

  const mapStub = {
    on: () => {},
    off: () => {},
    remove: () => {},
    invalidateSize: () => {},
    fitBounds: () => {},
    getContainer: () => ({ getBoundingClientRect: () => ({ width: 800, height: 600 }) }),
  };

  // H.26: Stub Leaflet modules so the map initializes without layout under jsdom.
  const fakeL = {
    map: () => mapStub,
    divIcon: () => ({ createIcon: () => document.createElement('div') }),
    marker: () => ({ addTo: () => {}, on: () => {}, bindPopup: () => {} }),
    featureGroup: () => ({ getBounds: () => ({ pad: () => ({}) }) }),
    tileLayer: () => ({ addTo: () => {} }),
  };

  require.cache[require.resolve('leaflet')] = { exports: fakeL } as any;
  require.cache[require.resolve('react-leaflet')] = {
    exports: {
      MapContainer: ({ children }: any) => <div data-testid="leaflet-map">{children}</div>,
      TileLayer: () => null,
      Marker: ({ children }: any) => <>{children}</>,
      Popup: ({ children }: any) => <>{children}</>,
      useMap: () => mapStub,
      useMapEvents: () => ({}),
    },
  } as any;
  require.cache[require.resolve('react-leaflet-cluster')] = {
    exports: ({ children }: any) => <>{children}</>,
  } as any;

  const mod = await import('./MapiqueView');
  MapiqueView = mod.default;
});

describe('MapiqueView', () => {
  it('renders tray filter toggle buttons', () => {
    cleanup();
    const props = makeProps([entry('a.jpg'), entry('b.jpg')]);
    const { container } = renderMapique(props);
    const buttons = container.querySelectorAll('.MuiToggleButton-root');
    assert.equal(buttons.length, 3);
    assert.ok(Array.from(buttons).some((b) => b.textContent === 'mapiqueFilterAll'));
    assert.ok(Array.from(buttons).some((b) => b.textContent === 'mapiqueFilterLocated'));
    assert.ok(Array.from(buttons).some((b) => b.textContent === 'mapiqueFilterUnlocated'));
  });

  it('filters tray to located entries only', () => {
    cleanup();
    const tagsByName = new Map([
      ['/root/located.jpg', ['geo:1.0,2.0']],
      ['/root/plain.jpg', []],
    ]);
    const props = makeProps(
      [entry('located.jpg'), entry('plain.jpg')],
      { tagsByName }
    );
    const { container } = renderMapique(props);

    const locatedBtn = Array.from(
      container.querySelectorAll('.MuiToggleButton-root')
    ).find((b) => b.textContent === 'mapiqueFilterLocated') as HTMLElement;
    fireEvent.click(locatedBtn);

    const rows = container.querySelectorAll('[data-entry-path]');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.getAttribute('data-entry-path'), '/root/located.jpg');
  });

  it('opens blank-map context menu with save/copy/set-location items', async () => {
    cleanup();
    const props = makeProps([entry('a.jpg'), entry('b.jpg')]);
    props.onSetGeo = () => {};
    const { container } = renderMapique(props);

    // Select two files so the set-location item is enabled.
    const rows = container.querySelectorAll('[data-entry-path]');
    fireEvent.click(rows[0]!);
    fireEvent.click(rows[1]!, { ctrlKey: true });

    const map = container.querySelector('[data-testid="leaflet-map"]') as HTMLElement;
    fireEvent.contextMenu(map, { clientX: 100, clientY: 100 });

    await waitFor(() => {
      const items = Array.from(document.querySelectorAll('.MuiMenuItem-root'));
      const texts = items.map((i) => i.textContent);
      assert.ok(texts.includes('saveImage'));
      assert.ok(texts.includes('saveImageAs'));
      assert.ok(texts.includes('mapiqueCopyMap'));
      assert.ok(texts.includes('mapiqueSetLocationForSelection'));
      assert.ok(texts.includes('mapiqueClearLocationForSelection'));
      const setItem = items.find((i) => i.textContent === 'mapiqueSetLocationForSelection') as HTMLElement;
      assert.ok(setItem);
      assert.notEqual(setItem.getAttribute('aria-disabled'), 'true');
    });
  });

  it('supports tray keyboard navigation and Enter to open', () => {
    cleanup();
    const opened: string[] = [];
    const props = makeProps([entry('a.jpg'), entry('b.jpg')], {
      onOpen: (e) => opened.push(e.path),
    });
    const { container } = renderMapique(props);
    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;

    listbox.focus();
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'Enter' });

    assert.equal(opened.length, 1);
    assert.equal(opened[0], '/root/a.jpg');
  });

  it('copies coordinates from marker context menu', async () => {
    cleanup();
    const clipboard: string[] = [];
    const originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async (text: string) => {
      clipboard.push(text);
    };
    try {
      const tagsByName = new Map([['/root/geo.jpg', ['geo:12.345678,98.765432']]]);
      const props = makeProps([entry('geo.jpg')], { tagsByName });
      const { container } = renderMapique(props);

      const rows = container.querySelectorAll('[data-entry-path]');
      fireEvent.click(rows[0]!);

      fireEvent.contextMenu(rows[0]!, { clientX: 50, clientY: 50 });

      const copyItem = await waitFor(() => {
        const items = Array.from(document.querySelectorAll('.MuiMenuItem-root'));
        return items.find((i) => i.textContent === 'mapCopyCoords') as HTMLElement;
      });
      fireEvent.click(copyItem);

      assert.equal(clipboard.length, 1);
      assert.equal(clipboard[0], '12.345678, 98.765432');
    } finally {
      navigator.clipboard.writeText = originalWriteText;
    }
  });
});
