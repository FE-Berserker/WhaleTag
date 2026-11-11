import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import { RowColumnLabels } from './FileListHeader';

let cleanupDom: (() => void) | undefined;

before(async () => {
  cleanupDom = globalJsdom();
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: {} } },
    interpolation: { escapeValue: false },
  });
});

afterEach(() => cleanup());
after(() => cleanupDom?.());

function renderHeader(width = 300, captureFails = false) {
  const commits: { column: string; width: number }[] = [];
  const view = render(
    <I18nextProvider i18n={i18next}>
      <RowColumnLabels
        selectAllState="unchecked"
        onToggleSelectAll={() => undefined}
        disabled={false}
        thumbSize={40}
        labels={{ name: 'Name', tags: 'Tags', size: 'Size', modified: 'Modified' }}
        sort={{ key: 'name', dir: 'asc' }}
        setSort={() => undefined}
        columnWidths={{ name: width, size: 80, modified: 150 }}
        hiddenColumns={[]}
        setColumnWidth={(column, nextWidth) =>
          commits.push({ column, width: nextWidth })
        }
        toggleColumn={() => undefined}
      />
    </I18nextProvider>
  );
  const handle = view.getByTestId('column-resize-name');
  const nameHeader = view.getAllByRole('columnheader')[0];
  const capture = { set: 0, release: 0 };
  handle.setPointerCapture = () => {
    capture.set += 1;
    if (captureFails) throw new Error('pointer capture unavailable');
  };
  handle.releasePointerCapture = () => {
    capture.release += 1;
  };
  return { view, handle, nameHeader, commits, capture };
}

/** No drag implementation should install temporary document listeners. */
function watchDocumentDragListeners() {
  const original = document.addEventListener;
  const types = new Set([
    'mousemove',
    'mouseup',
    'pointermove',
    'pointerup',
    'pointercancel',
    'lostpointercapture',
  ]);
  let additions = 0;
  document.addEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) {
    if (types.has(type)) additions += 1;
    return original.call(this, type, listener, options);
  } as typeof document.addEventListener;
  return {
    get additions() {
      return additions;
    },
    restore() {
      document.addEventListener = original;
    },
  };
}

function watchWindowFallbackListeners() {
  const originalAdd = window.addEventListener;
  const originalRemove = window.removeEventListener;
  const types = new Set(['pointerup', 'pointercancel']);
  let active = 0;
  window.addEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) {
    if (types.has(type)) active += 1;
    return originalAdd.call(this, type, listener, options);
  } as typeof window.addEventListener;
  window.removeEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ) {
    if (types.has(type)) active -= 1;
    return originalRemove.call(this, type, listener, options);
  } as typeof window.removeEventListener;
  return {
    get active() {
      return active;
    },
    restore() {
      window.addEventListener = originalAdd;
      window.removeEventListener = originalRemove;
    },
  };
}

describe('RowColumnLabels pointer resizing', () => {
  it('previews moves locally and commits exactly the final width on pointerup', () => {
    const listeners = watchDocumentDragListeners();
    try {
      const { handle, nameHeader, commits, capture } = renderHeader();
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 130 });
      assert.equal(window.getComputedStyle(nameHeader).flexBasis, '330px');
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 150 });
      assert.equal(window.getComputedStyle(nameHeader).flexBasis, '350px');
      assert.deepEqual(commits, [], 'pointermoves must not persist');

      // No trailing move at the release coordinate: pointerup supplies the
      // final value itself.
      fireEvent.pointerUp(handle, { pointerId: 1, clientX: 165 });
      assert.deepEqual(commits, [{ column: 'name', width: 365 }]);
      assert.equal(window.getComputedStyle(nameHeader).flexBasis, '300px');
      assert.equal(document.body.style.cursor, '');
      assert.equal(capture.set, 1);
      assert.equal(capture.release, 1);
      assert.equal(listeners.additions, 0);
    } finally {
      listeners.restore();
    }
  });

  it('clamps both the visual preview and the final commit to column bounds', () => {
    const { handle, nameHeader, commits } = renderHeader();
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: -500 });
    assert.equal(window.getComputedStyle(nameHeader).flexBasis, '120px');
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 1000 });
    assert.equal(window.getComputedStyle(nameHeader).flexBasis, '600px');
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 1000 });
    assert.deepEqual(commits, [{ column: 'name', width: 600 }]);
  });

  it('handles window up/cancel and unmount when pointer capture fails', () => {
    const { view, handle, nameHeader, commits } = renderHeader(300, true);
    const listeners = watchWindowFallbackListeners();
    try {
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
      assert.equal(listeners.active, 2);
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 150 });
      assert.equal(window.getComputedStyle(nameHeader).flexBasis, '350px');
      assert.deepEqual(commits, []);

      fireEvent.pointerUp(window, { pointerId: 1, clientX: 165 });
      assert.deepEqual(commits, [{ column: 'name', width: 365 }]);
      assert.equal(listeners.active, 0);
      assert.equal(document.body.style.cursor, '');
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 165 });
      assert.equal(commits.length, 1, 'a removed fallback cannot commit twice');

      fireEvent.pointerDown(handle, { pointerId: 2, clientX: 100 });
      assert.equal(listeners.active, 2);
      fireEvent.pointerCancel(window, { pointerId: 2, clientX: 150 });
      assert.equal(listeners.active, 0);
      assert.equal(commits.length, 1, 'window cancellation must not commit');

      fireEvent.pointerDown(handle, { pointerId: 3, clientX: 100 });
      assert.equal(listeners.active, 2);
      view.unmount();
      assert.equal(listeners.active, 0);
      fireEvent.pointerUp(window, { pointerId: 3, clientX: 150 });
      assert.equal(commits.length, 1, 'unmount must remove the fallback');
    } finally {
      listeners.restore();
    }
  });

  it('restores the controlled width on pointercancel and lost capture', () => {
    const listeners = watchDocumentDragListeners();
    try {
      const { handle, nameHeader, commits } = renderHeader();
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 150 });
      assert.equal(window.getComputedStyle(nameHeader).flexBasis, '350px');
      fireEvent.pointerCancel(handle, { pointerId: 1, clientX: 150 });
      assert.equal(window.getComputedStyle(nameHeader).flexBasis, '300px');
      assert.deepEqual(commits, []);
      assert.equal(document.body.style.cursor, '');

      fireEvent.pointerDown(handle, { pointerId: 2, clientX: 200 });
      fireEvent.pointerMove(handle, { pointerId: 2, clientX: 230 });
      assert.equal(window.getComputedStyle(nameHeader).flexBasis, '330px');
      fireEvent.lostPointerCapture(handle, { pointerId: 2, clientX: 230 });
      assert.equal(window.getComputedStyle(nameHeader).flexBasis, '300px');
      assert.deepEqual(commits, []);
      assert.equal(document.body.style.cursor, '');
      assert.equal(listeners.additions, 0);
    } finally {
      listeners.restore();
    }
  });

  it('cancels an active drag on unmount without leaking listeners', () => {
    const listeners = watchDocumentDragListeners();
    try {
      const { view, handle, commits, capture } = renderHeader();
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 150 });
      view.unmount();
      assert.deepEqual(commits, []);
      assert.equal(capture.release, 1);
      assert.equal(document.body.style.cursor, '');
      fireEvent.pointerUp(document, { pointerId: 1, clientX: 150 });
      assert.deepEqual(commits, []);
      assert.equal(listeners.additions, 0);
    } finally {
      listeners.restore();
    }
  });
});
