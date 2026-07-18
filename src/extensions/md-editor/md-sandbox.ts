/**
 * md-editor — sandboxed mermaid iframe manager (§18.3.3).
 *
 * Mermaid v11 uses `new Function(...)` / `eval(...)` internally. The
 * md-editor's main iframe has a strict CSP (no `unsafe-eval`), so mermaid
 * runs in a SECOND `<iframe sandbox="allow-scripts">` (no allow-same-origin
 * → opaque origin): it CAN run code (needs unsafe-eval) but CANNOT read
 * the parent's DOM / cookies / storage. The parent talks to it via
 * postMessage.
 *
 * The iframe / lifecycle / RPC plumbing lives in `md-sandbox-factory.ts`
 * (`createPostMessageSandbox`); this file holds only the mermaid-specific
 * bits — the `svg` result key, the iframe title, and id minting.
 *
 * Protocol:
 *   parent  → sandbox: { type: 'render', id, source }
 *   sandbox → parent:  { type: 'ready' }
 *                    |  { type: 'rendered', id, svg }
 *                    |  { type: 'error', id, message }
 */
import { createPostMessageSandbox } from './md-sandbox-factory';

export interface SandboxRenderer {
  /** Render mermaid source → SVG string. Rejects with a parse error. */
  render(id: string, source: string): Promise<string>;
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

export function createMermaidSandbox(opts: SandboxOptions): SandboxRenderer {
  const sb = createPostMessageSandbox({
    src: opts.src,
    mount: opts.mount,
    title: 'mermaid-sandbox',
    resultKey: 'svg',
    label: 'mermaid',
  });
  return {
    ready: sb.ready,
    // Mermaid carries no extra payload (no displayMode etc.).
    render: (id, source) => sb.render(id, source),
    destroy: sb.destroy,
  };
}

/**
 * Mint a fresh, unique `id` for a new mermaid block. Opaque to the sandbox —
 * used only to correlate placeholder DOM nodes with their pending RPC. Time
 * prefix for DevTools readability; random suffix prevents same-ms collisions
 * when the user pastes multiple diagrams at once.
 */
export function newMermaidId(): string {
  return `m${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
