import { promises as fsp } from 'fs';
import path from 'path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { exec, execFile } from 'child_process';
import { atomicWriteJson } from '../atomic-write';
import { runUserCommand, setUserCommandTemplates } from '../shell-command';
import { linuxRevealSteps } from '../desktop-linux';
import { COMMAND_NOT_APPROVED } from '../../shared/shell-types';

/**
 * OS-integration `shell:*` handlers: trash, reveal-in-folder, reveal+select,
 * user commands. Split out of the old god-registrar `ipc.ts` (docs/01 §12) —
 * behavior is verbatim.
 */

/**
 * Templates the user has explicitly approved in a native confirmation dialog.
 *
 * The renderer owns the Settings → Commands list and pushes it to main, so
 * "the renderer said this template is configured" is NOT evidence of user
 * intent: an injected renderer can push anything it likes. Execution therefore
 * requires a one-time per-template approval shown by the MAIN process (the
 * renderer cannot draw or dismiss it), persisted under the app's user data.
 */
const approvedTemplates = new Set<string>();
let approvalsLoaded = false;

function approvalsFile(): string {
  return path.join(app.getPath('userData'), 'approved-command-templates.json');
}

async function loadApprovals(): Promise<void> {
  if (approvalsLoaded) return;
  approvalsLoaded = true;
  try {
    const raw = await fsp.readFile(approvalsFile(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry === 'string' && entry) approvedTemplates.add(entry);
      }
    }
  } catch {
    // Missing or corrupt file → no approvals yet. Fail closed (ask again)
    // rather than fail open.
  }
}

async function persistApprovals(): Promise<void> {
  const file = approvalsFile();
  // tmp + rename: a torn write would silently drop approvals and ask again —
  // annoying, but a corrupt approvals file is worse (see AGENTS.md red line).
  // The shared helper uses a pid+counter temp name and serializes writes per
  // target; a bare `<file>.<pid>.tmp` collided when two approvals were granted
  // in the same tick (second rename hit ENOENT and was swallowed).
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await atomicWriteJson(file, [...approvedTemplates].sort());
}

async function approveTemplate(
  template: string,
  win: BrowserWindow | null
): Promise<boolean> {
  if (typeof template !== 'string' || !template) return false;
  await loadApprovals();
  if (approvedTemplates.has(template)) return true;
  const options = {
    type: 'warning' as const,
    buttons: ['Allow', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: 'Allow this command?',
    message: 'Allow WhaleTag to run this command in a terminal window?',
    detail: template,
  };
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  if (response !== 0) return false;
  approvedTemplates.add(template);
  await persistApprovals().catch((error: unknown) => {
    // The session-scoped approval still stands; the next launch asks again.
    console.warn('[shell] failed to persist command approval:', error);
  });
  return true;
}

export function registerShellHandlers(): void {
  // Opens the OS recycle bin / trash so users can see & restore files deleted
  // via shell.trashItem (Whale has no in-app trash — it relies on the OS one).
  ipcMain.handle('shell:openTrash', () => {
    const cmd =
      process.platform === 'win32'
        ? 'explorer.exe shell:RecycleBinFolder'
        : process.platform === 'darwin'
          ? 'open trash://'
          : 'xdg-open trash://';
    return new Promise<void>((resolve, reject) => {
      exec(cmd, (error) => {
        if (error) {
          // `exec` reports "could not launch explorer/open/xdg-open" here; the
          // old callback ignored it and resolved, so the UI claimed success
          // while nothing opened.
          reject(
            new Error(
              `could not open the system trash: ${error instanceof Error ? error.message : String(error)}`
            )
          );
          return;
        }
        resolve();
      });
    });
  });

  // Reveal a file/folder in the OS file manager: open the folder itself, or
  // select the file inside its parent. Read-only — no allowedRoots check.
  ipcMain.handle('shell:revealPath', async (_event, targetPath: string) => {
    const stat = await fsp.stat(targetPath);
    if (stat.isDirectory()) {
      const errMsg = await shell.openPath(targetPath);
      if (errMsg) throw new Error(errMsg);
    } else {
      shell.showItemInFolder(targetPath);
    }
  });

  // H.23 P1-7: open the OS file manager AND highlight the file. Cross-
  // platform implementation:
  //   - Win:  `shell.showItemInFolder(path)` — opens Explorer with the file
  //           highlighted & selected. Replaces the prior
  //           `explorer /select,<path>` execFile approach, which silently
  //           failed on Win10/11 for paths containing spaces / commas /
  //           Unicode (Node's `execFile` quotes them, then `explorer.exe`
  //           mis-parses the comma in the switch).
  //   - macOS: `open -R <path>` reveals in Finder.
  //   - Linux: ordered fallback in desktop-linux.ts — D-Bus
  //           `org.freedesktop.FileManager1.ShowItems` (selects in whichever
  //           manager is running), then `nautilus --select` / `dolphin
  //           --select`, then `xdg-open <parent>` (opens the folder without
  //           selecting). Skipped steps are logged; the error is surfaced
  //           only when every step failed.
  //         The macOS / Linux paths keep `execFile` because the shell API
  //         doesn't expose a "select" primitive on those platforms. Spawn
  //         failures now reject so the renderer can surface the error
  //         instead of silently no-op'ing (the pre-fix `run` helper always
  //         resolved, which is what made this regression invisible).
  //         Read-only — no allowedRoots check (the parent reveal is a UX
  //         gesture, not an IO op).
  ipcMain.handle(
    'shell:revealAndSelect',
    async (_event, targetPath: string) => {
      const platform = process.platform;
      // Run a CLI helper and surface spawn errors back to the renderer.
      // The helper rejects on `error` (ENOENT / EACCES / spawn failures)
      // AND on non-zero exit codes for `open -R` / `nautilus --select`.
      // `xdg-open` is treated as best-effort: it may be missing on
      // stripped Linux distros, so we let the caller decide whether to
      // fall back by catching per-call.
      const run = (
        cmd: string,
        args: string[],
        opts: { tolerateNonZeroExit?: boolean } = {}
      ): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          const child = execFile(
            cmd,
            args,
            { windowsHide: true },
            (err) => {
              if (!err) {
                resolve();
                return;
              }
              if (opts.tolerateNonZeroExit && err.code !== 0) {
                console.warn(
                  `[shell:revealAndSelect] ${cmd} ${args.join(' ')} exited with ${err.code ?? err.message}`
                );
                resolve();
                return;
              }
              reject(
                new Error(
                  `${cmd} ${args.join(' ')} failed: ${err.code ?? err.message}`
                )
              );
            }
          );
          // `child.on('error')` fires when the process could not be
          // spawned at all (ENOENT for the binary, EACCES, etc.). Surface
          // that as a rejection so the caller can decide.
          child.on('error', (err) => {
            reject(
              new Error(
                `[shell:revealAndSelect] spawn ${cmd} failed: ${err.message}`
              )
            );
          });
        });
      if (platform === 'win32') {
        // Electron's official API. Handles path escaping correctly on
        // Win10/11 and selects the file in Explorer. The earlier execFile
        // approach was strictly worse here — see the header comment.
        shell.showItemInFolder(targetPath);
      } else if (platform === 'darwin') {
        await run('open', ['-R', targetPath]);
      } else {
        // Linux: try the fallback chain from desktop-linux.ts — D-Bus
        // FileManager1 ShowItems (works with whichever manager is running),
        // then nautilus/dolphin `--select`, then `xdg-open` the parent folder.
        // A helper that is missing (ENOENT) or exits non-zero is skipped; the
        // error is only surfaced when every step failed, so a missing
        // `xdg-open` no longer hides a working file manager.
        const failures: string[] = [];
        for (const step of linuxRevealSteps(targetPath)) {
          try {
            await run(step.bin, step.args, {
              tolerateNonZeroExit: step.bin === 'xdg-open',
            });
            return;
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            failures.push(message);
            console.warn(`[shell:revealAndSelect] ${message}`);
          }
        }
        throw new Error(
          `Could not reveal ${targetPath} in a file manager: ${failures.join('; ')}`
        );
      }
    }
  );

  // Push the user's configured command templates (Settings → Commands). The
  // renderer sends this on boot and on every settings change; `shell:runCommand`
  // only executes templates present in this list (see shell-command.ts).
  ipcMain.handle('shell:setCommandTemplates', (_event, templates: unknown) => {
    setUserCommandTemplates(templates);
  });

  // Run a user-configured shell command (Settings → Commands) on a right-
  // clicked file/folder, with the path substituted into ${path}/${dir}/${name}.
  // Opens a NEW terminal window with the command; main quotes the path. See
  // shell-command.ts + docs/13-security.md.
  //
  // The template list comes from the renderer, so it is only a filter — the
  // real authorization is the main-process dialog in approveTemplate(). An
  // injected renderer can therefore not silently execute code: the user sees
  // the exact command line before it runs.
  ipcMain.handle(
    'shell:runCommand',
    async (event, template: string, targetPath: string) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!(await approveTemplate(template, win))) {
        throw new Error(COMMAND_NOT_APPROVED);
      }
      return runUserCommand(template, targetPath);
    }
  );
}
