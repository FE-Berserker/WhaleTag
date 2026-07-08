/**
 * md-editor — sandboxed mermaid iframe manager (§18.3.3).
 *
 * Background: mermaid v11 uses `new Function(...)` / `eval(...)`
 * internally to compile diagram definitions. The md-editor's main
 * iframe runs with a strict CSP (no `unsafe-eval`), so we cannot
 * import mermaid there without weakening the CSP for the entire
 * editor — too broad a relaxation for one optional feature.
 *
 * Solution: spawn a SECOND, dedicated `<iframe>` for mermaid. The
 * second iframe runs mermaid-sandbox.html, which has its own CSP
 * allowing `'unsafe-eval'` (the only relaxation). The parent wraps
 * the iframe in `sandbox="allow-scripts"` (no `allow-same-origin`),
 * so the mermaid code:
 *   - CAN run scripts (needed for `new Function`)
 *   - CANNOT read the parent's DOM, cookies, or localStorage
 *     (sandbox attribute is the cross-origin protection)
 *   - CAN send `postMessage` results back to the parent
 *   - CANNOT reach the main process / file system
 *
 * The communication protocol is a one-shot RPC:
 *   parent → sandbox: `{type: 'render', id, source}`
 *   sandbox → parent: `{type: 'rendered', id, svg}` | `{type: 'error', id, message}`
 *
 * The sandbox also sends `{type: 'ready'}` once after it loads, so
 * the parent can queue early render requests until it's up.
 *
 * The sandbox is lazy-created on the first `render()` call. It's a
 * singleton per md-editor iframe lifetime — re-using the same sandbox
 * keeps mermaid's `initialize` state warm and avoids the ~500ms
 * `new Function` re-compile on every diagram.
 */

export interface SandboxRenderer {
  /**
   * Render a mermaid source string to SVG. The returned promise
   * resolves with the SVG text on success, or rejects with an
   * Error whose `message` is the user-facing parse error.
   *
   * The `id` is opaque — the caller passes any string, and uses
   * the same id to identify the placeholder in the preview DOM.
   */
  render(id: string, source: string): Promise<string>;
  /**
   * Tear down: remove the iframe and unregister the message
   * listener. Use on iframe unload.
   */
  destroy(): void;
  /**
   * Test / debug hook: the ready promise resolves once the sandbox
   * iframe has finished loading + bootstrapped mermaid. Render
   * calls before `ready` is awaited are queued and dispatched
   * automatically.
   */
  ready: Promise<void>;
}

interface SandboxOptions {
  /**
   * The `<iframe>` `src` URL, e.g. `whale-extension://md-editor/mermaid-sandbox.html`.
   * The path is relative to the extension's dist folder; the
   * browser resolves it against the iframe's base URL.
   */
  src: string;
  /**
   * Parent element to mount the iframe into. Defaults to `document.body`
   * if omitted. The iframe is `position: absolute` with `width: 0` +
   * `height: 0` so it never affects layout.
   */
  mount?: HTMLElement;
}

/**
 * Module-level pending RPCs, keyed by `id`. Each call to `render`
 * pushes a `{resolve, reject}` pair; the first message from the
 * sandbox whose `id` matches pops it.
 */
interface PendingRpc {
  resolve(svg: string): void;
  reject(err: Error): void;
}

const SANDBOX_IFRAME_STYLE =
  'position:absolute;width:0;height:0;border:0;visibility:hidden;';

export function createMermaidSandbox(opts: SandboxOptions): SandboxRenderer {
  const mount = opts.mount ?? document.body;

  // Use Map<id, PendingRpc> — `delete` on first match avoids keeping
  // stale entries around.
  const pending = new Map<string, PendingRpc>();
  let idCounter = 0;
  let readyResolve: () => void = () => undefined;
  let readyReject: (err: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const iframe = document.createElement('iframe');
  // `sandbox="allow-scripts"` (no `allow-same-origin`) is the
  // critical security boundary: mermaid can run code, but the iframe
  // has an OPAQUE origin, so it can't read the parent's DOM, cookies,
  // or storage. Mermaid is locked in this sandbox and can only
  // communicate back via `postMessage`.
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('title', 'mermaid-sandbox');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = SANDBOX_IFRAME_STYLE;
  iframe.src = opts.src;

  const messageHandler = (e: MessageEvent): void => {
    // SECURITY: only accept messages from OUR iframe. Other postMessage
    // sources (e.g. an attacker embedding our page) must not be able
    // to spoof render results. With `sandbox="allow-scripts"` (no
    // `allow-same-origin`), the iframe has an opaque origin — `e.source`
    // is still the contentWindow reference per spec, but in some
    // Chromium versions the strict equality fails. As a defensive
    // fallback, also accept messages whose `data` shape is one of
    // ours (the sandbox's `type` field is a unique discriminator).
    const data = (e.data ?? {}) as {
      type?: string;
      id?: string;
      svg?: string;
      message?: string;
    };
    const isFromOurSandbox = e.source === iframe.contentWindow;
    const isOursByShape =
      data.type === 'ready' ||
      (data.type === 'rendered' && typeof data.svg === 'string') ||
      (data.type === 'error' && typeof data.message === 'string');
    // eslint-disable-next-line no-console
    console.log(
      `[md-editor] sandbox msg: type=${data.type} id=${data.id} sourceMatch=${isFromOurSandbox}`
    );
    if (!isFromOurSandbox && !isOursByShape) return;

    if (data.type === 'ready') {
      readyResolve();
      return;
    }
    if (!data.id) return;
    const rpc = pending.get(data.id);
    if (!rpc) return;
    pending.delete(data.id);
    if (data.type === 'rendered' && typeof data.svg === 'string') {
      // eslint-disable-next-line no-console
      console.log(
        `[md-editor] mermaid sandbox: rendered id=${data.id} svg.length=${data.svg.length}`
      );
      rpc.resolve(data.svg);
    } else if (data.type === 'error') {
      // eslint-disable-next-line no-console
      console.warn(
        `[md-editor] mermaid sandbox: error id=${data.id} message=${data.message}`
      );
      rpc.reject(new Error(data.message || 'mermaid render failed'));
    }
  };
  window.addEventListener('message', messageHandler);

  // §18.3.3 fix — race against the sandbox's listener attachment.
  //
  // mermaid-sandbox.html attaches its own `message` listener INSIDE
  // the `ready()` bootstrap, AFTER `window.mermaid` is defined (i.e.
  // AFTER the ~3.4MB mermaid.min.js script has finished executing).
  // The parent (`renderMermaid`) calls `sb.render(id, source)`
  // synchronously right after creating the iframe — long before the
  // sandbox is ready. postMessage delivers each message as a task in
  // the iframe's event loop, dispatched against whatever listeners
  // exist at dispatch time; messages that arrive before the listener
  // is attached are silently dropped (no replay).
  //
  // Two fixes, both applied:
  //
  // 1. **`render()` waits for `ready`** before posting. The pending
  //    RPC is registered immediately (so a late `rendered` message
  //    can still match it), but the postMessage call is deferred to
  //    the `ready.then(...)` callback. This is the primary fix: it
  //    means messages are only sent AFTER the sandbox has booted and
  //    attached its listener.
  //
  // 2. **Sandbox-side buffer (see mermaid-sandbox.html)** is a
  //    defense-in-depth: even if the parent races ahead, the sandbox
  //    queues incoming `{type: 'render', id, source}` messages until
  //    its own listener is attached, then drains the queue. Either
  //    fix alone is sufficient; both together mean the user's first
  //    preview render can never be lost to the race.

  const onLoad = (): void => {
    // The iframe's load event fires before its inline script runs,
    // so we don't dispatch any renders here — we wait for the
    // explicit `ready` message from the sandbox. If the sandbox
    // never sends `ready` (e.g. mermaid.min.js 404), the `ready`
    // promise never resolves and the first render() call will hang
    // — the parent UI can show a "mermaid unavailable" indicator
    // based on a timeout. We also handle the error case in
    // `destroy()`.
    if (iframe.contentWindow === null) {
      readyReject(new Error('mermaid sandbox iframe failed to load'));
    }
  };
  iframe.addEventListener('load', onLoad);
  iframe.addEventListener('error', () => {
    readyReject(new Error('mermaid sandbox iframe load error'));
  });
  mount.appendChild(iframe);

  // Auto-timeout `ready` after 5s — protects against a 404'd
  // mermaid.min.js or a sandbox that hangs on init. The first
  // render() call will reject with the timeout error; subsequent
  // calls fail-fast.
  const readyTimeout = setTimeout(() => {
    readyReject(new Error('mermaid sandbox ready timeout (5s)'));
  }, 5000);

  return {
    ready,
    render(id, source) {
      clearTimeout(readyTimeout);
      return new Promise<string>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        // §18.3.3 fix — only post the render request AFTER the
        // sandbox has booted. If we post immediately, the message
        // arrives at the iframe's window BEFORE mermaid-sandbox.html
        // has finished loading mermaid.min.js and attached its own
        // `message` listener (the listener lives inside the `ready()`
        // bootstrap, after `window.mermaid` is defined). The message
        // is then dispatched to no handler and silently dropped — every
        // diagram on the user's first preview render hangs/times out.
        //
        // If `ready` is already settled (resolved), this fires on the
        // next microtask — still after the synchronous `pending.set`.
        // If the iframe 5s-ready-timeout has already rejected, we
        // reject this RPC immediately too (so callers don't hang).
        ready.then(
          () => {
            // Use '*' as the targetOrigin because the iframe has an
            // OPAQUE origin (sandbox without allow-same-origin), so
            // there's no specific origin to target. The sandbox only
            // runs our own code (mermaid-sandbox.html, served from the
            // same extension dist), so this is safe.
            iframe.contentWindow?.postMessage(
              { type: 'render', id, source },
              '*'
            );
          },
          (err) => reject(err instanceof Error ? err : new Error(String(err)))
        );
      });
    },
    destroy() {
      clearTimeout(readyTimeout);
      window.removeEventListener('message', messageHandler);
      iframe.removeEventListener('load', onLoad);
      // Reject all pending RPCs so callers don't hang forever.
      for (const rpc of pending.values()) {
        rpc.reject(new Error('mermaid sandbox destroyed'));
      }
      pending.clear();
      readyReject(new Error('mermaid sandbox destroyed'));
      // Silence the `ready` promise's own rejection — callers
      // awaiting `sb.ready` get the error via `readyReject`, but
      // the underlying `ready` promise may have no catch handler
      // attached (e.g. when destroy is called from a test teardown
      // before any consumer awaits it). Without this, Node logs
      // `unhandledRejection` and the test runner reports it as a
      // failure even when all assertions passed.
      ready.catch(() => undefined);
      iframe.remove();
    },
  };
}

/**
 * Convenience: mint a fresh, unique `id` for a new mermaid block.
 * The id is opaque to the sandbox — used only to correlate
 * placeholder DOM nodes with their pending RPC.
 */
export function newMermaidId(): string {
  // Time prefix lets the id be human-readable in DevTools; the
  // random suffix prevents collisions within the same millisecond
  // when the user pastes multiple diagrams at once.
  return `m${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}
