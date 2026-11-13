/**
 * Run a user-configured shell command on a right-clicked file/folder.
 *
 * The renderer sends the raw template + the selected path; THIS module is the
 * single place that quotes the path and lands it in a shell string (the
 * renderer never builds a shell string). The command runs in a NEW terminal
 * window (cmd/Terminal/xterm) so the user sees stdout/stderr and can interact;
 * the window is fire-and-forget — WhaleTag doesn't track it.
 *
 * Security: the template must be one the user configured (the renderer pushes
 * the Settings → Commands list; main executes nothing else — an injected
 * renderer cannot use this channel as arbitrary code execution).
 * `assertWithinAllowedRoot` gates the path (mirrors `fs:rename` /
 * `fs:delete`); the path is shell-quoted via `shell-quote.ts`; Windows rejects
 * paths containing `%` (cmd.exe expands `%VAR%` even inside double quotes and
 * there's no reliable escape at the `cmd /k` level). See `docs/13-security.md`.
 */
import { spawn } from 'child_process';
import path from 'path';
import { assertWithinAllowedRoot } from './allowed-roots';
import { quotePathForShell } from './shell-quote';
import { launchLinuxTerminal } from './desktop-linux';
import {
  COMMAND_NOT_ALLOWED,
  COMMAND_PATH_BLOCKED,
} from '../shared/shell-types';

export interface CommandValues {
  /** Absolute path of the right-clicked file/folder. */
  path: string;
  /** Parent directory. */
  dir: string;
  /** Basename. */
  name: string;
}

/** Defensive upper bound on a single configured template. */
const MAX_TEMPLATE_LENGTH = 2000;

/**
 * Templates the user configured in Settings → Commands. The renderer pushes
 * this list (on boot and on every change); `runUserCommand` executes ONLY
 * templates found here. Without this, the IPC channel `shell:runCommand` would
 * be a general-purpose shell exec for anything running in the renderer.
 */
let allowedTemplates: ReadonlySet<string> = new Set();

/** Replace the allow-list of command templates (called from `shell:setCommandTemplates`). */
export function setUserCommandTemplates(templates: unknown): void {
  if (!Array.isArray(templates)) {
    throw new Error('Invalid command template payload');
  }
  const next = new Set<string>();
  for (const entry of templates) {
    if (typeof entry !== 'string') continue;
    if (!entry || entry.length > MAX_TEMPLATE_LENGTH) continue;
    next.add(entry);
  }
  allowedTemplates = next;
}

/** Test hook: forget the pushed list (process-global, so tests must clean up). */
export function resetUserCommandTemplatesForTests(): void {
  allowedTemplates = new Set();
}

/**
 * Substitute `${path}` / `${dir}` / `${name}` into the template, each value
 * fully shell-quoted for the platform. Pure; exported for unit tests. Uses a
 * replacer FUNCTION so a `$` inside a path isn't mis-read as a backreference.
 */
/**
 * On Windows, UNC paths (`\\server\share\…`) carry backslashes that some
 * programs parse less robustly than the forward-slash form. The forward-slash
 * UNC (`//server/share/…`) is accepted by the Windows API and virtually all
 * programs, and is the form verified to actually work in the spawned cmd
 * window — backslash UNC has been observed to fail in real command templates.
 * Local drive paths (`C:\…`) keep their backslashes. No-op on POSIX.
 *
 * Applied to `${path}` / `${dir}` only — `${name}` is a basename (no `\\`).
 */
function toShellFriendlyPath(
  value: string,
  platform: NodeJS.Platform
): string {
  if (platform === 'win32' && value.startsWith('\\\\')) {
    return value.replace(/\\/g, '/');
  }
  return value;
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
    path: quotePathForShell(toShellFriendlyPath(values.path, platform), platform),
    dir: quotePathForShell(toShellFriendlyPath(values.dir, platform), platform),
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
 *  - `Error(COMMAND_NOT_ALLOWED)` if the template is not one the user
 *    configured (fail-closed; the renderer pushes the list);
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
  if (typeof template !== 'string' || !allowedTemplates.has(template)) {
    throw new Error(COMMAND_NOT_ALLOWED);
  }
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
  await openTerminalWindow(finalCommand);
  return { ok: true };
}

/**
 * Escape a command for an AppleScript double-quoted string literal.
 *
 * Backslashes are doubled FIRST: AppleScript treats `\` as an escape
 * introducer, so a literal `\` sitting immediately before a quote would
 * otherwise consume the escaping we just added and break the script (or
 * truncate the command). Quoting order matters — never reverse these.
 */
export function escapeAppleScriptString(command: string): string {
  return command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Open a new terminal window running `command` (the substituted + quoted
 * command line).
 *
 * Platform notes:
 *  - Windows: `cmd /d /s /k "<command>"` opens a persistent cmd window. `/s`
 *    + the outer `"..."` (with `windowsVerbatimArguments`) is the robust cmd
 *    quoting pattern for `cmd /s` — it strips the outer
 *    quotes and runs the inner command verbatim. `/k` keeps the window open.
 *  - macOS: AppleScript tells Terminal.app to run the command (the only
 *    reliable way to open a visible Terminal window with a command).
 *  - Linux: walks the desktop-environment fallback chain in
 *    `desktop-linux.ts` ($TERMINAL → x-terminal-emulator → GNOME/KDE/XFCE/
 *    Others → xterm) and keeps the window open after the command
 *    (`; exec bash`). Throws when no terminal could be spawned, so the
 *    renderer can show a real error instead of the menu item silently doing
 *    nothing (docs/16 C-2).
 */
async function openTerminalWindow(command: string): Promise<void> {
  if (process.platform === 'linux') {
    await launchLinuxTerminal(`${command}; exec bash`);
    return;
  }
  let child;
  if (process.platform === 'win32') {
    child = spawn('cmd.exe', ['/d', '/s', '/k', `"${command}"`], {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
      windowsHide: false,
    });
  } else {
    const script = `tell application "Terminal" to do script "${escapeAppleScriptString(
      command
    )}"`;
    child = spawn('osascript', ['-e', script], {
      detached: true,
      stdio: 'ignore',
    });
  }
  // Surface spawn failures to the renderer instead of claiming success: the
  // caller used to return { ok: true } after `console.warn`, so a missing
  // terminal binary looked like the command had been launched.
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => resolve());
  });
  child.unref();
}
