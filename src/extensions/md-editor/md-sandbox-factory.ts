/**
 * Shared factory for md-editor's postMessage sandboxes (mermaid + katex).
 *
 * Both features run a child `<iframe sandbox="allow-scripts">` (no
 * `allow-same-origin` → opaque origin) that renders on demand and posts
 * the result back. This factory hoists the ~160 lines of mirror code that
 * used to live in BOTH `md-sandbox.ts` and `katex-sandbox.ts` (iframe
 * setup + messageHandler + render RPC + ready/destroy/5s-timeout). The
 * two consumers now only carry their differences: the result key
 * (`svg` for mermaid, `html` for katex), the iframe title, and an
 * optional per-render payload (katex's `displayMode`).
 *
 * Protocol on the wire (unchanged):
 *   parent  → sandbox: { type: 'render', id, source, ...extra }
 *   sandbox → parent:  { type: 'ready' }
 *                    |  { type: 'rendered', id, [resultKey]: string }
 *                    |  { type: 'error', id, message }
 *
 * Security: the iframe is `sandbox="allow-scripts"` (no allow-same-origin),
 * so it has an opaque origin — it can run code (mermaid needs `unsafe-eval`
 * for `new Function`) but CANNOT read the parent's DOM, cookies, or
 * storage. Communication is postMessage only. The messageHandler requires
 * BOTH a source match (`e.source === contentWindow`) AND a shape match
 * (known type + well-typed payload) — defense in depth, since modern
 * Chromium's `e.source` strict-equality is reliable; each `rendered`/`error`
 * must also correlate to a pending `id` (random, unpredictable).
 */

export interface PostMessageSandboxOptions {
  /** `<iframe src>` — relative to the extension's dist folder. */
  src: string;
  /** Iframe title (a11y). */
  title: string;
  /** `data[resultKey]` carries the rendered output: `'svg'` (mermaid) or `'html'` (katex). */
  resultKey: 'svg' | 'html';
  /** Lowercase label for error messages + logs ('mermaid' / 'katex'). */
  label: string;
  /** Mount parent; defaults to `document.body`. The iframe is zero-sized. */
  mount?: HTMLElement;
}

export interface PostMessageSandbox {
  /** Resolves once the sandbox iframe loaded + sent `ready`. */
  ready: Promise<void>;
  /** Render `source` → output string (svg/html). `extra` is spread into the
   *  render postMessage (katex uses `{ displayMode }`). */
  render(
    id: string,
    source: string,
    extra?: Record<string, unknown>
  ): Promise<string>;
  /** Tear down: remove iframe + listener, reject pending RPCs. */
  destroy(): void;
}

const SANDBOX_IFRAME_STYLE =
  'position:absolute;width:0;height:0;border:0;visibility:hidden;';

interface PendingRpc {
  resolve(out: string): void;
  reject(err: Error): void;
}

export function createPostMessageSandbox(
  opts: PostMessageSandboxOptions
): PostMessageSandbox {
  const mount = opts.mount ?? document.body;
  const { resultKey, label } = opts;

  const pending = new Map<string, PendingRpc>();
  let readyResolve: () => void = () => undefined;
  let readyReject: (err: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('title', opts.title);
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = SANDBOX_IFRAME_STYLE;
  iframe.src = opts.src;

  const messageHandler = (e: MessageEvent): void => {
    const data = (e.data ?? {}) as {
      type?: string;
      id?: string;
      svg?: string;
      html?: string;
      message?: string;
    };
    const isFromOurSandbox = e.source === iframe.contentWindow;
    const isOursByShape =
      data.type === 'ready' ||
      (data.type === 'rendered' && typeof data[resultKey] === 'string') ||
      (data.type === 'error' && typeof data.message === 'string');
    // §18.4-harden — require BOTH source match AND shape match (AND, not OR).
    // Modern Chromium's `e.source === contentWindow` is reliable, so shape is
    // a second gate (defense in depth), not a fallback for an unreliable one.
    if (!isFromOurSandbox || !isOursByShape) return;

    if (data.type === 'ready') {
      readyResolve();
      return;
    }
    if (!data.id) return;
    const rpc = pending.get(data.id);
    if (!rpc) return;
    pending.delete(data.id);
    if (data.type === 'rendered' && typeof data[resultKey] === 'string') {
      rpc.resolve(data[resultKey] as string);
    } else if (data.type === 'error') {
      // eslint-disable-next-line no-console
      console.warn(
        `[md-editor] ${label} sandbox: error id=${data.id} message=${data.message}`
      );
      rpc.reject(new Error(data.message || `${label} render failed`));
    }
  };
  window.addEventListener('message', messageHandler);

  const onLoad = (): void => {
    if (iframe.contentWindow === null) {
      readyReject(new Error(`${label} sandbox iframe failed to load`));
    }
  };
  iframe.addEventListener('load', onLoad);
  iframe.addEventListener('error', () => {
    readyReject(new Error(`${label} sandbox iframe load error`));
  });
  mount.appendChild(iframe);

  // 5s ready timeout — protects against a 404'd sandbox script or a hang
  // on init. The first render() rejects with the timeout; later fail-fast.
  const readyTimeout = setTimeout(() => {
    readyReject(new Error(`${label} sandbox ready timeout (5s)`));
  }, 5000);

  return {
    ready,
    render(id, source, extra) {
      clearTimeout(readyTimeout);
      return new Promise<string>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        // Only post AFTER the sandbox booted (its listener is attached
        // inside its `ready` bootstrap, after the heavy script loaded).
        // Posting earlier risks the message arriving before the listener
        // and being silently dropped.
        ready.then(
          () => {
            iframe.contentWindow?.postMessage(
              { type: 'render', id, source, ...extra },
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
      for (const rpc of pending.values()) {
        rpc.reject(new Error(`${label} sandbox destroyed`));
      }
      pending.clear();
      readyReject(new Error(`${label} sandbox destroyed`));
      // Silence the ready promise's rejection if no consumer awaited it
      // (e.g. test teardown) — otherwise Node logs unhandledRejection.
      ready.catch(() => undefined);
      iframe.remove();
    },
  };
}
