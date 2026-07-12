/**
 * Run a user-configured shell command on a right-clicked file/folder.
 *
 * The renderer sends the raw template + the selected path; THIS module is the
 * single place that quotes the path and lands it in a shell string (the
 * renderer never builds a shell string). The command runs in a NEW terminal
 * window (cmd/Terminal/xterm) so the user sees stdout/stderr and can interact;
 * the window is fire-and-forget — WhaleTag doesn't track it.
 *
 * Security: `assertWithinAllowedRoot` gates the path (mirrors `fs:rename` /
 * `fs:delete`); the path is shell-quoted via `shell-quote.ts`; Windows rejects
 * paths containing `%` (cmd.exe expands `%VAR%` even inside double quotes and
 * there's no reliable escape at the `cmd /k` level). See `docs/13-security.md`.
 */
import { spawn } from 'child_process';
import path from 'path';
import { assertWithinAllowedRoot } from './allowed-roots';
import { quotePathForShell } from './shell-quote';
import { COMMAND_PATH_BLOCKED } from '../shared/shell-types';

export interface CommandValues {
  /** Absolute path of the right-clicked file/folder. */
  path: string;
  /** Parent directory. */
  dir: string;
  /** Basename. */
  name: string;
}

/**
 * Substitute `${path}` / `${dir}` / `${name}` into the template, each value
 * fully shell-quoted for the platform. Pure; exported for unit tests. Uses a
 * replacer FUNCTION so a `$` inside a path isn't mis-read as a backreference.
 */
export function substituteAndQuote(
  template: string,
  values: CommandValues,
  platform: NodeJS.Platform = process.platform
): string {
  const quoted = {
    path: quotePathForShell(values.path, platform),
    dir: quotePathForShell(values.dir, platform),
    name: quotePathForShell(values.name, platform),
  };
  return template
    .replace(/\$\{path\}/g, () => quoted.path)
    .replace(/\$\{dir\}/g, () => quoted.dir)
    .replace(/\$\{name\}/g, () => quoted.name);
}

/**
 * Validate + substitute + open a terminal window running the command.
 *
 * Throws:
 *  - the `assertWithinAllowedRoot` error if the path is outside any configured
 *    location (fail-closed);
 *  - `Error(COMMAND_PATH_BLOCKED)` if the path contains `%` on Windows;
 *  - a plain `Error` if the terminal binary fails to spawn.
 * Resolves `{ ok: true }` once the terminal window has been launched.
 */
export async function runUserCommand(
  template: string,
  targetPath: string
): Promise<{ ok: true }> {
  assertWithinAllowedRoot(targetPath);

  if (process.platform === 'win32' && targetPath.includes('%')) {
    throw new Error(COMMAND_PATH_BLOCKED);
  }

  const values: CommandValues = {
    path: targetPath,
    dir: path.dirname(targetPath),
    name: path.basename(targetPath),
  };
  const finalCommand = substituteAndQuote(template, values);
  openTerminalWindow(finalCommand);
  return { ok: true };
}

/**
 * Open a new terminal window running `command` (the substituted + quoted
 * command line). Fire-and-forget: the child is detached + unref'd so WhaleTag
 * doesn't wait for it, and a spawn failure (missing terminal binary) is
 * swallowed at this layer — the command already launched is best-effort.
 *
 * Platform notes:
 *  - Windows: `cmd /d /s /k "<command>"` opens a persistent cmd window. `/s`
 *    + the outer `"..."` (with `windowsVerbatimArguments`) is the robust cmd
 *    quoting pattern used by the Claude CLI `.cmd` shim — it strips the outer
 *    quotes and runs the inner command verbatim. `/k` keeps the window open.
 *  - macOS: AppleScript tells Terminal.app to run the command (the only
 *    reliable way to open a visible Terminal window with a command).
 *  - Linux: best-effort `xterm`; desktop-environment variance is documented as
 *    a known limitation.
 */
function openTerminalWindow(command: string): void {
  let child;
  if (process.platform === 'win32') {
    child = spawn('cmd.exe', ['/d', '/s', '/k', `"${command}"`], {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
      windowsHide: false,
    });
  } else if (process.platform === 'darwin') {
    const escaped = command.replace(/"/g, '\\"');
    child = spawn(
      'osascript',
      ['-e', `tell application "Terminal" to do script "${escaped}"`],
      { detached: true, stdio: 'ignore' }
    );
  } else {
    child = spawn('xterm', ['-e', 'bash', '-c', `${command}; exec bash`], {
      detached: true,
      stdio: 'ignore',
    });
  }
  child.on('error', () => {
    // Best-effort: a missing terminal binary (e.g. no xterm on a stripped
    // Linux distro) shouldn't crash WhaleTag. Surfacing this nicely is a
    // follow-up; the common case (Windows cmd) always exists.
  });
  child.unref();
}
