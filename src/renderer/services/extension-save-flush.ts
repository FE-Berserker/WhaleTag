/**
 * §unsaved-close (window close) — registry for flushing extension editors.
 *
 * Closing a TAB saves the tab it is closing (`ExtensionContextProvider`'s
 * `closeTab`), but closing the WINDOW took a different path: main sends
 * `app:request-flush`, `configureStore` awaited only `persistor.flush()`,
 * and the window was destroyed. Editor buffers live inside the extension
 * iframe — not in redux — so a dirty drawio/markdown/json tab was discarded
 * silently on close.
 *
 * `ExtensionContextProvider` owns the tab list and the per-tab save
 * handlers, so it registers one flush function here; `configureStore` calls
 * it before acking main. Module-level state (not context) because the
 * configureStore callback runs outside the React tree.
 */

export type ExtensionSaveFlush = () => Promise<void>;

let registeredFlush: ExtensionSaveFlush | null = null;

/** Register (or clear, with `null`) the extension-editor flush function. */
export function registerExtensionSaveFlush(
  fn: ExtensionSaveFlush | null
): void {
  registeredFlush = fn;
}

/**
 * Flush dirty extension editors. Never rejects: a failed or slow save must
 * not block the close handshake (main force-closes after its own grace
 * period, and the tab keeps its dirty flag so the next open still warns).
 */
export async function flushExtensionEditors(): Promise<void> {
  const flush = registeredFlush;
  if (!flush) return;
  try {
    await flush();
  } catch (err) {
    console.error('[extensions] flush before window close failed:', err);
  }
}
