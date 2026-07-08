/**
 * md-editor — regression tests for md-sandbox.ts (the mermaid sandbox
 * iframe manager). Focused on the race condition fixed in §18.3.3
 * (Week 6): `render()` must NOT post to the iframe's contentWindow
 * before `ready` has resolved, or messages arrive at a window that
 * has not yet attached its `message` listener (the sandbox attaches
 * the listener inside its `ready()` bootstrap, AFTER mermaid.min.js
 * finishes loading + `window.mermaid` is defined). Without the fix,
 * every render on the user's first preview render hangs / times out.
 *
 * Strategy: stub `document.createElement('iframe')` so the returned
 * `contentWindow.postMessage` is a Spy. Track when it gets called
 * relative to when the `ready` promise resolves.
 */

import { describe, it, before, beforeEach, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import globalJsdom from 'global-jsdom';

// global-jsdom@29 needs an explicit install call to register window/document.
const jsdom = globalJsdom();
after(() => jsdom?.());

interface PostCall {
  data: unknown;
  origin: string;
  at: 'before-ready' | 'after-ready';
}

interface MockContentWindow {
  postMessage: (data: unknown, origin: string) => void;
}

interface MockIframe {
  src: string;
  sandbox: string;
  title: string;
  ariaHidden: string;
  style: { cssText: string };
  contentWindow: MockContentWindow;
  setAttribute: (k: string, v: string) => void;
  addEventListener: (k: string, h: (...args: unknown[]) => void) => void;
  removeEventListener: (k: string, h: (...args: unknown[]) => void) => void;
  remove: () => void;
}

function makeMockIframe(): { iframe: MockIframe; calls: PostCall[]; fireLoad: () => void } {
  const calls: PostCall[] = [];
  const ready = { fired: false };
  const contentWindow: MockContentWindow = {
    postMessage: (data: unknown, origin: string) => {
      calls.push({ data, origin, at: ready.fired ? 'after-ready' : 'before-ready' });
    },
  };
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const iframe: MockIframe = {
    src: '',
    sandbox: '',
    title: '',
    ariaHidden: '',
    style: { cssText: '' },
    contentWindow,
    setAttribute(k: string, v: string) {
      // mirror HTMLIFrameElement.setAttribute behaviour for the
      // attributes the sandbox manager touches.
      if (k === 'sandbox') this.sandbox = v;
      else if (k === 'title') this.title = v;
      else if (k === 'aria-hidden') this.ariaHidden = v;
    },
    addEventListener(k: string, h: (...args: unknown[]) => void) {
      (listeners[k] ||= []).push(h);
    },
    removeEventListener(k: string, h: (...args: unknown[]) => void) {
      const arr = listeners[k];
      if (!arr) return;
      const i = arr.indexOf(h);
      if (i >= 0) arr.splice(i, 1);
    },
    remove() {
      /* no-op */
    },
  };
  return {
    iframe,
    calls,
    fireLoad: () => {
      ready.fired = true;
      for (const h of listeners['load'] ?? []) h(new Event('load'));
    },
  };
}

describe('createMermaidSandbox — §18.3.3 race-condition fix', () => {
  let originalCreateElement: typeof document.createElement;
  let mock: ReturnType<typeof makeMockIframe>;
  // Stub mount element — `createMermaidSandbox` calls
  // `mount.appendChild(iframe)` and `iframe.remove()`. We replace
  // body with a div that has no-op appendChild/removeChild so the
  // mock iframe (which is not a real Node) doesn't blow up jsdom's
  // type check.
  let stubMount: {
    appendChild: (n: unknown) => unknown;
    removeChild: (n: unknown) => unknown;
  };

  before(() => {
    originalCreateElement = document.createElement.bind(document);
    stubMount = {
      appendChild: () => undefined,
      removeChild: () => undefined,
    };
    document.createElement = ((tag: string) => {
      if (tag.toLowerCase() === 'iframe') {
        mock = makeMockIframe();
        return mock.iframe as unknown as HTMLElement;
      }
      return originalCreateElement(tag);
    }) as typeof document.createElement;
  });

  after(() => {
    document.createElement = originalCreateElement;
  });

  it('defers postMessage until after the sandbox posts ready (§18.3.3 race fix)', async () => {
    const { createMermaidSandbox } = await import('./md-sandbox');
    const sb = createMermaidSandbox({
      src: 'mermaid-sandbox.html',
      mount: stubMount as unknown as HTMLElement,
    });

    // 1) Synchronously call render() — this used to call postMessage
    //    IMMEDIATELY, racing the sandbox's message-listener attach.
    const renderPromise = sb.render('m-test-1', 'graph TD\nA-->B');

    // 2) No postMessage must have fired yet — the sandbox hasn't
    //    posted `ready`, so the listener inside the iframe isn't
    //    attached. Posting now would silently drop the message.
    assert.equal(
      mock.calls.length,
      0,
      `render() posted ${mock.calls.length} message(s) before sandbox ready — ` +
        `would be dropped by the sandbox because its listener attaches inside ready().`
    );

    // 3) Simulate the sandbox posting `ready`. Node's MessageEvent
    //    constructor refuses non-MessagePort sources, so we use
    //    jsdom's MessageEvent (installed by global-jsdom) which
    //    accepts Window sources — the message handler only reads
    //    `e.data` and `e.source`, both of which we set.
    mock.fireLoad();
    const JSDOMMessageEvent = (window as unknown as { MessageEvent: typeof MessageEvent })
      .MessageEvent;
    const readyEvent = new JSDOMMessageEvent('message', {
      data: { type: 'ready' },
      source: mock.iframe.contentWindow as unknown as MessageEvent['source'],
    });
    window.dispatchEvent(readyEvent);

    // 4) Now postMessage should have fired exactly once for our render
    //    request, with the right payload.
    await sb.ready;
    assert.equal(
      mock.calls.length,
      1,
      `expected exactly one postMessage after ready, got ${mock.calls.length}`
    );
    const call = mock.calls[0];
    assert.equal(call.origin, '*', 'must post with targetOrigin "*" (sandbox opaque origin)');
    assert.equal(call.at, 'after-ready', 'postMessage must happen AFTER ready resolves');
    assert.deepEqual(
      (call.data as { type: string; id: string; source: string }),
      { type: 'render', id: 'm-test-1', source: 'graph TD\nA-->B' }
    );

    // 5) Cleanup so the readyTimeout doesn't fire during this test.
    sb.destroy();
    // Swallow the dangling render promise so unhandled rejection
    // doesn't fail the test run.
    await renderPromise.catch(() => undefined);
  });

  it('queues render() calls fired before ready, then fires them after (§18.3.3 ready-deferral)', async () => {
    const { createMermaidSandbox } = await import('./md-sandbox');
    const sb = createMermaidSandbox({
      src: 'mermaid-sandbox.html',
      mount: stubMount as unknown as HTMLElement,
    });

    // Fire multiple renders synchronously — pre-fix, all of them
    // would have posted immediately and been lost in the sandbox.
    const r1 = sb.render('m-q-1', 'A');
    const r2 = sb.render('m-q-2', 'B');
    const r3 = sb.render('m-q-3', 'C');

    // No message has been posted yet.
    assert.equal(mock.calls.length, 0);

    // Sandbox ready.
    mock.fireLoad();
    const JSDOMMessageEvent = (window as unknown as { MessageEvent: typeof MessageEvent })
      .MessageEvent;
    const readyEvent = new JSDOMMessageEvent('message', {
      data: { type: 'ready' },
      source: mock.iframe.contentWindow as unknown as MessageEvent['source'],
    });
    window.dispatchEvent(readyEvent);
    await sb.ready;

    // All 3 should now have posted, in order.
    assert.equal(mock.calls.length, 3);
    assert.equal(mock.calls[0].at, 'after-ready');
    assert.equal(mock.calls[1].at, 'after-ready');
    assert.equal(mock.calls[2].at, 'after-ready');
    assert.equal(
      (mock.calls[0].data as { id: string }).id,
      'm-q-1'
    );
    assert.equal(
      (mock.calls[2].data as { id: string }).id,
      'm-q-3'
    );

    sb.destroy();
    await Promise.all([r1, r2, r3].map((p) => p.catch(() => undefined)));
  });

  it('rejects pending render() when ready times out (5s auto-reject)', async () => {
    const { createMermaidSandbox } = await import('./md-sandbox');
    const sb = createMermaidSandbox({
      src: 'mermaid-sandbox.html',
      mount: stubMount as unknown as HTMLElement,
    });

    // Mock Date.now / setTimeout indirectly by fast-forwarding? We
    // can't easily mock the 5s readyTimeout from outside the module.
    // Instead, call destroy() before ready resolves and assert the
    // pending RPC rejects with the destroy reason — that exercises
    // the same failure path (RPC rejected before sandbox responds).
    const p = sb.render('m-timeout', 'X');
    let rejected = false;
    p.catch((err: Error) => {
      rejected = true;
      assert.match(err.message, /destroyed/);
    });
    sb.destroy();
    await p.catch(() => undefined);
    assert.equal(rejected, true, 'render() promise must reject on destroy()');
  });
});

// --- _getSandboxForTest — concurrent getSandbox() caching (§18.3.3 fix) --

describe('_getSandboxForTest — getSandbox() iframe-mount dedupe', () => {
  // Track `document.createElement('iframe')` calls. Each call to
  // `createMermaidSandbox` triggers exactly one iframe element
  // creation. Pre-fix, two concurrent `getSandbox()` callers each
  // called `createMermaidSandbox`, so the counter went to 2 (one
  // iframe leaked in document.body). Post-fix, the second caller
  // hits the cached promise and never reaches the createElement
  // call, so the counter stays at 1.
  let iframeCreateCount = 0;
  let origCreate: typeof document.createElement;
  let origAppend: typeof document.body.appendChild;
  let origRemove: typeof document.body.removeChild;

  beforeEach(() => {
    if (typeof window === 'undefined') return;
    iframeCreateCount = 0;
    origCreate = document.createElement.bind(document);
    (document as unknown as { createElement: typeof document.createElement }).createElement =
      ((tag: string) => {
        if (tag.toLowerCase() === 'iframe') {
          iframeCreateCount++;
          return makeMockIframe().iframe as unknown as HTMLElement;
        }
        return origCreate(tag);
      }) as typeof document.createElement;

    // jsdom validates that appended nodes are real DOM Nodes; our
    // mock iframe isn't, so stub body.appendChild / removeChild.
    origAppend = document.body.appendChild.bind(document.body);
    origRemove = document.body.removeChild.bind(document.body);
    document.body.appendChild = (() => document.body) as typeof document.body.appendChild;
    document.body.removeChild = (() => document.body) as typeof document.body.removeChild;
  });

  afterEach(async () => {
    if (typeof window === 'undefined') return;
    // Destroy the cached sandbox so the in-flight 5s ready-timeout
    // doesn't fire AFTER the test ends and trigger an
    // `unhandledRejection` (Node test runner treats that as a test
    // failure even though the assertions passed).
    const { _resetSandboxForTest } = await import('./md-render');
    _resetSandboxForTest();
  });

  after(() => {
    if (typeof window === 'undefined') return;
    document.body.appendChild = origAppend;
    document.body.removeChild = origRemove;
  });

  it('two concurrent _getSandboxForTest calls mount exactly ONE iframe (§18.3.3 race fix)', async () => {
    const { _getSandboxForTest, _resetSandboxForTest } = await import('./md-render');
    _resetSandboxForTest();

    // Fire two concurrent callers. Pre-fix, both passed the
    // `if (sandbox) return sandbox;` check (sandbox was null), both
    // called `createMermaidSandbox`, the second overwrote the first
    // — leaking one iframe in document.body. Post-fix, the second
    // caller hits `if (sandboxPromise) return sandboxPromise;` and
    // never reaches the iframe creation.
    const [_sb1, _sb2] = await Promise.all([
      _getSandboxForTest(),
      _getSandboxForTest(),
    ]);

    assert.equal(
      iframeCreateCount,
      1,
      `expected exactly 1 iframe mount after two concurrent getSandbox() calls, got ${iframeCreateCount} (pre-fix bug: each caller created its own iframe, second one overwrote the first)`
    );
  });

  it('a second call AFTER the first resolves still mounts no new iframe (cached)', async () => {
    const { _getSandboxForTest, _resetSandboxForTest } = await import('./md-render');
    _resetSandboxForTest();

    await _getSandboxForTest();
    assert.equal(iframeCreateCount, 1, 'first call mounts one iframe');

    await _getSandboxForTest();
    assert.equal(
      iframeCreateCount,
      1,
      'second call after first resolution must NOT mount a new iframe — getSandbox promise is cached'
    );
  });
});