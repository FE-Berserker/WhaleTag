/**
 * md-editor — sandboxed KaTeX iframe manager (§18.3.3).
 *
 * KaTeX runs in a dedicated `<iframe sandbox="allow-scripts">` (no
 * allow-same-origin → opaque origin), parallel to mermaid's. Unlike mermaid,
 * KaTeX is pure JS (no `unsafe-eval`), but it still gets its own iframe so
 * its CSP (style policy) is isolated from the main editor.
 *
 * The iframe / lifecycle / RPC plumbing lives in `md-sandbox-factory.ts`
 * (`createPostMessageSandbox`); this file holds only the katex-specific
 * bits — the `html` result key, the `displayMode` extra payload, and id
 * minting.
 *
 * Protocol:
 *   parent  → sandbox: { type: 'render', id, source, displayMode }
 *   sandbox → parent:  { type: 'ready' }
 *                    |  { type: 'rendered', id, html }
 *                    |  { type: 'error', id, message }
 */
import { createPostMessageSandbox } from './md-sandbox-factory';

export interface KatexSandboxRenderer {
  /** Render LaTeX source → HTML. `displayMode: true` = block math. */
  render(id: string, source: string, displayMode: boolean): Promise<string>;
  /** Remove iframe + listener; reject pending RPCs. */
  destroy(): void;
  /** Resolves once the sandbox booted. Renders before that are queued. */
  ready: Promise<void>;
}

interface SandboxOptions {
  /** `<iframe src>` — relative to the extension's dist folder. */
  src: string;
  /** Mount parent (defaults to document.body). Iframe is zero-sized. */
  mount?: HTMLElement;
}

export function createKatexSandbox(opts: SandboxOptions): KatexSandboxRenderer {
  const sb = createPostMessageSandbox({
    src: opts.src,
    mount: opts.mount,
    title: 'katex-sandbox',
    resultKey: 'html',
    label: 'katex',
  });
  return {
    ready: sb.ready,
    // katex folds displayMode into the render payload via `extra`.
    render: (id, source, displayMode) => sb.render(id, source, { displayMode }),
    destroy: sb.destroy,
  };
}

/** Mint a fresh, unique `id` for a new katex block. See `newMermaidId`. */
export function newKatexId(): string {
  return `k${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
