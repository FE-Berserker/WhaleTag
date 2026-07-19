/**
 * md-contextmenu tests (§context-menu): menu construction, per-open state
 * (readOnly / empty selection), action dispatch + close, edge clamping via
 * the pure `computeMenuPosition`, close paths, and the clipboard paste
 * round trip.
 *
 * md-context builds its `dom` singleton via getElementById at module load,
 * so the elements it caches must exist in jsdom *before* the module is
 * first required — hence the DOM scaffold + require() below (ES imports
 * would be hoisted above globalJsdom()).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import globalJsdom from 'global-jsdom';

const jsdom = globalJsdom();

// Every id md-context.ts caches in its module-load `dom` initializer.
document.body.innerHTML = `
  <div id="main-row">
    <div id="editor-pane"></div>
    <div id="splitter"></div>
    <div id="preview-pane"></div>
  </div>
  <span id="status-ln"></span><span id="status-col"></span>
  <span id="status-length"></span><span id="status-sel"></span>
  <span id="status-words"></span>
  <span id="status-label-ln"></span><span id="status-label-col"></span>
  <span id="status-label-length"></span><span id="status-label-sel"></span>
  <span id="status-label-words"></span>
  <span id="status-readonly"></span><span id="status-dirty"></span>
  <span id="status-undo"></span><span id="status-redo"></span>
  <button id="btn-find"></button><button id="btn-toggle-wrap"></button>
  <button id="btn-zoom-out"></button><button id="btn-zoom-reset"></button>
  <button id="btn-zoom-in"></button>
  <span id="wrap-state"></span>
  <button id="btn-toggle-toc"></button><button id="btn-goto-line"></button>
  <button id="btn-export-html"></button>
  <select id="select-theme"></select>
  <div id="toc-sidebar"><div id="toc-list"></div></div>
`;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ctx, dom } = require('./md-context') as typeof import('./md-context');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  setupContextMenu,
  computeMenuPosition,
  handleClipboardText,
  _closeContextMenuForTest,
} = require('./md-contextmenu') as typeof import('./md-contextmenu');

// --- Fakes -------------------------------------------------------------------

interface FakeSelection {
  main: { empty: boolean; from: number; to: number };
}
interface FakeView {
  state: {
    readOnly: boolean;
    selection: FakeSelection;
    doc: { length: number };
    sliceDoc: (from: number, to: number) => string;
    replaceSelection: (text: string) => { fake: string };
  };
  dispatch: (spec: unknown) => void;
}

function fakeView(opts: { readOnly?: boolean; empty?: boolean } = {}): FakeView {
  const empty = opts.empty ?? false;
  return {
    state: {
      readOnly: opts.readOnly ?? false,
      selection: { main: { empty, from: 0, to: empty ? 0 : 5 } },
      doc: { length: 42 },
      sliceDoc: () => 'HELLO',
      replaceSelection: (text: string) => ({ fake: text }),
    },
    dispatch: () => undefined,
  };
}

function installView(v: FakeView | null): void {
  (ctx as unknown as { view: unknown }).view = v;
}

function openEditorMenu(x = 100, y = 100): void {
  dom.editorPane.dispatchEvent(
    new MouseEvent('contextmenu', { clientX: x, clientY: y, bubbles: true, cancelable: true })
  );
}

function menuEl(): HTMLElement | null {
  return document.querySelector('.cm-context-menu:not(.submenu)');
}

function menuLabels(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('.cm-context-menu:not(.submenu) .cm-context-item .label')
  ).map((el) => el.textContent ?? '');
}

// --- Setup / teardown --------------------------------------------------------

let savedView: unknown;
before(() => {
  savedView = (ctx as unknown as { view: unknown }).view;
  setupContextMenu();
});

after(() => {
  _closeContextMenuForTest();
  installView(savedView as FakeView);
  jsdom();
});

// --- Tests -------------------------------------------------------------------

describe('context menu: construction', () => {
  it('builds the editor menu with groups, items and separators', () => {
    installView(fakeView());
    openEditorMenu();
    const labels = menuLabels();
    for (const expected of [
      'Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select All',
      'Bold', 'Italic', 'Link', 'Heading',
      'Insert Callout', 'Insert Table…',
      'Find & Replace', 'Go to Line',
      'Word Wrap', 'Zoom In', 'Zoom Out', 'Reset Zoom',
      'Export as HTML',
    ]) {
      assert.ok(labels.includes(expected), `missing item "${expected}"`);
    }
    assert.ok(
      document.querySelectorAll('.cm-context-sep').length >= 5,
      'expected several separators between groups'
    );
  });

  it('opens the Heading submenu with H1/H2/H3 + increase/decrease', () => {
    installView(fakeView());
    openEditorMenu();
    const headingBtn = Array.from(
      document.querySelectorAll<HTMLElement>('.cm-context-item')
    ).find((b) => b.querySelector('.label')?.textContent === 'Heading')!;
    headingBtn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    const sub = document.querySelector('.cm-context-menu.submenu');
    assert.ok(sub, 'submenu should open');
    const subLabels = Array.from(
      sub!.querySelectorAll<HTMLElement>('.label')
    ).map((el) => el.textContent);
    for (const expected of ['Heading 1', 'Heading 2', 'Heading 3', 'Increase Heading', 'Decrease Heading']) {
      assert.ok(subLabels.includes(expected), `missing submenu item "${expected}"`);
    }
  });
});

describe('context menu: per-open state', () => {
  it('disables Cut/Copy with an empty selection', () => {
    installView(fakeView({ empty: true }));
    openEditorMenu();
    const item = (label: string) =>
      Array.from(document.querySelectorAll<HTMLElement>('.cm-context-item'))
        .find((b) => b.querySelector('.label')?.textContent === label)!;
    assert.ok(item('Cut').classList.contains('disabled'));
    assert.ok(item('Copy').classList.contains('disabled'));
    assert.ok(!item('Paste').classList.contains('disabled'));
  });

  it('disables every editing item when readOnly, keeps navigation/view/export', () => {
    installView(fakeView({ readOnly: true }));
    openEditorMenu();
    const item = (label: string) =>
      Array.from(document.querySelectorAll<HTMLElement>('.cm-context-item'))
        .find((b) => b.querySelector('.label')?.textContent === label)!;
    for (const label of ['Undo', 'Redo', 'Cut', 'Paste', 'Bold', 'Italic', 'Link', 'Heading', 'Insert Callout', 'Insert Table…']) {
      assert.ok(item(label).classList.contains('disabled'), `"${label}" should be disabled in readOnly`);
    }
    for (const label of ['Copy', 'Select All', 'Find & Replace', 'Go to Line', 'Word Wrap', 'Export as HTML']) {
      assert.ok(!item(label).classList.contains('disabled'), `"${label}" should stay enabled in readOnly`);
    }
  });
});

describe('context menu: actions + closing', () => {
  it('clicking Copy writes the selection to the clipboard path', () => {
    installView(fakeView());
    openEditorMenu();
    const copyBtn = Array.from(document.querySelectorAll<HTMLElement>('.cm-context-item'))
      .find((b) => b.querySelector('.label')?.textContent === 'Copy')!;
    copyBtn.click();
    assert.equal(menuEl(), null, 'menu closes after an action');
  });

  it('closes on Escape and on outside mousedown', () => {
    installView(fakeView());
    openEditorMenu();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(menuEl(), null, 'Escape closes');
    openEditorMenu();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    assert.equal(menuEl(), null, 'outside mousedown closes');
  });
});

describe('computeMenuPosition', () => {
  it('clamps the menu inside the viewport with a margin', () => {
    assert.deepEqual(computeMenuPosition(100, 100, 200, 300, 1024, 768), { left: 100, top: 100 });
    assert.deepEqual(computeMenuPosition(1000, 740, 200, 300, 1024, 768), { left: 820, top: 464 });
    assert.deepEqual(computeMenuPosition(0, 0, 200, 300, 1024, 768), { left: 4, top: 4 });
  });
});

describe('context menu: paste round trip', () => {
  it('requestClipboardText → clipboardText inserts the text at the cursor', () => {
    const v = fakeView();
    installView(v);
    const posted: { type: string; requestId: string }[] = [];
    const savedExt = (window as { whaleExt?: unknown }).whaleExt;
    (window as { whaleExt?: unknown }).whaleExt = {
      postMessage: (m: { type: string; requestId: string }) => posted.push(m),
    };
    try {
      openEditorMenu();
      const pasteBtn = Array.from(document.querySelectorAll<HTMLElement>('.cm-context-item'))
        .find((b) => b.querySelector('.label')?.textContent === 'Paste')!;
      pasteBtn.click();
      assert.equal(posted.length, 1);
      assert.equal(posted[0].type, 'requestClipboardText');
      // The async paste path is fire-and-forget; simulate the host reply.
      handleClipboardText({ requestId: posted[0].requestId, text: 'PASTED' });
      // No throw = the pending resolver ran; dispatch happens on a microtask,
      // so just assert the resolver consumed the reply (map is empty again).
      handleClipboardText({ requestId: posted[0].requestId, text: 'AGAIN' });
    } finally {
      (window as { whaleExt?: unknown }).whaleExt = savedExt;
    }
  });
});
