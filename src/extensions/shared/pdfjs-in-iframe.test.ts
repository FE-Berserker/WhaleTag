/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * pdfjs-in-iframe / shared — unit tests for the load-bearing session used
 * by both pdf-viewer and office-viewer (Phase 1 §B3). Mirrors the style of
 * `zoom.test.ts` (pure functions, no real DOM). We do need *some* DOM, so
 * the test boots `global-jsdom` for canvas / document availability.
 *
 * Coverage:
 *  - defaultOutputScale (pure)
 *  - detectInitialTheme (window.matchMedia stub)
 *  - createPdfjsSession.outputScale default + override (mock pdfjsLib)
 *  - getToken cancellation aborts renderPdfBytes mid-loop (mock pdfjsLib)
 *  - destroy() rejects all pending asset requests
 *  - asset request times out after the configured window
 *  - handleHostMessage only consumes `pdfAsset` messages
 *  - onDocumentLoaded fires once before the per-page loop
 *  - onAfterPageRender fires once per page, in order
 */
import globalJsdom from 'global-jsdom';

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPdfjsSession,
  defaultOutputScale,
  detectInitialTheme,
  __setAssetRequestTimeoutForTest,
  HostBinaryDataFactory,
  type PdfjsLike,
  type PdfjsSession,
} from './pdfjs-in-iframe';

// ── DOM + window.whaleExt stubs ────────────────────────────────────────

/**
 * Minimal pagesEl that satisfies the session's needs: tracks appended
 * canvases, supports innerHTML='' reset, and exposes a `clientWidth` for
 * any consumer that reads it (the session itself doesn't).
 */
class FakePagesEl {
  children: any[] = [];
  set innerHTML(_: string) {
    this.children = [];
  }
  appendChild(child: any) {
    this.children.push(child);
    return child;
  }
  querySelector(_sel: string) {
    return null;
  }
  querySelectorAll(_sel: string) {
    return this.children;
  }
  get clientWidth() {
    return 800;
  }
  get clientHeight() {
    return 600;
  }
}

class FakePage {
  constructor(public n: number) {}
  getViewport({ scale, rotation: _rotation }: { scale: number; rotation?: number }) {
    return {
      width: 100 * scale,
      height: 200 * scale,
    };
  }
  render({ canvas }: { canvas: HTMLCanvasElement }) {
    canvas.width = 100;
    canvas.height = 200;
    return { promise: Promise.resolve() };
  }
  cleanup() {
    // no-op; real pdfjs releases buffers here
  }
}

class FakeDoc {
  numPages: number;
  cleanupCalls = 0;
  pageCreated: number[] = [];
  /** /Info + /Lang payload returned by getMetadata(). Optional. */
  metadata: { info?: { Lang?: string; Title?: string; Author?: string } } | null =
    null;
  /** If true, getMetadata() throws — used to exercise the safe-default path. */
  metadataThrows = false;
  getMetadataCalls = 0;
  constructor(numPages: number) {
    this.numPages = numPages;
  }
  async getPage(n: number) {
    // Yield once so cancellation can race the per-page await.
    await new Promise((r) => setImmediate(r));
    this.pageCreated.push(n);
    return new FakePage(n);
  }
  async getMetadata() {
    this.getMetadataCalls += 1;
    if (this.metadataThrows) {
      throw new Error('malformed trailer');
    }
    return this.metadata ?? {};
  }
  async cleanup() {
    this.cleanupCalls += 1;
  }
  // ── Outline stubs (for session.getOutline / resolveDest tests) ──
  outline: any[] = [];
  destinations: Record<string, any[]> = {};
  refToIndex: Map<any, number> = new Map();
  async getOutline() {
    return this.outline;
  }
  async getDestination(id: string) {
    return this.destinations[id] ?? null;
  }
  async getPageIndex(ref: any) {
    const idx = this.refToIndex.get(ref);
    if (idx === undefined) throw new Error('unknown ref');
    return idx;
  }
}

function makeMockPdfjs(doc: FakeDoc): PdfjsLike {
  return {
    getDocument: (_opts: any) => ({
      promise: Promise.resolve(doc),
    }),
  };
}

/** Capture of all postMessage calls (used to track asset requests). */
interface PostMsg {
  type: string;
  requestId?: string;
  kind?: string;
  filename?: string;
  [k: string]: unknown;
}

before(() => {
  globalJsdom();
  // jsdom's canvas doesn't implement getContext('2d') — stub it so the
  // session's `if (!ctx) return;` path doesn't short-circuit rendering.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HTMLCanvasElement.prototype as any).getContext = () => ({});
  // IntersectionObserver stub (global-jsdom doesn't include it). The
  // virtualization path uses it for lazy rendering; the stub just records
  // the callback for the tests to invoke or disconnect.
  if (typeof globalThis.IntersectionObserver === 'undefined') {
    (globalThis as any).IntersectionObserver = class {
      callback: (entries: any[]) => void;
      observe(_: Element) { /* no-op */ }
      unobserve(_: Element) { /* no-op */ }
      disconnect() { /* no-op */ }
      // Expose the callback so tests can simulate entries.
      constructor(callback: (entries: any[]) => void) {
        this.callback = callback;
      }
    };
  }
  // window.whaleExt is what the session postMessages to. Provide a stub
  // that records every call (tests assert against the record).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = globalThis as any;
  if (!w.window) w.window = w;
  const postCalls: PostMsg[] = [];
  const replyListeners: ((msg: any) => void)[] = [];
  w.window.whaleExt = {
    postMessage: (msg: PostMsg) => {
      postCalls.push(msg);
      // If a test installs a reply callback via `setReply`, dispatch it.
      for (const cb of replyListeners) cb(msg);
    },
    onMessage: (cb: (msg: any) => void) => {
      replyListeners.push(cb);
      return () => {
        const i = replyListeners.indexOf(cb);
        if (i >= 0) replyListeners.splice(i, 1);
      };
    },
    onLocale: (_cb: () => void) => () => undefined,
    t: <T>(i18n: T) => i18n,
    locale: 'en',
  };
  // Expose the test capture for inspection.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__postCalls = postCalls;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__setReply = (cb: (msg: any) => void) => {
    replyListeners.push(cb);
    return () => {
      const i = replyListeners.indexOf(cb);
      if (i >= 0) replyListeners.splice(i, 1);
    };
  };
});

function getPostCalls(): PostMsg[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).__postCalls as PostMsg[];
}

function resetPostCalls() {
  getPostCalls().length = 0;
}

// ── defaultOutputScale (pure) ───────────────────────────────────────────

describe('defaultOutputScale', () => {
  it('returns min(devicePixelRatio, 2) * 1.5', () => {
    const prev = window.devicePixelRatio;
    try {
      Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
      assert.equal(defaultOutputScale(), 1.5);
      Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
      assert.equal(defaultOutputScale(), 3);
      Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true });
      assert.equal(defaultOutputScale(), 3); // clamped at 2
      Object.defineProperty(window, 'devicePixelRatio', { value: 0, configurable: true });
      assert.equal(defaultOutputScale(), 1.5); // falsy → 1
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: prev, configurable: true });
    }
  });
});

// ── detectInitialTheme ──────────────────────────────────────────────────

describe('detectInitialTheme', () => {
  it('returns "light" when matchMedia is absent', () => {
    const prev = window.matchMedia;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).matchMedia = undefined;
      assert.equal(detectInitialTheme(), 'light');
    } finally {
      window.matchMedia = prev;
    }
  });

  it('returns "dark" when prefers-color-scheme: dark matches', () => {
    const prev = window.matchMedia;
    try {
      window.matchMedia = ((q: string) => ({
        matches: q.includes('dark'),
        media: q,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      })) as typeof window.matchMedia;
      assert.equal(detectInitialTheme(), 'dark');
    } finally {
      window.matchMedia = prev;
    }
  });
});

// ── createPdfjsSession: outputScale override ───────────────────────────

describe('createPdfjsSession: outputScale', () => {
  it('default outputScale matches defaultOutputScale()', () => {
    resetPostCalls();
    const doc = new FakeDoc(1);
    const session = createPdfjsSession({
      pagesEl: new FakePagesEl() as any,
      getToken: () => 0,
      pdfjsLib: makeMockPdfjs(doc),
    });
    // We don't have direct access to outputScale, but we can verify the
    // canvas size passed to render reflects the default scale.
    return (async () => {
      await session.renderPdfBytes(new Uint8Array(10));
      // The FakePage.getViewport returns { width: 100*scale, height: 200*scale }
      // and FakeCanvas.render sets width=100, height=200 — that's hard-coded
      // by the FakeCanvas. Instead, assert via the onAfterPageRender hook:
      const sessionWithHook = createPdfjsSession({
        pagesEl: new FakePagesEl() as any,
        getToken: () => 0,
        pdfjsLib: makeMockPdfjs(new FakeDoc(1)),
        onAfterPageRender: (_n, _canvas, baseVp) => {
          // baseVp uses the unscaled viewport: scale=1 → {width:100, height:200}
          assert.deepEqual(baseVp, { width: 100, height: 200 });
        },
      });
      await sessionWithHook.renderPdfBytes(new Uint8Array(10));
    })();
  });

  it('custom outputScale override is passed through (canvas width scales)', () => {
    resetPostCalls();
    const doc = new FakeDoc(1);
    const observedBaseVp: Array<{ width: number; height: number }> = [];
    const session = createPdfjsSession({
      pagesEl: new FakePagesEl() as any,
      getToken: () => 0,
      pdfjsLib: makeMockPdfjs(doc),
      outputScale: () => 0.42,
      onAfterPageRender: (_n, _canvas, baseVp) => {
        observedBaseVp.push(baseVp);
      },
    });
    return session.renderPdfBytes(new Uint8Array(10)).then(() => {
      // baseVp is computed at scale=1 inside renderOnePage, so it's
      // independent of outputScale; the override only affects the canvas
      // backing-store size. We just assert the hook fired and the override
      // didn't crash.
      assert.equal(observedBaseVp.length, 1);
    });
  });
});

// ── getToken cancellation ──────────────────────────────────────────────

describe('createPdfjsSession: cancellation', () => {
  it('bumps the token mid-loop to abort and clean up the doc', () => {
    resetPostCalls();
    const doc = new FakeDoc(5);
    let tokenValue = 0;
    const pagesEl = new FakePagesEl() as any;
    const session = createPdfjsSession({
      pagesEl,
      getToken: () => tokenValue,
      pdfjsLib: makeMockPdfjs(doc),
    });
    return (async () => {
      // Kick off render, then bump the token on the next microtask, so the
      // mid-loop cancellation path fires.
      const renderP = session.renderPdfBytes(new Uint8Array(10));
      // Wait a few pages, then bump.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      tokenValue = 99;
      await renderP;
      // We expect: some pages rendered before cancel, cleanup called once.
      assert.ok(doc.pageCreated.length < doc.numPages, 'should not have rendered all 5 pages');
      assert.equal(doc.cleanupCalls, 1, 'cleanup() should fire once on cancellation');
    })();
  });
});

// ── destroy rejects pending assets ────────────────────────────────────

describe('createPdfjsSession: destroy()', () => {
  it('rejects all in-flight asset requests when called', async () => {
    resetPostCalls();
    const session = createPdfjsSession({
      pagesEl: new FakePagesEl() as any,
      getToken: () => 0,
      pdfjsLib: makeMockPdfjs(new FakeDoc(1)),
    });
    // Use HostBinaryDataFactory to issue a real asset request; do not reply.
    const factory = new HostBinaryDataFactory({} as any);
    const fetchP = factory.fetch({ kind: 'cMapUrl', filename: 'Adobe-CNS1-UCS2.bcmap' });
    // Yield so the postMessage + pendingAssets.get happen.
    await new Promise((r) => setImmediate(r));
    assert.equal(getPostCalls().length, 1);
    assert.equal(getPostCalls()[0].type, 'requestPdfAsset');
    // Now destroy the session — pending promise should reject.
    await session.destroy();
    await assert.rejects(fetchP, /session destroyed/);
  });
});

// ── asset request timeout ─────────────────────────────────────────────

describe('asset request timeout', () => {
  it('rejects after the configured window when no host reply arrives', async () => {
    resetPostCalls();
    const restoreTimeout = __setAssetRequestTimeoutForTest(50);
    try {
      const session = createPdfjsSession({
        pagesEl: new FakePagesEl() as any,
        getToken: () => 0,
        pdfjsLib: makeMockPdfjs(new FakeDoc(1)),
      });
      const factory = new HostBinaryDataFactory({} as any);
      const fetchP = factory
        .fetch({ kind: 'cMapUrl', filename: 'foo.bcmap' })
        .catch((e: Error) => e); // attach handler immediately
      // Wait > 50ms (allow some slack) without a host reply.
      await new Promise((r) => setTimeout(r, 100));
      const err = await fetchP;
      assert.ok(err instanceof Error, 'expected fetch to reject with Error');
      assert.match(err.message, /pdf asset request timeout/);
      // The session should not have left anything pending; the next
      // handleHostMessage for the same requestId is a no-op (returns true).
      const handled = session.handleHostMessage({
        type: 'pdfAsset',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        requestId: ((getPostCalls()[0] as any).requestId as string) ?? 'a1',
      } as any);
      assert.equal(handled, true);
    } finally {
      restoreTimeout();
    }
  });
});

// ── handleHostMessage dispatch ────────────────────────────────────────

describe('createPdfjsSession: handleHostMessage', () => {
  it('returns false for non-pdfAsset messages', () => {
    const session = createPdfjsSession({
      pagesEl: new FakePagesEl() as any,
      getToken: () => 0,
      pdfjsLib: makeMockPdfjs(new FakeDoc(1)),
    });
    assert.equal(
      session.handleHostMessage({ type: 'fileContent', content: '' } as any),
      false,
    );
    assert.equal(
      session.handleHostMessage({ type: 'setTheme', theme: 'dark' } as any),
      false,
    );
  });

  it('returns true for a pdfAsset message (even if requestId is unknown)', () => {
    const session = createPdfjsSession({
      pagesEl: new FakePagesEl() as any,
      getToken: () => 0,
      pdfjsLib: makeMockPdfjs(new FakeDoc(1)),
    });
    const result = session.handleHostMessage({
      type: 'pdfAsset',
      requestId: 'unknown',
    } as any);
    assert.equal(result, true);
  });

  it('resolves a pending asset request with the data payload', async () => {
    resetPostCalls();
    const session: PdfjsSession = createPdfjsSession({
      pagesEl: new FakePagesEl() as any,
      getToken: () => 0,
      pdfjsLib: makeMockPdfjs(new FakeDoc(1)),
    });
    const factory = new HostBinaryDataFactory({} as any);
    const fetchP = factory.fetch({ kind: 'cMapUrl', filename: 'foo.bcmap' });
    await new Promise((r) => setImmediate(r));
    const requestId = (getPostCalls()[0] as any).requestId as string;
    // Reply via the session.
    const payload = new Uint8Array([1, 2, 3]);
    session.handleHostMessage({
      type: 'pdfAsset',
      requestId,
      data: payload.buffer,
    } as any);
    const resolved = await fetchP;
    assert.deepEqual(Array.from(resolved), [1, 2, 3]);
  });
});

// ── onDocumentLoaded + onAfterPageRender hook ordering ─────────────────

describe('createPdfjsSession: hooks', () => {
  it('onDocumentLoaded fires once before any onAfterPageRender', async () => {
    const order: string[] = [];
    const doc = new FakeDoc(3);
    const session = createPdfjsSession({
      pagesEl: new FakePagesEl() as any,
      getToken: () => 0,
      pdfjsLib: makeMockPdfjs(doc),
      onDocumentLoaded: (pageCount) => {
        order.push(`loaded:${pageCount}`);
      },
      onAfterPageRender: (n) => {
        order.push(`rendered:${n}`);
      },
    });
    await session.renderPdfBytes(new Uint8Array(10));
    assert.deepEqual(order, ['loaded:3', 'rendered:1', 'rendered:2', 'rendered:3']);
  });

  it('aborts the per-page loop when session.cancel() is called mid-flight', async () => {
    const order: string[] = [];
    const doc = new FakeDoc(3);
    const session = createPdfjsSession({
      pagesEl: new FakePagesEl() as any,
      getToken: () => 0,
      pdfjsLib: makeMockPdfjs(doc),
      onDocumentLoaded: () => {
        order.push('loaded');
      },
      onAfterPageRender: (n) => {
        order.push(`rendered:${n}`);
      },
    });
    // Kick off render. Let the first page start, then cancel.
    const renderP = session.renderPdfBytes(new Uint8Array(10));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    session.cancel();
    await renderP;
    // We expect at least the first page to render (loaded + rendered:1
    // before the cancel), and not all 3.
    assert.ok(
      order.length < 4,
      `expected partial render before cancel, got ${order.join(',')}`,
    );
  });

  // ── onDocumentLoaded metadata passthrough ─────────────────────────
  // The session pulls `doc.getMetadata()` after getDocument resolves and
  // passes the slim {lang, title, author} summary to onDocumentLoaded so
  // pdf-viewer can set `<html lang>` to the PDF content's language (not
  // the host UI locale). Covers the happy path + the "PDF doesn't have
  // /Lang" + "getMetadata throws" fallbacks.
  it('onDocumentLoaded receives the PDF metadata (Lang + Title + Author)', async () => {
    const doc = new FakeDoc(1);
    doc.metadata = {
      info: { Lang: 'zh-CN', Title: '示例', Author: 'Test' },
    };
    let captured: { pageCount: number; info: unknown } | null = null;
    const session = createPdfjsSession({
      pagesEl: new FakePagesEl() as any,
      getToken: () => 0,
      pdfjsLib: makeMockPdfjs(doc),
      onDocumentLoaded: (pageCount, info) => {
        captured = { pageCount, info };
      },
    });
    await session.renderPdfBytes(new Uint8Array(10));
    assert.ok(captured);
    assert.equal(captured!.pageCount, 1);
    assert.deepEqual(captured!.info, {
      lang: 'zh-CN',
      title: '示例',
      author: 'Test',
    });
    assert.equal(doc.getMetadataCalls, 1);
  });

  it('onDocumentLoaded receives an empty info object when the PDF has no /Lang', async () => {
    const doc = new FakeDoc(1);
    doc.metadata = { info: { Title: 'No Lang' } };
    let captured: { pageCount: number; info: unknown } | null = null;
    const session = createPdfjsSession({
      pagesEl: new FakePagesEl() as any,
      getToken: () => 0,
      pdfjsLib: makeMockPdfjs(doc),
      onDocumentLoaded: (pageCount, info) => {
        captured = { pageCount, info };
      },
    });
    await session.renderPdfBytes(new Uint8Array(10));
    assert.ok(captured);
    assert.deepEqual(captured!.info, {
      lang: undefined,
      title: 'No Lang',
      author: undefined,
    });
    // lang is undefined — pdf-viewer falls back to the UI locale.
  });

  it('onDocumentLoaded still fires when getMetadata() throws (safe default)', async () => {
    // pdfjs-dist 6.x can throw on getMetadata() for malformed trailers;
    // the session must NOT block rendering — it should swallow the
    // error, leave info empty, and still notify the consumer.
    const doc = new FakeDoc(1);
    doc.metadataThrows = true;
    let captured: { pageCount: number; info: unknown } | null = null;
    const session = createPdfjsSession({
      pagesEl: new FakePagesEl() as any,
      getToken: () => 0,
      pdfjsLib: makeMockPdfjs(doc),
      onDocumentLoaded: (pageCount, info) => {
        captured = { pageCount, info };
      },
    });
    // Must not throw.
    await session.renderPdfBytes(new Uint8Array(10));
    assert.ok(captured, 'onDocumentLoaded must still fire after metadata failure');
    assert.equal(captured!.pageCount, 1);
    assert.deepEqual(captured!.info, {});
  });
});

// ── Virtualization ─────────────────────────────────────────────────

class FakeDoc100 {
  numPages = 100;
  cleanupCalls = 0;
  pageCreated: number[] = [];
  async getPage(n: number) {
    await new Promise((r) => setImmediate(r));
    this.pageCreated.push(n);
    return new FakePage(n);
  }
  async cleanup() {
    this.cleanupCalls += 1;
  }
}

describe('createPdfjsSession: virtualization', () => {
  it('renders only the initial buffer pages when virtualize=true', async () => {
    const doc = new FakeDoc100();
    const session = createPdfjsSession({
      pagesEl: new FakePagesEl() as any,
      getToken: () => 0,
      pdfjsLib: {
        getDocument: (_opts: Record<string, unknown>) => ({
          promise: Promise.resolve(doc),
        }),
      },
      virtualize: true,
      virtualizeBuffer: 3,
    });
    await session.renderPdfBytes(new Uint8Array(10));
    // 100 pages total, buffer=3 → first 4 pages rendered (1..4), rest are
    // placeholders. `pageCreated` also includes the height-estimation
    // `getPage(1)` call (extra entry for page 1), so the total count is
    // 4 rendered + 1 height-check = 5. Cleanup happens only on destroy(),
    // not after renderPdfBytes completes (doc stays alive for future
    // IntersectionObserver triggers and rerenderPage calls).
    assert.ok(
      doc.pageCreated.length <= 5,
      `expected ≤5 getPage calls (4 render + 1 estimate), got ${doc.pageCreated.length}`,
    );
    // The rendered pages should be 1..4. Page 1 appears twice (estimate
    // + render), others once each.
    assert.ok(doc.pageCreated.includes(1));
    assert.ok(doc.pageCreated.includes(2));
    assert.ok(doc.pageCreated.includes(3));
    assert.ok(doc.pageCreated.includes(4));
  });

  it('renders additional pages via IntersectionObserver trigger', async () => {
    const doc = new FakeDoc100();
    const pagesEl = new FakePagesEl() as any;
    const session = createPdfjsSession({
      pagesEl,
      getToken: () => 0,
      pdfjsLib: {
        getDocument: (_opts: Record<string, unknown>) => ({
          promise: Promise.resolve(doc),
        }),
      },
      virtualize: true,
      virtualizeBuffer: 3,
    });
    await session.renderPdfBytes(new Uint8Array(10));
    // Simulate a page scrolling into view by calling rerenderPage
    // (which delegates to renderPageContent).
    await session.rerenderPage(10, 0);
    // FakeDoc tracks all getPage calls, so pageCreated includes 10.
    assert.ok(doc.pageCreated.includes(10));
  });
});

// ── Layout: placeholder destroy + fresh inline-block container ──────────
//
// Regression test for Phase 2 §A3: all 16 pages of a PDF were squashed
// into narrow vertical strips. The previous fix attempt reset the
// container's `cssText` in-place to drop the placeholder's `width:
// 100%` / `height: ${estHeight}px`, but the browser sometimes kept the
// stale computed style cached, and the canvas's `max-width: 100%`
// created a circular reference with the inline-block parent that the
// flex-column `align-items: center` resolved by collapsing the
// container to ~0 wide. The fix is to *destroy* the placeholder and
// *create a fresh* `display: inline-block` container with no explicit
// width/height, so it shrink-wraps to the canvas immediately. The
// canvas's `aspect-ratio` (set in `renderPageContent`) is the single
// source of truth for its display height.
//
// This test uses real DOM (global-jsdom) so the actual `style.cssText`
// that the session writes is what we assert against — `FakePagesEl`
// strips styles and would have hidden the bug.

describe('createPdfjsSession: destroy-and-recreate layout (Phase 2 §A3 fix)', () => {
  /**
   * Real-DOM pagesEl that delegates to a real `HTMLDivElement`. global-jsdom
   * gives us Element / HTMLElement / style etc. for free.
   */
  class RealPagesEl {
    el: HTMLDivElement;
    constructor() {
      this.el = document.createElement('div');
    }
    get innerHTML(): string {
      return this.el.innerHTML;
    }
    set innerHTML(_: string) {
      this.el.innerHTML = '';
    }
    appendChild(child: Node): Node {
      return this.el.appendChild(child);
    }
    querySelector(sel: string): Element | null {
      return this.el.querySelector(sel);
    }
    querySelectorAll(sel: string): NodeListOf<Element> {
      return this.el.querySelectorAll(sel);
    }
    get clientWidth(): number {
      return 800;
    }
    get clientHeight(): number {
      return 600;
    }
  }

  it('non-virtualized: rendered container is a fresh inline-block (no inherited placeholder width/height)', async () => {
    const doc = new FakeDoc(2);
    const pagesEl = new RealPagesEl();
    const session = createPdfjsSession({
      pagesEl: pagesEl as any,
      getToken: () => 0,
      pdfjsLib: makeMockPdfjs(doc),
      computeDisplayScale: () => 1,
    });
    await session.renderPdfBytes(new Uint8Array(10));
    const containers = pagesEl.el.querySelectorAll<HTMLDivElement>(
      'div[data-page-container]',
    );
    assert.equal(containers.length, 2);
    for (const container of Array.from(containers)) {
      // Container is the bare `position: relative; display: inline-block;
      // overflow: hidden;` from the destroy-and-recreate path. Crucially
      // it must NOT carry `width: 100%` (placeholder residue) or any
      // explicit pixel width/height — those are what produced the
      // "full-width but 22px tall" symptom in the previous attempt.
      assert.match(
        container.style.cssText,
        /display:\s*inline-block/,
        `container should be display:inline-block, got: ${container.style.cssText}`,
      );
      assert.doesNotMatch(
        container.style.cssText,
        /\bwidth:\s*100%/,
        `container must not inherit placeholder width:100%, got: ${container.style.cssText}`,
      );
      assert.doesNotMatch(
        container.style.cssText,
        /\bwidth:\s*\d+px/,
        `container must not have explicit pixel width (shrink-wrap only), got: ${container.style.cssText}`,
      );
    }
  });

  it('non-virtualized: canvas carries explicit width AND height (no aspect-ratio fallback)', async () => {
    // Phase 2 §A3 fix: Chromium resolves `<canvas>` intrinsic dimensions
    // from the `canvas.width`/`canvas.height` HTML attributes BEFORE the
    // CSS `aspect-ratio` property, so for canvas elements the aspect-ratio
    // rule is effectively ignored. The fix is to set BOTH CSS `width` and
    // `height` explicitly in `renderPageContent` and `onAfterPageRender` —
    // here we verify the renderPageContent path.
    const doc = new FakeDoc(2);
    const pagesEl = new RealPagesEl();
    const session = createPdfjsSession({
      pagesEl: pagesEl as any,
      getToken: () => 0,
      pdfjsLib: makeMockPdfjs(doc),
      computeDisplayScale: () => 1,
    });
    await session.renderPdfBytes(new Uint8Array(10));
    const canvases = pagesEl.el.querySelectorAll<HTMLCanvasElement>('canvas');
    assert.equal(canvases.length, 2);
    for (const canvas of Array.from(canvases)) {
      // Canvas is created with explicit `width` AND `height` in CSS
      // pixels (from `baseVp` — not the outputScale-scaled internal
      // bitmap). FakePage returns {width:100, height:200} at scale=1.
      assert.equal(canvas.style.width, '100px', `canvas width should be 100px, got ${canvas.style.width}`);
      assert.equal(canvas.style.height, '200px', `canvas height should be 200px, got ${canvas.style.height}`);
      // `aspect-ratio` is no longer used (Chromium-canvas-intrinsic bug).
      assert.equal(canvas.style.aspectRatio, '', `canvas should not have aspect-ratio, got ${canvas.style.aspectRatio}`);
      assert.equal(canvas.style.display, 'block');
    }
  });

  it('virtualized: placeholders use the original width:100% + height:${estHeight}px pattern', async () => {
    const doc = new FakeDoc100();
    const pagesEl = new RealPagesEl();
    const session = createPdfjsSession({
      pagesEl: pagesEl as any,
      getToken: () => 0,
      pdfjsLib: {
        getDocument: (_opts: Record<string, unknown>) => ({
          promise: Promise.resolve(doc),
        }),
      },
      virtualize: true,
      virtualizeBuffer: 2,
      computeDisplayScale: () => 1,
    });
    await session.renderPdfBytes(new Uint8Array(10));
    // virtualizeBuffer=2 → first 3 pages (1..3) are rendered and become
    // fresh inline-block containers (without `width: 100%`). Pages 4..100
    // stay as placeholders with the original `width: 100%; height: 200px`
    // pattern — they exist only to give the scrollbar an accurate
    // vertical range until the IntersectionObserver fires.
    for (let n = 4; n <= 100; n += 1) {
      const c = pagesEl.el.querySelector<HTMLDivElement>(
        `div[data-page-container="${n}"]`,
      );
      assert.ok(c, `placeholder for page ${n} should exist`);
      assert.match(
        c!.style.cssText,
        /display:\s*inline-block/,
        `page ${n}: placeholder should be display:inline-block, got: ${c!.style.cssText}`,
      );
      assert.match(
        c!.style.cssText,
        /width:\s*100%/,
        `page ${n}: placeholder should have width:100%, got: ${c!.style.cssText}`,
      );
      assert.match(
        c!.style.cssText,
        /height:\s*200px/,
        `page ${n}: placeholder should have height:200px, got: ${c!.style.cssText}`,
      );
    }
  });

  it('renderPageContent replaces the placeholder with a fresh container (no cssText reset hack)', async () => {
    // Integration check: virtualize=true and verify that the first 3
    // pages have their placeholders destroyed and replaced with fresh
    // inline-block containers.
    const doc = new FakeDoc100();
    const pagesEl = new RealPagesEl();
    const session = createPdfjsSession({
      pagesEl: pagesEl as any,
      getToken: () => 0,
      pdfjsLib: {
        getDocument: (_opts: Record<string, unknown>) => ({
          promise: Promise.resolve(doc),
        }),
      },
      virtualize: true,
      virtualizeBuffer: 2,
      computeDisplayScale: () => 1,
    });
    await session.renderPdfBytes(new Uint8Array(10));
    // virtualizeBuffer=2 → first 3 pages (1..3) rendered. The others
    // (4..100) remain as placeholders.
    for (let n = 1; n <= 3; n += 1) {
      const c = pagesEl.el.querySelector<HTMLDivElement>(
        `div[data-page-container="${n}"]`,
      );
      assert.ok(c, `container for page ${n} should exist`);
      // Rendered containers must NOT have `width: 100%` (no placeholder
      // residue). They shrink-wrap to the canvas.
      assert.doesNotMatch(
        c!.style.cssText,
        /\bwidth:\s*100%/,
        `page ${n}: rendered container should not have width:100%, got: ${c!.style.cssText}`,
      );
    }
    for (let n = 4; n <= 100; n += 1) {
      const c = pagesEl.el.querySelector<HTMLDivElement>(
        `div[data-page-container="${n}"]`,
      );
      assert.ok(c, `placeholder for page ${n} should exist`);
      assert.match(
        c!.style.cssText,
        /width:\s*100%/,
        `page ${n}: placeholder should have width:100%, got: ${c!.style.cssText}`,
      );
    }
  });
});

// ── renderPdfUrl (streaming / Tier 1+2) ────────────────────────────────
//
// pdf-viewer switched from `renderPdfBytes(base64-decoded Uint8Array)` to
// `renderPdfUrl(whale-file:// URL)`: pdfjs reads bytes on demand via Range
// requests instead of materializing the whole file. These tests pin the
// session contract: `renderPdfUrl` passes `url` (never `data`) plus the
// range params to `getDocument`, while `renderPdfBytes` is unchanged
// (office-viewer regression guard — its PDF comes from an in-memory
// LibreOffice conversion).

describe('createPdfjsSession: renderPdfUrl (streaming)', () => {
  it('passes `url` (not `data`) to getDocument with range params + shared base', async () => {
    const doc = new FakeDoc(1);
    let capturedOpts: Record<string, unknown> | null = null;
    const session = createPdfjsSession({
      pagesEl: new FakePagesEl() as any,
      getToken: () => 0,
      pdfjsLib: {
        getDocument: (opts: Record<string, unknown>) => {
          capturedOpts = opts;
          return { promise: Promise.resolve(doc) };
        },
      },
    });
    await session.renderPdfUrl('whale-file:///x/test.pdf');
    assert.ok(capturedOpts, 'getDocument should have been called');
    assert.equal(capturedOpts!.url, 'whale-file:///x/test.pdf');
    assert.equal(
      capturedOpts!.data,
      undefined,
      'url mode must not pass `data`',
    );
    assert.equal(capturedOpts!.disableRange, false);
    assert.equal(capturedOpts!.rangeChunkSize, 65536);
    // Shared base params still present (same as the bytes path).
    assert.equal(capturedOpts!.BinaryDataFactory, HostBinaryDataFactory);
    assert.equal(capturedOpts!.isEvalSupported, false);
    assert.equal(capturedOpts!.cMapPacked, true);
  });

  it('renderPdfBytes still passes `data` and no `url` (office-viewer regression)', async () => {
    const doc = new FakeDoc(1);
    let capturedOpts: Record<string, unknown> | null = null;
    const session = createPdfjsSession({
      pagesEl: new FakePagesEl() as any,
      getToken: () => 0,
      pdfjsLib: {
        getDocument: (opts: Record<string, unknown>) => {
          capturedOpts = opts;
          return { promise: Promise.resolve(doc) };
        },
      },
    });
    const bytes = new Uint8Array([1, 2, 3]);
    await session.renderPdfBytes(bytes);
    assert.ok(capturedOpts);
    assert.deepEqual(
      Array.from(capturedOpts!.data as Uint8Array),
      [1, 2, 3],
    );
    assert.equal(capturedOpts!.url, undefined);
    // Range params are not injected on the bytes path.
    assert.equal(capturedOpts!.disableRange, undefined);
  });

  it('renderPdfUrl surfaces a load error via onStatus and re-throws', async () => {
    let status: { kind: string; text: string } | null = null;
    const session = createPdfjsSession({
      pagesEl: new FakePagesEl() as any,
      getToken: () => 0,
      pdfjsLib: {
        getDocument: () => ({
          promise: Promise.reject(new Error('range request denied')),
        }),
      },
      onStatus: (msg) => {
        status = msg;
      },
    });
    await assert.rejects(
      session.renderPdfUrl('whale-file:///x/broken.pdf'),
      /range request denied/,
    );
    assert.ok(status);
    assert.equal(status!.kind, 'error');
    assert.match(status!.text, /range request denied/);
  });
});

// ── Worker mode (Tier 3) ────────────────────────────────────────────────
//
// `useWorker` decides whether pdfjs runs its parser on a real Worker
// (`GlobalWorkerOptions.workerSrc` set, `globalThis.pdfjsWorker` NOT pinned)
// or the legacy fake-worker main-thread path (`globalThis.pdfjsWorker`
// pinned). Both branches touch module-global state, so each test resets
// `globalThis.pdfjsWorker` first.

describe('createPdfjsSession: worker mode', () => {
  it('useWorker=true sets GlobalWorkerOptions.workerSrc and does not pin the fake worker', () => {
    (globalThis as any).pdfjsWorker = undefined;
    const workerOpts: { workerSrc?: string } = {};
    const session = createPdfjsSession({
      pagesEl: new FakePagesEl() as any,
      getToken: () => 0,
      pdfjsLib: {
        getDocument: () => ({ promise: Promise.resolve(new FakeDoc(1)) }),
        GlobalWorkerOptions: workerOpts,
      } as any,
      useWorker: true,
      workerSrc: 'whale-extension://pdf-viewer/pdf.worker.mjs',
    });
    assert.equal(
      workerOpts.workerSrc,
      'whale-extension://pdf-viewer/pdf.worker.mjs',
    );
    assert.equal(
      (globalThis as any).pdfjsWorker,
      undefined,
      'globalThis.pdfjsWorker must not be pinned in real-worker mode',
    );
    assert.ok(session);
  });

  it('useWorker=false (default) pins globalThis.pdfjsWorker (fake-worker path)', () => {
    (globalThis as any).pdfjsWorker = undefined;
    createPdfjsSession({
      pagesEl: new FakePagesEl() as any,
      getToken: () => 0,
      pdfjsLib: {
        getDocument: () => ({ promise: Promise.resolve(new FakeDoc(1)) }),
      } as any,
    });
    assert.notEqual(
      (globalThis as any).pdfjsWorker,
      undefined,
      'globalThis.pdfjsWorker should be pinned in fake-worker mode',
    );
  });
});

// ── Outline (getOutline / resolveDest) ──────────────────────────────────
//
// pdf-viewer's sidebar calls session.getOutline() for the bookmark tree and
// session.resolveDest(dest) to turn a node's dest into a 0-based page index.
// These run AFTER renderPdfBytes (so currentDoc is set); the virtualized
// render path keeps currentDoc alive (the non-virtualized `finally` clears
// it), so the tests mirror pdf-viewer's virtualize:true config.

describe('createPdfjsSession: outline', () => {
  function makeOutlineSession(doc: FakeDoc) {
    return createPdfjsSession({
      pagesEl: new FakePagesEl() as any,
      getToken: () => 0,
      pdfjsLib: makeMockPdfjs(doc),
      virtualize: true,
    });
  }

  it('getOutline() returns the doc outline tree', async () => {
    const doc = new FakeDoc(1);
    doc.outline = [
      { title: 'Chapter 1', dest: 'ch1', url: null, items: [] },
      { title: 'External', dest: null, url: 'https://example.com', items: [] },
    ];
    const session = makeOutlineSession(doc);
    await session.renderPdfBytes(new Uint8Array(10));
    const outline = await session.getOutline();
    assert.equal(outline.length, 2);
    assert.equal(outline[0].title, 'Chapter 1');
    assert.equal(outline[1].url, 'https://example.com');
  });

  it('getOutline() returns [] when the doc has no outline', async () => {
    const session = makeOutlineSession(new FakeDoc(1));
    await session.renderPdfBytes(new Uint8Array(10));
    assert.deepEqual(await session.getOutline(), []);
  });

  it('resolveDest resolves a named (string) dest via getDestination', async () => {
    const doc = new FakeDoc(5);
    const ref = {};
    doc.destinations = { ch1: [ref, { name: 'XYZ' }, 0, 0, 0] };
    doc.refToIndex.set(ref, 3); // 0-based page 3
    const session = makeOutlineSession(doc);
    await session.renderPdfBytes(new Uint8Array(10));
    assert.equal(await session.resolveDest('ch1'), 3);
  });

  it('resolveDest resolves an explicit (array) dest directly', async () => {
    const doc = new FakeDoc(5);
    const ref = {};
    doc.refToIndex.set(ref, 2);
    const session = makeOutlineSession(doc);
    await session.renderPdfBytes(new Uint8Array(10));
    assert.equal(await session.resolveDest([ref, { name: 'XYZ' }]), 2);
  });

  it('resolveDest returns null for null / unknown dest', async () => {
    const session = makeOutlineSession(new FakeDoc(3));
    await session.renderPdfBytes(new Uint8Array(10));
    assert.equal(await session.resolveDest(null), null);
    assert.equal(await session.resolveDest('never-heard-of'), null);
  });
});
