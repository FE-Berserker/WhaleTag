import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import type { DirEntry } from '../../shared/ipc-types';

let cleanupDom: (() => void) | undefined;
let MediaLightbox: typeof import('./MediaLightbox').default;

function image(name: string): DirEntry {
  return {
    name,
    path: `/album/${name}`,
    isDirectory: false,
    isFile: true,
    size: 3,
    modified: '2026-01-02T03:04:05.000Z',
    extension: 'jpg',
  };
}

before(async () => {
  cleanupDom = globalJsdom();
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: {
      en: {
        translation: {
          close: 'Close',
          previous: 'Previous',
          next: 'Next',
          zoomIn: 'Zoom in',
          zoomOut: 'Zoom out',
          resetZoom: 'Reset zoom',
        },
      },
    },
    interpolation: { escapeValue: false },
  });

  // `ipcApi` captures `window.whale` ONCE at module load, so the bridge has to
  // exist before the lightbox module is imported. jsdom has no object URLs.
  (globalThis.URL as unknown as { createObjectURL: () => string }).createObjectURL = () =>
    'blob:test/image';
  (globalThis.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL =
    () => undefined;
  (window as unknown as { whale: unknown }).whale = {
    readFile: async () => new Uint8Array([0xff, 0xd8, 0xff]),
    onMediaChanged: () => () => undefined,
  };

  MediaLightbox = (await import('./MediaLightbox')).default;
});

afterEach(() => cleanup());
after(() => cleanupDom?.());

/**
 * Tracks the document-level `keydown` listeners registered RIGHT NOW.
 *
 * Counting raw registrations is not enough: MUI's Dialog/focus-trap installs
 * its own keydown listeners during mount, so an absolute count is noisy. The
 * bug being guarded is a teardown + re-registration (a NEW function identity)
 * of the lightbox's listener, so comparing the live set is exact.
 */
function watchKeydownListeners() {
  const originalAdd = document.addEventListener;
  const originalRemove = document.removeEventListener;
  const active = new Set<unknown>();
  document.addEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) {
    if (type === 'keydown') active.add(listener);
    return originalAdd.call(document, type, listener, options);
  } as typeof document.addEventListener;
  document.removeEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ) {
    if (type === 'keydown') active.delete(listener);
    return originalRemove.call(document, type, listener, options);
  } as typeof document.removeEventListener;
  return {
    get size() {
      return active.size;
    },
    snapshot(): unknown[] {
      return Array.from(active);
    },
    /** Only the lightbox's own capture-phase wrapper (it reads `keyHandlerRef`). */
    keyHandlers(): unknown[] {
      return Array.from(active).filter(
        (fn) => typeof fn === 'function' && fn.toString().includes('keyHandlerRef')
      );
    },
    restore() {
      document.addEventListener = originalAdd;
      document.removeEventListener = originalRemove;
    },
  };
}

describe('MediaLightbox keyboard wiring', () => {
  it('registers one document keydown listener for its own lifecycle', async () => {
    const watcher = watchKeydownListeners();
    try {
      const view = render(
        <I18nextProvider i18n={i18next}>
          <MediaLightbox
            open
            entries={[image('a.jpg'), image('b.jpg')]}
            initialIndex={0}
            onClose={() => undefined}
          />
        </I18nextProvider>
      );
      await waitFor(() => assert.ok(document.querySelector('img')));
      assert.equal(watcher.keyHandlers().length, 1, 'the lightbox owns one keydown listener');
      view.unmount();
      assert.equal(watcher.keyHandlers().length, 0, 'its keydown listener is removed');
    } finally {
      watcher.restore();
    }
  });

  it('does not rebind the keyboard listener when wheel zoom changes the scale', async () => {
    const watcher = watchKeydownListeners();
    try {
      const view = render(
        <I18nextProvider i18n={i18next}>
          <MediaLightbox
            open
            entries={[image('a.jpg'), image('b.jpg')]}
            initialIndex={0}
            onClose={() => undefined}
          />
        </I18nextProvider>
      );
      const img = await waitFor(() => {
        const el = document.querySelector('img');
        assert.ok(el);
        return el as HTMLImageElement;
      });
      assert.ok(view.queryByText('100%'), 'starts at fit (100%)');
      const listenersBefore = watcher.keyHandlers();
      assert.equal(listenersBefore.length, 1);

      fireEvent.wheel(img, { deltaY: -100 });
      await waitFor(() => assert.ok(view.queryByText('115%')));
      assert.deepEqual(
        watcher.keyHandlers(),
        listenersBefore,
        'zoom state must not tear down and re-add the keydown listener'
      );

      fireEvent.wheel(img, { deltaY: 100 });
      await waitFor(() => assert.ok(view.queryByText('100%')));
      assert.deepEqual(watcher.keyHandlers(), listenersBefore);
    } finally {
      watcher.restore();
    }
  });

  it('Escape resets the zoom first and only closes at fit scale', async () => {
    let closed = 0;
    render(
      <I18nextProvider i18n={i18next}>
        <MediaLightbox
          open
          entries={[image('a.jpg')]}
          initialIndex={0}
          onClose={() => {
            closed += 1;
          }}
        />
      </I18nextProvider>
    );
    const img = await waitFor(() => {
      const el = document.querySelector('img');
      assert.ok(el);
      return el as HTMLImageElement;
    });

    fireEvent.wheel(img, { deltaY: -100 });
    await waitFor(() => assert.ok(document.body.textContent?.includes('115%')));

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => assert.ok(document.body.textContent?.includes('100%')));
    assert.equal(closed, 0, 'first Escape undoes the zoom instead of closing');

    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(closed, 1, 'second Escape closes');
  });

  it('arrow keys navigate the playlist', async () => {
    render(
      <I18nextProvider i18n={i18next}>
        <MediaLightbox
          open
          entries={[image('a.jpg'), image('b.jpg')]}
          initialIndex={0}
          onClose={() => undefined}
        />
      </I18nextProvider>
    );
    await waitFor(() => assert.ok(document.querySelector('img')));

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    await waitFor(() => assert.ok(document.body.textContent?.includes('(2 / 2)')));
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    await waitFor(() => assert.ok(document.body.textContent?.includes('(1 / 2)')));
  });

  it('consumed keys are stopped before handlers behind the lightbox; Ctrl chords pass through', async () => {
    render(
      <I18nextProvider i18n={i18next}>
        <MediaLightbox
          open
          entries={[image('a.jpg'), image('b.jpg')]}
          initialIndex={0}
          onClose={() => undefined}
        />
      </I18nextProvider>
    );
    await waitFor(() => assert.ok(document.querySelector('img')));

    // A bubble-phase listener on `document` stands in for everything behind
    // the lightbox (FileList binds ← to "history back" and → to "open" there).
    // Events are dispatched on a node INSIDE the dialog so the lightbox's
    // capture-phase listener runs first; its stopPropagation must keep the
    // bubble listener from ever firing.
    const seen: string[] = [];
    const behind = (e: KeyboardEvent) => {
      seen.push(e.key);
    };
    document.addEventListener('keydown', behind);
    try {
      const target = document.querySelector('[role="dialog"]') ?? document.body;
      for (const key of ['ArrowRight', 'ArrowLeft', '+', '-', '0']) {
        fireEvent.keyDown(target, { key });
      }
      assert.deepEqual(seen, [], 'lightbox keys must not leak to the list behind it');

      // Ctrl+= / Ctrl+0 are the app's zoom chords — not the lightbox's.
      fireEvent.keyDown(target, { key: '=', ctrlKey: true });
      fireEvent.keyDown(target, { key: '0', ctrlKey: true });
      assert.deepEqual(seen, ['=', '0']);
    } finally {
      document.removeEventListener('keydown', behind);
    }
  });
});
