import globalJsdom from 'global-jsdom';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { join } from 'path';
import { EditorView } from '@codemirror/view';
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
    assert.deepEqual(posted.at(-1), {
      type: 'contentChangedInEditor',
      path,
      dirty: false,
      revision: 0,
    });

    editor.dispatch({ changes: { from: 4, insert: ' one' } });
    assert.equal(posted.at(-1)?.revision, 1);
    assert.equal(posted.at(-1)?.dirty, true);
    emitHost({ type: 'requestSave', path });
    assert.deepEqual(posted.at(-1), {
      type: 'parentSaveDocument',
      path,
      content: 'disk one',
      revision: 1,
    });

    editor.dispatch({ changes: { from: 8, insert: ' two' } });
    assert.equal(posted.at(-1)?.revision, 2);
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
});
