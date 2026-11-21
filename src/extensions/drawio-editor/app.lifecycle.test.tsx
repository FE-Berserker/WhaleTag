import globalJsdom from 'global-jsdom';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, cleanup, render } from '@testing-library/react';
import type { HostMessage } from '../../shared/extension-types';
import type {} from '../shared/whale-ext';
import App from './app';

type HostListener = (msg: HostMessage) => void;
type PostedMessage = {
  type: string;
  path?: string;
  content?: string;
  dirty?: boolean;
  revision?: number;
};

describe('drawio App in-flight lifecycle', () => {
  let jsdomCleanup: (() => void) | null = null;

  before(() => {
    jsdomCleanup = globalJsdom() as unknown as () => void;
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
  });

  after(() => {
    jsdomCleanup?.();
  });

  function setup() {
    const listeners = new Set<HostListener>();
    const posted: PostedMessage[] = [];
    Object.defineProperty(window, 'whaleExt', {
      configurable: true,
      value: {
        locale: 'en',
        postMessage(msg: PostedMessage) {
          posted.push(msg);
        },
        onMessage(listener: HostListener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    });

    const view = render(<App />);
    const iframe = document.querySelector('iframe');
    assert.ok(iframe, 'drawio iframe should render');
    const drawioActions: Record<string, unknown>[] = [];
    Object.defineProperty(iframe.contentWindow, 'postMessage', {
      configurable: true,
      value: (data: string) => {
        drawioActions.push(JSON.parse(data) as Record<string, unknown>);
      },
    });

    const emitHost = (msg: HostMessage) => {
      act(() => {
        listeners.forEach((listener) => listener(msg));
      });
    };
    const emitDrawio = (data: Record<string, unknown>) => {
      window.dispatchEvent(new window.MessageEvent('message', {
        source: iframe.contentWindow,
        data: JSON.stringify(data),
      }));
    };
    const loadFile = (content = '<mxfile></mxfile>') => {
      emitHost({
        type: 'fileContent',
        path: '/tmp/lifecycle.drawio',
        content,
        readOnly: false,
      } as HostMessage);
    };

    loadFile();
    act(() => emitDrawio({ event: 'init' }));
    return { view, iframe, posted, drawioActions, emitHost, emitDrawio, loadFile };
  }

  it('keeps edits made while a save is pending dirty until their own ack', async () => {
    const { posted, drawioActions, emitHost, emitDrawio } = setup();

    act(() => emitDrawio({ event: 'autosave', xml: '<mxfile>one</mxfile>' }));
    assert.equal(posted.at(-1)?.dirty, true);
    assert.equal(posted.at(-1)?.revision, 1);

    emitHost({ type: 'requestSave', path: '/tmp/lifecycle.drawio' } as HostMessage);
    const postedBeforeExport = posted.length;
    await act(async () => {
      emitDrawio({ event: 'export', xml: '<mxfile>one</mxfile>' });
      await Promise.resolve();
    });
    const save = posted.find((msg) => msg.type === 'parentSaveDocument');
    assert.equal(save?.revision, 1);
    assert.equal(posted.length, postedBeforeExport + 1, 'export itself is not dirty');

    act(() => emitDrawio({ event: 'autosave', xml: '<mxfile>two</mxfile>' }));
    assert.equal(posted.at(-1)?.revision, 2);
    emitHost({
      type: 'savingFile',
      path: '/tmp/lifecycle.drawio',
      revision: 1,
    } as HostMessage);
    assert.equal(posted.at(-1)?.dirty, true, 'stale ack must not clear revision 2');
    assert.equal(
      drawioActions.filter((msg) => msg.action === 'modified').length,
      0
    );

    emitHost({
      type: 'savingFile',
      path: '/tmp/lifecycle.drawio',
      revision: 2,
    } as HostMessage);
    assert.equal(posted.at(-1)?.dirty, false);
    assert.equal(posted.at(-1)?.revision, 2);
    assert.deepEqual(
      drawioActions.filter((msg) => msg.action === 'modified').at(-1),
      { action: 'modified', modified: false }
    );
  });

  it('does not let an autosave answer a pending export or acknowledge newer edits', async () => {
    const { posted, drawioActions, emitHost, emitDrawio } = setup();
    act(() => emitDrawio({ event: 'autosave', xml: '<mxfile>one</mxfile>' }));
    emitHost({ type: 'requestSave', path: '/tmp/lifecycle.drawio' } as HostMessage);
    assert.equal(drawioActions.filter((msg) => msg.action === 'export').length, 1);

    await act(async () => {
      emitDrawio({ event: 'autosave', xml: '<mxfile>two</mxfile>' });
      await Promise.resolve();
    });
    assert.equal(
      posted.filter((msg) => msg.type === 'parentSaveDocument').length,
      0,
      'autosave is an edit notification, not the pending export response'
    );
    assert.equal(posted.at(-1)?.revision, 2);

    await act(async () => {
      emitDrawio({ event: 'export', xml: '<mxfile>one</mxfile>' });
      await Promise.resolve();
    });
    const save = posted.find((msg) => msg.type === 'parentSaveDocument');
    assert.equal(save?.revision, 1, 'revision is captured before awaiting export');

    emitHost({
      type: 'savingFile',
      path: '/tmp/lifecycle.drawio',
      revision: 1,
    } as HostMessage);
    const lastDirty = posted.filter((msg) => msg.type === 'contentChangedInEditor').at(-1);
    assert.equal(lastDirty?.dirty, true);
    assert.equal(lastDirty?.revision, 2);
  });

  it('blocks drawio interaction without reloading the iframe in read-only mode', async () => {
    const { view, iframe, posted, drawioActions, emitHost, emitDrawio } = setup();
    const initialSrc = iframe.getAttribute('src');
    const initialPosted = posted.length;

    emitHost({ type: 'setReadOnly', readOnly: true } as HostMessage);
    assert.equal(iframe.inert, true);
    assert.equal(iframe.hasAttribute('inert'), true);
    assert.equal(iframe.getAttribute('src'), initialSrc);
    assert.ok(view.getByTestId('drawio-readonly-guard'));

    const actionCount = drawioActions.length;
    act(() => emitDrawio({ event: 'autosave', xml: '<mxfile>blocked</mxfile>' }));
    emitHost({
      type: 'externalDrag',
      active: true,
      path: '/tmp/blocked.png',
      name: 'blocked.png',
      isImage: true,
    });
    emitHost({
      type: 'fileEmbed',
      path: '/tmp/blocked.png',
      name: 'blocked.png',
      thumbnailDataUrl: 'data:image/png;base64,AA==',
    });
    await act(async () => Promise.resolve());

    assert.equal(posted.length, initialPosted, 'read-only input cannot create dirty state');
    assert.equal(drawioActions.length, actionCount, 'read-only embed is ignored');
  });

  it('finishes an in-flight save when file props refresh before XML arrives', async () => {
    const { posted, emitHost, emitDrawio, loadFile } = setup();
    emitHost({ type: 'requestSave', path: '/tmp/lifecycle.drawio' } as HostMessage);

    // The host may resend fileContent while Ctrl+S is awaiting drawio. That
    // replaces file/save identities and reruns the effect, but is not unmount.
    loadFile('<mxfile><diagram>refresh</diagram></mxfile>');
    await act(async () => {
      emitDrawio({ event: 'export', xml: '<mxfile></mxfile>' });
      await Promise.resolve();
    });

    const saves = posted.filter((msg) => msg.type === 'parentSaveDocument');
    assert.equal(saves.length, 1);
    assert.equal(saves[0].path, '/tmp/lifecycle.drawio');
    assert.equal(saves[0].content, '<mxfile/>');
  });

  it('finishes an image embed when file props refresh during dimension decoding', async () => {
    const originalImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
    const images: Array<{
      onload: (() => void) | null;
      onerror: (() => void) | null;
      naturalWidth: number;
      naturalHeight: number;
      src: string;
    }> = [];
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 800;
      naturalHeight = 600;
      private _src = '';
      set src(value: string) {
        this._src = value;
        images.push(this);
      }
      get src() {
        return this._src;
      }
    }
    Object.defineProperty(globalThis, 'Image', { configurable: true, value: FakeImage });

    try {
      const { drawioActions, emitHost, emitDrawio, loadFile } = setup();
      const initialLoads = drawioActions.filter((msg) => msg.action === 'load').length;
      emitHost({
        type: 'externalDrag',
        active: true,
        path: '/tmp/picture.png',
        name: 'picture.png',
        isImage: true,
      });
      emitHost({
        type: 'fileEmbed',
        path: '/tmp/picture.png',
        name: 'picture.png',
        thumbnailDataUrl: 'data:image/png;base64,AA==',
      });
      assert.equal(images.length, 1);

      loadFile('<mxfile><diagram>refresh</diagram></mxfile>');
      await act(async () => {
        images[0].onload?.();
        await Promise.resolve();
      });
      await act(async () => {
        emitDrawio({
          event: 'export',
          xml: '<mxfile><diagram id="page" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>',
        });
        await Promise.resolve();
      });

      const loads = drawioActions.filter((msg) => msg.action === 'load');
      assert.equal(loads.length, initialLoads + 1);
      assert.match(String(loads.at(-1)?.xml), /picture\.png/);
    } finally {
      if (originalImage) Object.defineProperty(globalThis, 'Image', originalImage);
    }
  });

  it('aborts the image embed instead of loading a replacement document', async () => {
    const originalImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
    const originalAlert = Object.getOwnPropertyDescriptor(window, 'alert');
    const images: Array<{
      onload: (() => void) | null;
      onerror: (() => void) | null;
      naturalWidth: number;
      naturalHeight: number;
      src: string;
    }> = [];
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 800;
      naturalHeight = 600;
      private _src = '';
      set src(value: string) {
        this._src = value;
        images.push(this);
      }
      get src() {
        return this._src;
      }
    }
    Object.defineProperty(globalThis, 'Image', { configurable: true, value: FakeImage });
    const alerts: string[] = [];
    Object.defineProperty(window, 'alert', {
      configurable: true,
      value: (message: string) => alerts.push(message),
    });

    try {
      const { drawioActions, emitHost, emitDrawio, loadFile } = setup();
      const initialLoads = drawioActions.filter(
        (msg) => msg.action === 'load'
      ).length;
      emitHost({
        type: 'externalDrag',
        active: true,
        path: '/tmp/picture.png',
        name: 'picture.png',
        isImage: true,
      });
      emitHost({
        type: 'fileEmbed',
        path: '/tmp/picture.png',
        name: 'picture.png',
        thumbnailDataUrl: 'data:image/png;base64,AA==',
      });
      assert.equal(images.length, 1);

      loadFile('<mxfile><diagram>refresh</diagram></mxfile>');
      await act(async () => {
        images[0].onload?.();
        await Promise.resolve();
      });
      // The editor answers the export with something that is not a drawio
      // document, so the read/modify/load round-trip cannot run.
      await act(async () => {
        emitDrawio({ event: 'export', xml: '<not-a-diagram/>' });
        // The abort travels through the bridge's async round-trip; give the
        // rejection one macrotask to reach the caller's catch.
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      const loads = drawioActions.filter((msg) => msg.action === 'load');
      assert.equal(
        loads.length,
        initialLoads,
        'an unreadable diagram must not be replaced'
      );
      assert.equal(alerts.length, 1, 'the user is told the insert was cancelled');
    } finally {
      if (originalImage) Object.defineProperty(globalThis, 'Image', originalImage);
      if (originalAlert) {
        Object.defineProperty(window, 'alert', originalAlert);
      }
    }
  });

  it('does not insert a pending image into a different document after a file switch', async () => {
    const originalImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
    const images: Array<{
      onload: (() => void) | null;
      onerror: (() => void) | null;
      naturalWidth: number;
      naturalHeight: number;
      src: string;
    }> = [];
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 800;
      naturalHeight = 600;
      private _src = '';
      set src(value: string) {
        this._src = value;
        images.push(this);
      }
      get src() {
        return this._src;
      }
    }
    Object.defineProperty(globalThis, 'Image', { configurable: true, value: FakeImage });

    try {
      const { drawioActions, emitHost } = setup();
      emitHost({
        type: 'externalDrag',
        active: true,
        path: '/tmp/picture.png',
        name: 'picture.png',
        isImage: true,
      });
      emitHost({
        type: 'fileEmbed',
        path: '/tmp/picture.png',
        name: 'picture.png',
        thumbnailDataUrl: 'data:image/png;base64,AA==',
      });
      assert.equal(images.length, 1);

      emitHost({
        type: 'fileContent',
        path: '/tmp/other.drawio',
        content: '<mxfile><diagram>other</diagram></mxfile>',
        readOnly: false,
      } as HostMessage);
      await act(async () => {
        images[0].onload?.();
        await Promise.resolve();
      });

      assert.equal(drawioActions.filter((msg) => msg.action === 'export').length, 0);
    } finally {
      if (originalImage) Object.defineProperty(globalThis, 'Image', originalImage);
      else Reflect.deleteProperty(globalThis, 'Image');
    }
  });

  it('does not save when export resolves in the same tick as unmount', async () => {
    const { posted, view, emitHost, emitDrawio } = setup();
    emitHost({ type: 'requestSave', path: '/tmp/lifecycle.drawio' } as HostMessage);

    // Resolve the bridge request, then unmount before its promise continuation
    // runs. Without the post-await mounted guard this emits a late save.
    emitDrawio({ event: 'export', xml: '<mxfile></mxfile>' });
    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });

    assert.equal(posted.filter((msg) => msg.type === 'parentSaveDocument').length, 0);
    assert.equal(posted.filter((msg) => msg.type === 'error').length, 0);
  });

  it('does not report a pending XML rejection after a real unmount', async () => {
    const { posted, view, emitHost } = setup();
    emitHost({ type: 'requestSave', path: '/tmp/lifecycle.drawio' } as HostMessage);

    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });

    assert.equal(posted.filter((msg) => msg.type === 'parentSaveDocument').length, 0);
    assert.equal(posted.filter((msg) => msg.type === 'error').length, 0);
  });
});
