import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createViewerPrefs } from './viewer-prefs';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

function installWindow(localStorage: unknown): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage },
  });
}

describe('createViewerPrefs', () => {
  it('prefixes keys and preserves stored strings and missing-key nulls', () => {
    const values = new Map<string, string>();
    const reads: string[] = [];
    installWindow({
      getItem(key: string) {
        reads.push(key);
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
    });
    const prefs = createViewerPrefs('font-viewer.');

    assert.equal(prefs.getPref('size'), null);
    prefs.setPref('size', '42');
    prefs.setPref('customText', '');
    assert.equal(prefs.getPref('size'), '42');
    assert.equal(prefs.getPref('customText'), '');
    assert.deepEqual(reads, [
      'font-viewer.size',
      'font-viewer.size',
      'font-viewer.customText',
    ]);
    assert.equal(values.has('size'), false);
  });

  it('returns null when a storage read fails', () => {
    installWindow({
      getItem() {
        throw new Error('storage disabled');
      },
      setItem() {
        throw new Error('unreachable');
      },
    });

    assert.equal(createViewerPrefs('html-viewer.').getPref('manualZoom'), null);
  });

  it('silently ignores storage write failures', () => {
    installWindow({
      getItem() {
        return null;
      },
      setItem() {
        throw new Error('quota exceeded');
      },
    });

    assert.doesNotThrow(() =>
      createViewerPrefs('html-viewer.').setPref('imagesEnabled', 'false')
    );
  });

  it('also handles a throwing window.localStorage getter', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('sandbox denied');
      },
    });
    const prefs = createViewerPrefs('font-viewer.');

    assert.equal(prefs.getPref('size'), null);
    assert.doesNotThrow(() => prefs.setPref('size', '42'));
  });
});
