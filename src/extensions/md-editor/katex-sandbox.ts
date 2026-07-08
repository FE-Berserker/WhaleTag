/**
 * md-editor — sandboxed KaTeX iframe manager (§18.3.3).
 *
 * Architecture mirrors `md-sandbox.ts` exactly:
 *   - A dedicated `<iframe sandbox="allow-scripts">` (no
 *     `allow-same-origin`) loads `katex-sandbox.html`, which has
 *     its own CSP allowing `'unsafe-inline'` for style (KaTeX injects
 *     class-based CSS that the main iframe needs to style). KaTeX does
 *     NOT need `unsafe-eval` (it's pure JS, no code generation).
 *   - The parent sends `{type: 'render', id, source, displayMode}`
 *     via `postMessage`; the sandbox runs `katex.renderToString` and
 *     posts back `{type: 'rendered', id, html}` (or `{type: 'error', id, message}`).
 *   - The sandbox is lazy-created on the first `render()` call (singleton
 *     per md-editor iframe lifetime). Re-using the sandbox keeps KaTeX's
 *     `~270KB` script cost amortized across all math blocks in the doc.
 *
 * Why a separate sandbox file (and not extending `md-sandbox.ts`):
 *   - KaTeX's CSP requirements differ from mermaid's (no `unsafe-eval`,
 *     but different `style-src` policy).
 *   - Keeping the two sandbox files isolated means the mermaid fix
 *     history (race conditions, IIFE patches) doesn't need to be
 *     re-validated against the KaTeX code path every time.
 *   - The duplication is ~80 lines — small enough to maintain.
 *
 * The communication protocol is identical to mermaid's:
 *   parent → sandbox: `{type: 'render', id, source, displayMode}`
 *   sandbox → parent: `{type: 'rendered', id, html}` | `{type: 'error', id, message}`
 *   sandbox → parent: `{type: 'ready'}` once after load
 */

export interface KatexSandboxRenderer {
  /**
   * Render a LaTeX source string to HTML via KaTeX. Returns the
   * rendered HTML on success, or rejects with a parse error message.
   *
   * `displayMode: true` produces centered block math; `false` produces
   * inline math (the two have different CSS / spacing rules in KaTeX).
   */
  render(id: string, source: string, displayMode: boolean): Promise<string>;
  /** Tear down: remove iframe + unregister message listener. */
  destroy(): void;
  /** Test / debug hook: in-flight or resolved render promise. */
  ready: Promise<void>;
}

interface SandboxOptions {
  /**
   * `<iframe>` `src` URL — relative to the iframe's base URL
   * (`whale-extension://md-editor/`). The katex-sandbox.html +
   * katex.min.js pair are copied to dist by the build script.
   */
  src: string;
  /**
   * Parent element to mount the iframe into. Defaults to
   * `document.body`. The iframe is `position: absolute` with
   * `width: 0` + `height: 0` so it never affects layout.
   */
  mount?: HTMLElement;
}

const SANDBOX_IFRAME_STYLE =
  'position:absolute;width:0;height:0;border:0;visibility:hidden;';

interface PendingRpc {
  resolve(html: string): void;
  reject(err: Error): void;
}

export function createKatexSandbox(opts: SandboxOptions): KatexSandboxRenderer {
  const mount = opts.mount ?? document.body;

  const pending = new Map<string, PendingRpc>();
  let idCounter = 0;
  let readyResolve: () => void = () => undefined;
  let readyReject: (err: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('title', 'katex-sandbox');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = SANDBOX_IFRAME_STYLE;
  iframe.src = opts.src;

  const messageHandler = (e: MessageEvent): void => {
    const data = (e.data ?? {}) as {
      type?: string;
      id?: string;
      html?: string;
      message?: string;
    };
    const isFromOurSandbox = e.source === iframe.contentWindow;
    const isOursByShape =
      data.type === 'ready' ||
      (data.type === 'rendered' && typeof data.html === 'string') ||
      (data.type === 'error' && typeof data.message === 'string');
    if (!isFromOurSandbox && !isOursByShape) return;

    if (data.type === 'ready') {
      readyResolve();
      return;
    }
    if (!data.id) return;
    const rpc = pending.get(data.id);
    if (!rpc) return;
    pending.delete(data.id);
    if (data.type === 'rendered' && typeof data.html === 'string') {
      rpc.resolve(data.html);
    } else if (data.type === 'error') {
      rpc.reject(new Error(data.message || 'katex render failed'));
    }
  };
  window.addEventListener('message', messageHandler);

  const onLoad = (): void => {
    if (iframe.contentWindow === null) {
      readyReject(new Error('katex sandbox iframe failed to load'));
    }
  };
  iframe.addEventListener('load', onLoad);
  iframe.addEventListener('error', () => {
    readyReject(new Error('katex sandbox iframe load error'));
  });
  mount.appendChild(iframe);

  // 5s auto-timeout — same shape as the mermaid sandbox. Protects
  // against katex.min.js 404, sandbox crash, or any other failure
  // mode that doesn't fire `error`.
  const readyTimeout = setTimeout(() => {
    readyReject(new Error('katex sandbox ready timeout (5s)'));
  }, 5000);

  return {
    ready,
    render(id, source, displayMode) {
      clearTimeout(readyTimeout);
      return new Promise<string>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ready.then(
          () => {
            iframe.contentWindow?.postMessage(
              { type: 'render', id, source, displayMode },
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
        rpc.reject(new Error('katex sandbox destroyed'));
      }
      pending.clear();
      readyReject(new Error('katex sandbox destroyed'));
      ready.catch(() => undefined);
      iframe.remove();
    },
  };
}

/**
 * Convenience: mint a fresh, unique `id` for a new KaTeX block.
 * The id is opaque to the sandbox — used only to correlate
 * placeholder DOM nodes with their pending RPC.
 */
export function newKatexId(): string {
  return `k${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}