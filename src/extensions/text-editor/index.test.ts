import globalJsdom from 'global-jsdom';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { join } from 'path';
import { EditorView } from '@codemirror/view';
import { SearchQuery, setSearchQuery } from '@codemirror/search';
import type { HostMessage } from '../../shared/extension-types';
import type {} from '../shared/whale-ext';

type PostedMessage = {
  type: string;
  path?: string;
  content?: string;
  dirty?: boolean;
  revision?: number;
};

const require_ = createRequire(__filename);
const listeners = new Set<(msg: HostMessage) => void>();
const posted: PostedMessage[] = [];
let jsdomCleanup: (() => void) | null = null;

function emitHost(msg: HostMessage): void {
  listeners.forEach((listener) => listener(msg));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function contentChangedMessages(): PostedMessage[] {
  return posted.filter((msg) => msg.type === 'contentChangedInEditor');
}

describe('text-editor revision-aware saves', () => {
  before(() => {
    jsdomCleanup = globalJsdom() as unknown as () => void;
    const html = readFileSync(join(__dirname, 'index.html'), 'utf8');
    document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? '';
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: () => {},
    });
    Object.defineProperty(window, 'whaleExt', {
      configurable: true,
      value: {
        locale: 'en',
        t: (catalog: { en: unknown }) => catalog.en,
        postMessage(msg: PostedMessage) {
          posted.push(msg);
        },
        onMessage(listener: (msg: HostMessage) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        onLocale() {
          return () => {};
        },
      },
    });
    require_('./index');
  });

  after(() => {
    const container = document.getElementById('editor');
    if (container) EditorView.findFromDOM(container)?.destroy();
    listeners.clear();
    jsdomCleanup?.();
  });

  it('preserves pending edits and editor content across stale acks/read-only refreshes', () => {
    const path = '/tmp/revision.txt';
    emitHost({
      type: 'fileContent',
      path,
      content: 'disk',
      encoding: 'utf8',
      readOnly: false,
    });

    const container = document.getElementById('editor');
    assert.ok(container);
    const editor = EditorView.findFromDOM(container);
    assert.ok(editor);
    assert.equal(editor.state.doc.toString(), 'disk');
    // Loading a clean file must not report dirty: reports are edge-triggered.
    assert.deepEqual(contentChangedMessages(), []);

    editor.dispatch({ changes: { from: 4, insert: ' one' } });
    assert.deepEqual(contentChangedMessages().at(-1), {
      type: 'contentChangedInEditor',
      path,
      dirty: true,
      revision: 1,
    });
    emitHost({ type: 'requestSave', path });
    assert.deepEqual(posted.at(-1), {
      type: 'parentSaveDocument',
      path,
      content: 'disk one',
      revision: 1,
    });

    // While the save is in flight the host needs the newest revision even
    // though the dirty flag does not change (stale-ack guard).
    editor.dispatch({ changes: { from: 8, insert: ' two' } });
    assert.deepEqual(contentChangedMessages().at(-1), {
      type: 'contentChangedInEditor',
      path,
      dirty: true,
      revision: 2,
    });
    emitHost({ type: 'savingFile', path, revision: 1 });
    assert.equal(posted.at(-1)?.dirty, true, 'stale ack must not clear revision 2');

    const postedBeforeRefresh = posted.length;
    emitHost({
      type: 'fileContent',
      path,
      content: 'old disk snapshot',
      encoding: 'utf8',
      readOnly: true,
    });
    assert.equal(editor.state.doc.toString(), 'disk one two');
    assert.equal(editor.state.readOnly, true);
    assert.equal(editor.state.facet(EditorView.editable), false);
    assert.equal(posted.length, postedBeforeRefresh, 'read-only reconfigure is not an edit');

    emitHost({ type: 'requestSave', path });
    assert.equal(
      posted.filter((msg) => msg.type === 'parentSaveDocument').length,
      1,
      'read-only editor does not issue saves'
    );

    emitHost({ type: 'savingFile', path, revision: 2 });
    assert.deepEqual(posted.at(-1), {
      type: 'contentChangedInEditor',
      path,
      dirty: false,
      revision: 2,
    });
  });

  it('posts dirty only on transitions and debounces the match count', async () => {
    emitHost({
      type: 'fileContent',
      path: '/tmp/matches.txt',
      content: 'aaa',
      encoding: 'utf8',
      readOnly: false,
    });

    const container = document.getElementById('editor');
    assert.ok(container);
    const editor = EditorView.findFromDOM(container);
    assert.ok(editor);
    assert.equal(editor.state.doc.toString(), 'aaa');

    // First edit: false -> true edge, exactly one report.
    const before = contentChangedMessages().length;
    editor.dispatch({ changes: { from: 3, insert: 'b' } });
    assert.equal(contentChangedMessages().length, before + 1);
    assert.equal(contentChangedMessages().at(-1)?.dirty, true);

    // Two more keystrokes on an already-dirty buffer: no extra messages (the
    // old code posted dirty:true on every keystroke and re-rendered the host).
    editor.dispatch({ changes: { from: 4, insert: 'c' } });
    editor.dispatch({ changes: { from: 5, insert: 'd' } });
    assert.equal(
      contentChangedMessages().length,
      before + 1,
      'same-dirty keystrokes must not post'
    );

    // Match count is debounced instead of stringifying the doc per keystroke.
    const matchesEl = document.getElementById('status-matches');
    assert.ok(matchesEl);
    editor.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'a' })) });
    editor.dispatch({ selection: { anchor: 1 } });
    assert.equal(matchesEl.textContent, '—', 'count is not recomputed synchronously');
    await sleep(260);
    assert.equal(matchesEl.textContent, '3');

    editor.dispatch({ changes: { from: editor.state.doc.length, insert: 'a' } });
    assert.equal(matchesEl.textContent, '3', 'a keystroke must not recount immediately');
    await sleep(260);
    assert.equal(matchesEl.textContent, '4');
  });
});
