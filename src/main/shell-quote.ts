/**
 * Cross-platform shell-quoting for the user-command feature. Pure functions,
 * no Electron side effects — unit-tested under `node:test` without an Electron
 * runtime.
 *
 * Reuses the proven Windows cmd.exe quoting (`quoteWindowsShellArgument`) the
 * Claude CLI `.cmd` shim already relies on, and adds the POSIX single-quote
 * equivalent. The path the user right-clicks is the UNTRUSTED input here (the
 * command template itself is user-authored and trusted), so it must be quoted
 * before it lands in a shell string — see `docs/13-security.md`.
 */
import { quoteWindowsShellArgument } from './ai/utils/windowsCmdShim';

/**
 * Quote a single path/value for the platform's shell so it's passed verbatim
 * (spaces, `&`, `|`, `"`, etc. are neutralized).
 *
 * - Windows (cmd.exe): double-quote + double embedded `"` (delegates to the
 *   shim helper). NOTE: `%` survives this — `runUserCommand` rejects paths
 *   containing `%` on Windows before they reach here.
 * - POSIX (macOS/Linux): single-quote + `'\''` close-reopen. Nothing is
 *   special inside `'…'`, so this is fully robust.
 */
export function quotePathForShell(
  value: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    return quoteWindowsShellArgument(value);
  }
  if (!value.length) return "''";
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
