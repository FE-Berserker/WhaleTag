/**
 * The single sanctioned console entry point for informational logging.
 *
 * `no-console` is enabled repo-wide with `allow: ['warn', 'error']`: warnings
 * and errors are diagnostics a user may need to see, while plain `log` /
 * `info` / `debug` are the ones that historically leaked into production and
 * turned into noise. Low-volume lifecycle lines go through this module
 * instead, which keeps one grep-able place for "where do we print at info
 * level" and leaves a real lint failure for future stray `console.log` calls.
 *
 * The disable below is deliberate and the only one in the codebase: this file
 * exists precisely to encapsulate the calls the rule would otherwise forbid.
 */
/* eslint-disable no-console -- the single module allowed to print at info level */

/** A lifecycle line (started / stopped / fallback taken), shown by default. */
export function logInfo(
  scope: string,
  message: string,
  ...rest: unknown[]
): void {
  console.info(`[${scope}] ${message}`, ...rest);
}

/** Diagnostic detail that only matters while debugging a specific failure. */
export function logDebug(
  scope: string,
  message: string,
  ...rest: unknown[]
): void {
  console.debug(`[${scope}] ${message}`, ...rest);
}
