/**
 * Cross-platform shell-quoting for the user-command feature. Pure functions,
 * no Electron side effects — unit-tested under `node:test` without an Electron
 * runtime.
 *
 * The Windows branch is the cmd.exe double-quote + `""`-doubling rule that
 * used to live in the (removed) Claude CLI `.cmd`-shim helper, plus the POSIX
 * single-quote equivalent. The path the user right-clicks is the UNTRUSTED
 * input here (the command template itself is user-authored and trusted), so
 * it must be quoted before it lands in a shell string — see
 * `docs/13-security.md`.
 */

const WINDOWS_CMD_ARGUMENT_CHARS = /[\s"&<>|{}^=;!'+,`~()%@]/u;

function requiresWindowsShellQuoting(value: string): boolean {
  return (
    WINDOWS_CMD_ARGUMENT_CHARS.test(value) ||
    value.includes('[') ||
    value.includes(']')
  );
}

function quoteWindowsShellArgument(value: string): string {
  if (!value.length) return '""';
  if (!requiresWindowsShellQuoting(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Quote a single path/value for the platform's shell so it's passed verbatim
 * (spaces, `&`, `|`, `"`, etc. are neutralized).
 *
 * - Windows (cmd.exe): double-quote + double embedded `"`. NOTE: `%` survives
 *   this — `runUserCommand` rejects paths containing `%` on Windows before
 *   they reach here.
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
