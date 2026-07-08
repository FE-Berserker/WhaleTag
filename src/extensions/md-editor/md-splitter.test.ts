/**
 * md-editor — unit tests for md-splitter.ts.
 *
 * Run via `npm test` (electron --test under node:test). Mirrors the test
 * pattern used by:
 *   - text-editor/editor-stats.test.ts
 *   - image-viewer/keymap.test.ts
 *
 * The splitter drives DOM events on real elements, so we register
 * `global-jsdom@29` once for the whole file. `localStorage` is stubbed
 * via a Map-backed shim (same pattern as editor-stats.test.ts) since
 * jsdom's localStorage throws in some setups.
 *
 * Covers §18.1.1 (resizable splitter) end-to-end:
 *   - default ratio (0.5) on first run
 *   - localStorage persistence (load + save)
 *   - mouse drag: mousedown → mousemove → mouseup
 *   - clamping at min / max ratio
 *   - double-click reset
 *   - keyboard nudge (Arrow / Home / End)
 *   - destroy() removes all listeners
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import globalJsdom from 'global-jsdom';

import { setupSplitter } from './md-splitter';

// --- jsdom + localStorage setup ------------------------------------------

const jsdomHandle = globalJsdom();
after(() => jsdomHandle?.());

// Map-backed localStorage shim. jsdom's real localStorage throws
// SecurityError in some configurations; the shim is also more controllable
// (we can clear between tests).
let memStore: Map<string, string>;
function withFreshStorage<T>(fn: () => T): T {
  memStore = new Map();
  const g = globalThis as unknown as { window?: { localStorage?: unknown } };
  const prev = g.window;
  g.window = {
    ...((prev as Record<string, unknown>) || {}),
    localStorage: {
      getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
      setItem: (k: string, v: string) => {
        memStore.set(k, v);
      },
      removeItem: (k: string) => {
        memStore.delete(k);
      },
      clear: () => memStore.clear(),
      key: () => null,
      get length() {
        return memStore.size;
      },
    },
  };
  try {
    return fn();
  } finally {
    if (prev === undefined) {
      delete g.window;
    } else {
      g.window = prev;
    }
  }
}

interface FixtureElements {
  editorPane: HTMLElement;
  previewPane: HTMLElement;
  splitter: HTMLElement;
  container: HTMLElement;
  body: HTMLElement;
}

function buildFixture(): FixtureElements {
  const body = document.body;
  body.innerHTML = '';
  const container = document.createElement('div');
  container.style.width = '1000px';
  container.style.height = '800px';
  // jsdom does not lay out elements, so getBoundingClientRect() returns
  // all zeros by default. Stub it to give the container a real size so
  // the drag-handler math (clientX / rect.width) actually computes.
  container.getBoundingClientRect = () => ({
    width: 1000,
    height: 800,
    top: 0,
    left: 0,
    right: 1000,
    bottom: 800,
    x: 0,
    y: 0,
    toJSON() {
      return { width: 1000, height: 800, top: 0, left: 0, right: 1000, bottom: 800, x: 0, y: 0 };
    },
  });
  const editorPane = document.createElement('div');
  editorPane.id = 'editor-pane';
  const splitter = document.createElement('div');
  splitter.id = 'splitter';
  const previewPane = document.createElement('div');
  previewPane.id = 'preview-pane';
  container.append(editorPane, splitter, previewPane);
  body.append(container);
  return { editorPane, previewPane, splitter, container, body };
}

/** Build a synthetic mouse event with the given clientX/Y + button. */
function mouseEvent(type: string, opts: { clientX: number; clientY?: number; button?: number }): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: opts.button ?? 0,
    clientX: opts.clientX,
    clientY: opts.clientY ?? 0,
  });
}

// --- Tests ---------------------------------------------------------------

describe('setupSplitter', () => {
  beforeEach(() => {
    // Reset body between tests so listeners on a previous container
    // don't leak (each buildFixture() replaces it).
    if (document.body) document.body.innerHTML = '';
  });

  it('initializes the editor pane to the default 50% ratio when no storage value', () => {
    withFreshStorage(() => {
      const fx = buildFixture();
      const handle = setupSplitter({
        editorPane: fx.editorPane,
        previewPane: fx.previewPane,
        splitter: fx.splitter,
        container: fx.container,
      });
      assert.equal(handle.getRatio(), 0.5);
      assert.match(fx.editorPane.style.flex, /^0 0 50(\.\d+)?%/);
      assert.equal(fx.splitter.getAttribute('aria-valuenow'), '50');
      handle.destroy();
    });
  });

  it('loads a previously stored ratio from localStorage', () => {
    withFreshStorage(() => {
      memStore.set('md-editor-split-ratio', '0.35');
      const fx = buildFixture();
      const handle = setupSplitter({
        editorPane: fx.editorPane,
        previewPane: fx.previewPane,
        splitter: fx.splitter,
        container: fx.container,
      });
      assert.equal(handle.getRatio(), 0.35);
      assert.match(fx.editorPane.style.flex, /^0 0 35(\.\d+)?%/);
      handle.destroy();
    });
  });

  it('clamps out-of-range stored values to the min/max bounds', () => {
    withFreshStorage(() => {
      memStore.set('md-editor-split-ratio', '0.05'); // below MIN 0.2
      const fx = buildFixture();
      const handle = setupSplitter({
        editorPane: fx.editorPane,
        previewPane: fx.previewPane,
        splitter: fx.splitter,
        container: fx.container,
      });
      assert.equal(handle.getRatio(), 0.2);
      handle.destroy();
    });
  });

  it('ignores garbage stored values and falls back to 0.5', () => {
    withFreshStorage(() => {
      memStore.set('md-editor-split-ratio', 'not-a-number');
      const fx = buildFixture();
      const handle = setupSplitter({
        editorPane: fx.editorPane,
        previewPane: fx.previewPane,
        splitter: fx.splitter,
        container: fx.container,
      });
      assert.equal(handle.getRatio(), 0.5);
      handle.destroy();
    });
  });

  it('drags: mousedown → mousemove → mouseup updates the ratio', () => {
    withFreshStorage(() => {
      const fx = buildFixture();
      const handle = setupSplitter({
        editorPane: fx.editorPane,
        previewPane: fx.previewPane,
        splitter: fx.splitter,
        container: fx.container,
      });

      // Container is 1000px wide; mousedown anywhere on the splitter starts
      // the drag. Moving the mouse to clientX=300 (i.e. 30% of the way
      // across the container) should set the ratio to 0.3.
      fx.splitter.dispatchEvent(mouseEvent('mousedown', { clientX: 500 }));
      // mousemove is bound on document, not splitter.
      document.dispatchEvent(mouseEvent('mousemove', { clientX: 300 }));
      document.dispatchEvent(mouseEvent('mouseup', { clientX: 300 }));

      assert.equal(handle.getRatio(), 0.3);
      assert.match(fx.editorPane.style.flex, /^0 0 30(\.\d+)?%/);
      // Persistence happens on mouseup.
      assert.equal(memStore.get('md-editor-split-ratio'), '0.3000');
      handle.destroy();
    });
  });

  it('clamps the drag to MAX (0.8) when the mouse is dragged past the right edge', () => {
    withFreshStorage(() => {
      const fx = buildFixture();
      const handle = setupSplitter({
        editorPane: fx.editorPane,
        previewPane: fx.previewPane,
        splitter: fx.splitter,
        container: fx.container,
      });
      fx.splitter.dispatchEvent(mouseEvent('mousedown', { clientX: 500 }));
      document.dispatchEvent(mouseEvent('mousemove', { clientX: 1200 })); // > 100% of 1000
      document.dispatchEvent(mouseEvent('mouseup', { clientX: 1200 }));
      assert.equal(handle.getRatio(), 0.8);
      handle.destroy();
    });
  });

  it('clamps the drag to MIN (0.2) when the mouse is dragged past the left edge', () => {
    withFreshStorage(() => {
      const fx = buildFixture();
      const handle = setupSplitter({
        editorPane: fx.editorPane,
        previewPane: fx.previewPane,
        splitter: fx.splitter,
        container: fx.container,
      });
      fx.splitter.dispatchEvent(mouseEvent('mousedown', { clientX: 500 }));
      document.dispatchEvent(mouseEvent('mousemove', { clientX: -200 })); // negative
      document.dispatchEvent(mouseEvent('mouseup', { clientX: -200 }));
      assert.equal(handle.getRatio(), 0.2);
      handle.destroy();
    });
  });

  it('ignores right- and middle-button mousedown (drag must use left button)', () => {
    withFreshStorage(() => {
      const fx = buildFixture();
      const handle = setupSplitter({
        editorPane: fx.editorPane,
        previewPane: fx.previewPane,
        splitter: fx.splitter,
        container: fx.container,
      });
      // Right-click: should not start a drag.
      fx.splitter.dispatchEvent(mouseEvent('mousedown', { clientX: 500, button: 2 }));
      document.dispatchEvent(mouseEvent('mousemove', { clientX: 700 }));
      document.dispatchEvent(mouseEvent('mouseup', { clientX: 700 }));
      assert.equal(handle.getRatio(), 0.5, 'right-click should not change ratio');
      handle.destroy();
    });
  });

  it('double-click resets the ratio to 50:50 and persists', () => {
    withFreshStorage(() => {
      memStore.set('md-editor-split-ratio', '0.7');
      const fx = buildFixture();
      const handle = setupSplitter({
        editorPane: fx.editorPane,
        previewPane: fx.previewPane,
        splitter: fx.splitter,
        container: fx.container,
      });
      assert.equal(handle.getRatio(), 0.7);
      fx.splitter.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      assert.equal(handle.getRatio(), 0.5);
      assert.equal(memStore.get('md-editor-split-ratio'), '0.5000');
      handle.destroy();
    });
  });

  it('setRatio() updates DOM and persists', () => {
    withFreshStorage(() => {
      const fx = buildFixture();
      const handle = setupSplitter({
        editorPane: fx.editorPane,
        previewPane: fx.previewPane,
        splitter: fx.splitter,
        container: fx.container,
      });
      handle.setRatio(0.4);
      assert.equal(handle.getRatio(), 0.4);
      assert.match(fx.editorPane.style.flex, /^0 0 40(\.\d+)?%/);
      assert.equal(memStore.get('md-editor-split-ratio'), '0.4000');
      handle.destroy();
    });
  });

  it('reset() goes back to 50:50', () => {
    withFreshStorage(() => {
      const fx = buildFixture();
      const handle = setupSplitter({
        editorPane: fx.editorPane,
        previewPane: fx.previewPane,
        splitter: fx.splitter,
        container: fx.container,
      });
      handle.setRatio(0.7);
      handle.reset();
      assert.equal(handle.getRatio(), 0.5);
      handle.destroy();
    });
  });

  it('keyboard ArrowLeft / ArrowRight nudge by 2%', () => {
    withFreshStorage(() => {
      const fx = buildFixture();
      const handle = setupSplitter({
        editorPane: fx.editorPane,
        previewPane: fx.previewPane,
        splitter: fx.splitter,
        container: fx.container,
      });
      // Default 0.5; press ArrowRight twice → 0.54.
      fx.splitter.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
      );
      fx.splitter.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
      );
      assert.equal(handle.getRatio(), 0.54);
      fx.splitter.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })
      );
      assert.equal(handle.getRatio(), 0.52);
      handle.destroy();
    });
  });

  it('keyboard Home / End jump to min / max', () => {
    withFreshStorage(() => {
      const fx = buildFixture();
      const handle = setupSplitter({
        editorPane: fx.editorPane,
        previewPane: fx.previewPane,
        splitter: fx.splitter,
        container: fx.container,
      });
      fx.splitter.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })
      );
      assert.equal(handle.getRatio(), 0.2);
      fx.splitter.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })
      );
      assert.equal(handle.getRatio(), 0.8);
      handle.destroy();
    });
  });

  it('destroy() removes all listeners (further drags do nothing)', () => {
    withFreshStorage(() => {
      const fx = buildFixture();
      const handle = setupSplitter({
        editorPane: fx.editorPane,
        previewPane: fx.previewPane,
        splitter: fx.splitter,
        container: fx.container,
      });
      handle.destroy();
      // After destroy, dragging the splitter must not change anything.
      fx.splitter.dispatchEvent(mouseEvent('mousedown', { clientX: 500 }));
      document.dispatchEvent(mouseEvent('mousemove', { clientX: 800 }));
      document.dispatchEvent(mouseEvent('mouseup', { clientX: 800 }));
      assert.equal(handle.getRatio(), 0.5);
    });
  });

  it('sets a11y attributes on the splitter element', () => {
    withFreshStorage(() => {
      const fx = buildFixture();
      const handle = setupSplitter({
        editorPane: fx.editorPane,
        previewPane: fx.previewPane,
        splitter: fx.splitter,
        container: fx.container,
      });
      assert.equal(fx.splitter.getAttribute('role'), 'separator');
      assert.equal(fx.splitter.getAttribute('aria-orientation'), 'vertical');
      assert.equal(fx.splitter.getAttribute('aria-valuemin'), '20');
      assert.equal(fx.splitter.getAttribute('aria-valuemax'), '80');
      assert.equal(fx.splitter.getAttribute('tabindex'), '0');
      handle.destroy();
    });
  });
});
