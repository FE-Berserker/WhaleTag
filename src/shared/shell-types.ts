/**
 * User-defined shell commands — run a pre-configured command-line on a
 * right-clicked file/folder with the path substituted into a placeholder.
 *
 * These cross the main/preload/renderer boundary (the settings list lives in
 * redux-persist on the renderer; the renderer sends the template + path to
 * main, which quotes + substitutes + spawns). See `docs/13-security.md` for
 * the security model (opt-in, allowedRoots-gated, path quoting).
 */

/** A user-configured command shown in the right-click "Commands" submenu. */
export interface UserCommand {
  /** Stable id (crypto.randomUUID(), generated when the row is created). */
  id: string;
  /** Label shown in the submenu. */
  label: string;
  /**
   * Command-line template with placeholders, e.g. `python process.py "${path}"`.
   * Supported placeholders (main substitutes each, fully shell-quoted):
   *   - `${path}` — absolute path of the right-clicked file/folder
   *   - `${dir}`  — parent directory
   *   - `${name}` — basename
   * The user writes the placeholder BARE (no surrounding quotes); main adds
   * the correct quotes per platform. Writing extra quotes around `${path}`
   * would double-quote and break the command.
   */
  template: string;
  /** Show this command when right-clicking a file. */
  applyToFiles: boolean;
  /** Show this command when right-clicking a folder. */
  applyToFolders: boolean;
  /** Toggle without deleting (unchecked commands are hidden from the menu). */
  enabled: boolean;
}

/**
 * Sentinel thrown by `runUserCommand` (main) when the path can't be safely
 * substituted on the current platform (e.g. a `%` in a filename on Windows,
 * which cmd.exe would expand as an env var even inside double quotes). The
 * renderer matches this to the `commandPathBlocked` i18n key rather than
 * showing the raw English message.
 */
export const COMMAND_PATH_BLOCKED = 'COMMAND_PATH_BLOCKED';

/** IPC result of `shell:runCommand`. */
export type RunCommandResult = { ok: true };
