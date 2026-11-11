/**
 * Small error helpers shared by the renderer's failure-reporting paths.
 *
 * The audit finding behind this module: several UI actions ended in
 * `.catch(() => undefined)` (or a bare `void promise`), so a failed write
 * looked exactly like a successful one. Call sites now route the caught value
 * through `errorMessage` and show it — never swallow it silently.
 */

/** Turn a caught value (Electron IPC rejects with `Error`) into display text. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}
