import { promises as fsp } from 'fs';
import { ipcMain, shell } from 'electron';
import { exec, execFile } from 'child_process';
import { runUserCommand } from '../shell-command';
import { linuxRevealSteps } from '../desktop-linux';

/**
 * OS-integration `shell:*` handlers: trash, reveal-in-folder, reveal+select,
 * user commands. Split out of the old god-registrar `ipc.ts` (docs/01 §12) —
 * behavior is verbatim.
 */

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
    return new Promise<void>((resolve) => {
      exec(cmd, () => resolve());
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

  // Run a user-configured shell command (Settings → Commands) on a right-
  // clicked file/folder, with the path substituted into ${path}/${dir}/${name}.
  // Opens a NEW terminal window with the command; main quotes the path. See
  // shell-command.ts + docs/13-security.md.
  ipcMain.handle('shell:runCommand', (_event, template: string, targetPath: string) =>
    runUserCommand(template, targetPath)
  );
}
